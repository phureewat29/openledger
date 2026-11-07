import type { Command } from "commander";
import type Database from "libsql";
import { camelCase, countBy, isPlainObject, pick } from "es-toolkit";
import { runAction, type Invocation, type Output } from "../cli/output.js";
import type { Column } from "../cli/format.js";
import { fail, failReason, tryBatchItem, type FailureCode } from "../cli/errors.js";
import { readStdinBatch, redactionEnabled, requireYes } from "../cli/input.js";
import { openLedger } from "../config/cli.js";
import { inTransaction } from "../db/transaction.js";
import {
  mergeAccounts as mergeAccountRows,
  deleteAccount as deleteAccountRow,
  type AccountFailure,
  type DeleteAccountFailure,
  type MergeAccountsFailure,
} from "./accounts.js";
import { createOneAccount } from "./resolve.js";
import {
  getAccountBalances,
  getBalanceTree,
  getRollupBalance,
  adjustAccountBalance,
  type AccountBalanceMinor,
  type AdjustBalanceFailure,
  type BalanceTreeNode,
} from "./balances.js";
import {
  findAccountById,
  ledgerExists,
  listLedgerCurrencies,
  renameAccount,
  updateAccountMetadata,
  ACCOUNT_TYPES,
  type AccountRow,
  type UpdateAccountMetadataFailure,
  type UpdateAccountMetadataPatch,
} from "./queries.js";
import { findAccountsByFuzzyName, type FuzzyAccountMatch } from "./matching.js";
import { currencyOf, isLedgerScopedId } from "../lib/ids.js";
import { formatFixed, fromMinorUnits, toDecimalTotals } from "../lib/money.js";
import { ISO_DATE_RE, todayIso } from "../lib/date.js";
import { applyRedaction } from "../privacy/redactor.js";
import * as z from "zod";
import { parseInput, safeParse, str, num, int, bool, json } from "../lib/validate.js";
import type { ExitCode } from "../contract/exit.js";
import type {
  Account as PresentedAccount,
  AccountDetail,
  AccountTreeNode as PresentedTreeNode,
  AccountMatch,
  CreateAccountResult,
  CreateAccountBatchCreated,
  CreateAccountBatchDuplicate,
  CreateAccountBatchFailure,
  MergeAccountsResult,
  DeleteAccountResult,
  AdjustAccountResult,
  UpdateAccountResult,
  CreateAccountBatchSummary,
  ListAccountsSummary,
  MatchAccountsSummary,
  TreeAccountsSummary,
} from "../contract/accounts.js";

// Record<Union, FailureCode> fails the build if a reason case is unhandled.
export const ACCOUNT_FAILURE_EXIT: Record<AccountFailure, FailureCode> = {
  account_exists: "INVALID",
  parent_not_found: "NOT_FOUND",
  invalid_hierarchy: "INVALID",
};

// Ledgers are enumerated from the accounts table, never from config, so a bad prefix can't
// resolve against config state; the caller's own hint applies only once the id names a real ledger.
export function failAccountNotFound(db: Database.Database, id: string, hint?: string): never {
  if (isLedgerScopedId(id) && ledgerExists(db, currencyOf(id))) {
    fail("NOT_FOUND", `account "${id}" not found`, { hint });
  }
  const ledgers = listLedgerCurrencies(db);
  fail("NOT_FOUND", `account "${id}" not found`, {
    hint: ledgers.length
      ? `account ids start with a currency — existing ledgers: ${ledgers.join(", ")}`
      : "account ids start with a currency (e.g. thb:expense:food); no ledger exists yet, run `oled config --init`",
  });
}

export function requireAccount(db: Database.Database, id: string, hint?: string): AccountRow {
  const account = findAccountById(db, id);
  if (!account) failAccountNotFound(db, id, hint);
  return account;
}

// Only `name` is free text; id/parent_id/type/currency and balances are structured, left verbatim.
const ACCOUNT_REDACT_FIELDS = ["name"] as const;

function presentAccount(a: AccountBalanceMinor): PresentedAccount {
  const { balance_minor: _bm, debits_posted, credits_posted, ...rest } = a;
  return {
    ...rest,
    debits_posted: fromMinorUnits(debits_posted, a.currency),
    credits_posted: fromMinorUnits(credits_posted, a.currency),
  };
}

const ACCOUNT_COLUMNS: Column<PresentedAccount>[] = [
  { header: "ID", value: (a) => a.id },
  { header: "Name", value: (a) => a.name },
  { header: "Type", value: (a) => a.type },
  { header: "Parent", value: (a) => a.parent_id ?? "" },
  { header: "Balance", value: (a) => formatFixed(a.balance, a.currency), align: "right" },
  { header: "Debits", value: (a) => formatFixed(a.debits_posted, a.currency), align: "right" },
  { header: "Credits", value: (a) => formatFixed(a.credits_posted, a.currency), align: "right" },
  { header: "Currency", value: (a) => a.currency },
];

const MATCH_COLUMNS: Column<FuzzyAccountMatch>[] = [
  { header: "ID", value: (m) => m.account.id },
  { header: "Name", value: (m) => m.account.name },
  { header: "Type", value: (m) => m.account.type },
  { header: "Similarity", value: (m) => m.similarity.toFixed(3), align: "right" },
];

function presentTreeNode(node: BalanceTreeNode): PresentedTreeNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    currency: node.currency,
    balance: fromMinorUnits(node.balance_minor, node.currency),
    rollup: toDecimalTotals(node.rollup),
    children: node.children.map(presentTreeNode),
  };
}

/** One `<code> amount` pair per currency, in the key order `toDecimalTotals` fixed. */
function formatTotals(totals: Record<string, number>): string {
  return Object.entries(totals)
    .map(([currency, amount]) => `${currency} ${formatFixed(amount, currency)}`)
    .join(" ");
}

interface TreeLine {
  node: PresentedTreeNode;
  depth: number;
}

/** Pre-order: every node precedes its children. */
function walkTree(nodes: PresentedTreeNode[], depth = 0): TreeLine[] {
  return nodes.flatMap((node) => [{ node, depth }, ...walkTree(node.children, depth + 1)]);
}

function ttyTreeLine({ node: n, depth }: TreeLine): string {
  return `${"  ".repeat(depth)}${n.name} (${n.id})  ${formatFixed(n.balance, n.currency)} [rollup ${formatTotals(n.rollup)}]`;
}

function plainTreeLine({ node: n, depth }: TreeLine): string {
  return [
    String(depth),
    n.id,
    n.name,
    n.type,
    n.currency,
    formatFixed(n.balance, n.currency),
    formatTotals(n.rollup),
  ].join("\t");
}

function renderTree(roots: PresentedTreeNode[], format: (line: TreeLine) => string): string {
  return walkTree(roots)
    .map((line) => `${format(line)}\n`)
    .join("");
}

const ACCOUNT_FILTER_SPEC = z.object({
  type: z.enum(ACCOUNT_TYPES).optional(),
});

/** `tree` takes the same flags. */
interface ListAccountsOpts {
  type?: string;
  redact?: boolean;
}

async function listAccounts(ctx: Invocation, opts: ListAccountsOpts): Promise<void> {
  const { config, db } = await openLedger(ctx.configPath);
  const filter = parseInput(ACCOUNT_FILTER_SPEC, opts);
  const rows = applyRedaction(
    getAccountBalances(db, filter).map(presentAccount),
    redactionEnabled(opts),
    ACCOUNT_REDACT_FIELDS,
    config,
  );
  ctx.out.emitList(rows, ACCOUNT_COLUMNS);
  const summary: Omit<ListAccountsSummary, "type"> = { total: rows.length, returned: rows.length };
  ctx.out.emitSummary(summary);
}

async function showAccountTree(ctx: Invocation, opts: ListAccountsOpts): Promise<void> {
  const { config, db } = await openLedger(ctx.configPath);
  const filter = parseInput(ACCOUNT_FILTER_SPEC, opts);
  const roots = applyRedaction(
    getBalanceTree(db, filter).map(presentTreeNode),
    redactionEnabled(opts),
    ACCOUNT_REDACT_FIELDS,
    config,
  );
  ctx.out.render({
    json: () => {
      // One object per root so every stdout line stays a single JSON object.
      for (const root of roots) ctx.out.emit(root);
      const summary: Omit<TreeAccountsSummary, "type"> = { roots: roots.length };
      ctx.out.emitSummary(summary);
    },
    tty: () => ctx.out.write(renderTree(roots, ttyTreeLine)),
    plain: () => ctx.out.write(renderTree(roots, plainTreeLine)),
  });
}

interface ShowAccountOpts {
  redact?: boolean;
}

async function showAccount(ctx: Invocation, id: string, opts: ShowAccountOpts): Promise<void> {
  const { config, db } = await openLedger(ctx.configPath);
  const balances = getAccountBalances(db, { idOrParent: id });
  const self = balances.find((b) => b.id === id);
  if (!self) failAccountNotFound(db, id);
  const detail: AccountDetail = {
    ...presentAccount(self),
    rollup: toDecimalTotals(getRollupBalance(db, id)),
    children: balances
      .filter((b) => b.parent_id === id)
      .map((b) => ({ id: b.id, name: b.name, type: b.type, balance: b.balance })),
  };
  ctx.out.emitObject(applyRedaction(detail, redactionEnabled(opts), ACCOUNT_REDACT_FIELDS, config));
}

// A record, not any JSON: a scalar or array stored here would refuse every later metadata patch.
const METADATA_INPUT = json(z.record(z.string(), z.unknown()), "a JSON object").optional();

const CREATE_ACCOUNT_SPEC = z.object({
  id: str(),
  name: str(),
  type: z.enum(ACCOUNT_TYPES),
  parent_id: str().optional(),
  subtype: str().optional(),
  bank_name: str().optional(),
  account_number_masked: str().optional(),
  due_day: int().optional(),
  statement_day: int().optional(),
  metadata: METADATA_INPUT,
});

const CREATE_ACCOUNT_ALIASES = {
  parent_id: ["parent"],
  bank_name: ["bank"],
  account_number_masked: ["masked"],
};

async function createSingleAccount(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(CREATE_ACCOUNT_SPEC, opts, { aliases: CREATE_ACCOUNT_ALIASES });
  const { db } = await openLedger(ctx.configPath);
  const outcome = createOneAccount(db, parsed);
  if (!outcome.ok) failReason(ACCOUNT_FAILURE_EXIT, outcome);
  const result: CreateAccountResult = {
    id: outcome.id,
    created: true,
    created_parents: outcome.created_parents,
    ...pick(outcome, ["account_number_masked"]),
  };
  ctx.out.emitObject(result);
}

// Commander keys of the per-account flags, so a defaulted global (`color: true`) never counts as one.
const ACCOUNT_FLAG_KEYS = [
  ...Object.keys(CREATE_ACCOUNT_SPEC.shape).map((key) => camelCase(key)),
  ...Object.values(CREATE_ACCOUNT_ALIASES).flat(),
];

type AccountsCreateBatchRow =
  | CreateAccountBatchCreated
  | CreateAccountBatchDuplicate
  | CreateAccountBatchFailure;

function createBatchRow(db: Database.Database, item: unknown, index: number): AccountsCreateBatchRow {
  const failed = (message: string): CreateAccountBatchFailure => ({
    type: "result",
    index,
    ok: false,
    message,
  });
  if (!isPlainObject(item)) return failed("each account must be a JSON object.");

  const parsed = safeParse(CREATE_ACCOUNT_SPEC, item, { aliases: CREATE_ACCOUNT_ALIASES });
  if (!parsed.ok) return failed(parsed.error);

  const attempt = tryBatchItem(() => createOneAccount(db, parsed.value));
  if (!attempt.ok) return failed(attempt.error);

  const one = attempt.value;
  if (one.ok) {
    return {
      type: "result",
      index,
      ok: true,
      id: one.id,
      created: true,
      created_parents: one.created_parents,
      ...pick(one, ["account_number_masked"]),
    };
  }
  if (one.reason === "account_exists") {
    return { type: "result", index, ok: true, id: parsed.value.id, duplicate: true };
  }
  return failed(one.message);
}

type BatchTally = keyof Omit<CreateAccountBatchSummary, "type">;

function tallyOf(row: AccountsCreateBatchRow): BatchTally {
  if (!row.ok) return "failed";
  return "duplicate" in row ? "duplicates" : "created";
}

/**
 * One result row per item plus a summary row; exits PARTIAL on any failure.
 * `account_exists` counts as success (`duplicate: true`). Rows are written as
 * they land, so a ledger failure that aborts the batch leaves the landed ones reported.
 */
export function createAccountsBatch(
  out: Output,
  db: Database.Database,
  items: unknown[],
): ExitCode | undefined {
  const rows = items.map((item, index) => {
    const row = createBatchRow(db, item, index);
    out.emitObject(row);
    return row;
  });

  // Partial: countBy omits a tally no row hit.
  const tally: Partial<Record<BatchTally, number>> = countBy(rows, tallyOf);
  const summary: Omit<CreateAccountBatchSummary, "type"> = { created: 0, duplicates: 0, failed: 0, ...tally };
  if (out.mode.json) out.emitSummary(summary);
  else out.write(`\n${summary.created} created, ${summary.duplicates} duplicate(s), ${summary.failed} failed\n`);

  return summary.failed > 0 ? "PARTIAL" : undefined;
}

interface CreateAccountOpts extends Record<string, unknown> {
  input?: string;
}

async function createAccount(ctx: Invocation, opts: CreateAccountOpts): Promise<ExitCode | void> {
  if (!opts.input) return createSingleAccount(ctx, opts);
  if (ACCOUNT_FLAG_KEYS.some((k) => opts[k] !== undefined)) {
    fail("USAGE", "--input and per-account flags are mutually exclusive");
  }
  const items = await readStdinBatch(opts.input);
  if (items.length === 0) fail("USAGE", "no account data provided");
  const { db } = await openLedger(ctx.configPath);
  return createAccountsBatch(ctx.out, db, items);
}

const MERGE_ACCOUNTS_SPEC = z.object({
  from: str(),
  to: str(),
  yes: bool().optional(),
});

export const MERGE_ACCOUNTS_EXIT: Record<MergeAccountsFailure, FailureCode> = {
  same_account: "INVALID",
  not_found: "NOT_FOUND",
  cross_ledger: "INVALID",
  has_children: "INVALID",
};

export const DELETE_ACCOUNT_EXIT: Record<DeleteAccountFailure, FailureCode> = {
  has_transactions: "INVALID",
  has_children: "INVALID",
};

async function mergeAccounts(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(MERGE_ACCOUNTS_SPEC, opts);
  requireYes(parsed, "merging accounts");
  const { db } = await openLedger(ctx.configPath);
  const merged = mergeAccountRows(db, parsed.from, parsed.to);
  if (!merged.ok) failReason(MERGE_ACCOUNTS_EXIT, merged);
  const result: MergeAccountsResult = {
    from: parsed.from,
    to: parsed.to,
    moved: merged.moved,
    deleted_self_transactions: merged.deletedSelfTransactions,
    moved_merchant_defaults: merged.movedMerchantDefaults,
  };
  ctx.out.emitObject(result);
}

interface DeleteAccountOpts {
  yes?: boolean;
}

async function deleteAccount(ctx: Invocation, id: string, opts: DeleteAccountOpts): Promise<void> {
  const { db } = await openLedger(ctx.configPath);
  requireAccount(db, id);
  requireYes(opts, "deleting this account");
  const deleted = deleteAccountRow(db, id);
  if (!deleted.ok) failReason(DELETE_ACCOUNT_EXIT, deleted);
  const result: DeleteAccountResult = { id, deleted: true };
  ctx.out.emitObject(result);
}

const ADJUST_ACCOUNT_SPEC = z.object({
  to: num(),
  reason: str(),
  date: str().optional(),
});

export const ADJUST_ACCOUNT_EXIT: Record<AdjustBalanceFailure, FailureCode> = {
  not_found: "NOT_FOUND",
  balancing_account: "INVALID",
  invalid_transaction: "INVALID",
};

async function adjustAccount(
  ctx: Invocation,
  id: string,
  opts: Record<string, unknown>,
): Promise<void> {
  const parsed = parseInput(ADJUST_ACCOUNT_SPEC, opts);
  if (parsed.date !== undefined && !ISO_DATE_RE.test(parsed.date)) {
    fail("USAGE", `--date must be an ISO date (YYYY-MM-DD), got "${parsed.date}"`);
  }

  const { db } = await openLedger(ctx.configPath);
  const outcome = adjustAccountBalance(db, {
    accountId: id,
    targetAmount: parsed.to,
    reason: parsed.reason,
    date: parsed.date ?? todayIso(),
  });
  if (!outcome.ok) failReason(ADJUST_ACCOUNT_EXIT, outcome);
  const result: AdjustAccountResult = { transaction_id: outcome.transactionId, delta: outcome.delta };
  ctx.out.emitObject(result);
}

const MATCH_ACCOUNTS_SPEC = z.object({
  query: str(),
});

async function matchAccounts(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(MATCH_ACCOUNTS_SPEC, opts);
  const { db } = await openLedger(ctx.configPath);
  const matches: AccountMatch[] = findAccountsByFuzzyName(db, parsed.query);
  ctx.out.emitList(matches, MATCH_COLUMNS);
  const summary: Omit<MatchAccountsSummary, "type"> = { returned: matches.length };
  ctx.out.emitSummary(summary);
}

const UPDATE_ACCOUNT_SPEC = z.object({
  name: str().optional(),
  due_day: int().optional().nullable(),
  statement_day: int().optional().nullable(),
  points_balance: int().optional().nullable(),
  account_number_masked: str().optional().nullable(),
  bank_name: str().optional().nullable(),
  metadata: METADATA_INPUT,
});

const UPDATE_ACCOUNT_ALIASES = {
  points_balance: ["points"],
  account_number_masked: ["masked"],
  bank_name: ["bank"],
};

export const UPDATE_ACCOUNT_EXIT: Record<UpdateAccountMetadataFailure, FailureCode> = {
  not_found: "NOT_FOUND",
  unreadable_metadata: "INVALID",
};

// Reward points aren't a ledger unit, so they ride in the metadata blob rather than a stored column.
function buildAccountPatch({
  points_balance,
  metadata,
  ...rest
}: Omit<z.infer<typeof UPDATE_ACCOUNT_SPEC>, "name">): UpdateAccountMetadataPatch {
  const merged = points_balance === undefined ? metadata : { ...metadata, points_balance };
  return merged === undefined ? rest : { ...rest, metadata: merged };
}

async function updateAccount(
  ctx: Invocation,
  id: string,
  opts: Record<string, unknown>,
): Promise<void> {
  const parsed = parseInput(UPDATE_ACCOUNT_SPEC, opts, {
    aliases: UPDATE_ACCOUNT_ALIASES,
    atLeastOne:
      "at least one of --name, --due-day, --statement-day, --points, --masked, --bank, --metadata is required",
  });
  const { name, ...rest } = parsed;
  const patch = buildAccountPatch(rest);

  const { db } = await openLedger(ctx.configPath);

  // One transaction: a metadata patch that fails must not leave the rename committed.
  const result = inTransaction(db, (): UpdateAccountResult => {
    const out: UpdateAccountResult = { id };

    if (name !== undefined) {
      if (renameAccount(db, id, name) === 0) failAccountNotFound(db, id);
      out.name = name;
      out.renamed = true;
    }

    if (Object.keys(patch).length > 0) {
      const patched = updateAccountMetadata(db, id, patch);
      if (!patched.ok) failReason(UPDATE_ACCOUNT_EXIT, patched);
      out.before = patched.before;
      out.after = patched.after;
    }

    return out;
  });

  ctx.out.emitObject(result);
}

export function registerAccounts(program: Command): void {
  const accounts = program
    .command("accounts")
    .description("Manage the chart of accounts")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: manages the chart of accounts. Ids are <currency>:<type>:<path>; the currency comes first and every id needs it: thb:asset:bank:kbank, usd:expense:food. Types are asset, liability, income, expense, equity; thb:asset is a ledger's type root.",
        "Typical flow: match to reuse an existing account before create; read balances with tree or show.",
        "One ledger per currency: an account's currency is its id prefix, and a transaction's two accounts must share it. A USD balance lives under usd:, never under thb:.",
        "Example: oled accounts match --query groceries --json",
      ].join("\n"),
    );

  accounts
    .command("list")
    .description("List accounts")
    .option("--type <type>", "filter by account type")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(listAccounts));

  accounts
    .command("tree")
    .description("Show accounts as a tree")
    .option("--type <type>", "filter by account type")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(showAccountTree));

  accounts
    .command("show <id>")
    .description("Show an account's details")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(showAccount));

  accounts
    .command("create")
    .description("Create a new account (single via flags, or batch via --input)")
    .option("--id <id>", "account id, currency-prefixed (e.g. thb:asset:bank:kbank)")
    .option("--name <name>", "account name")
    .option("--type <type>", "account type")
    .option("--parent <id>", "parent account id")
    .option("--subtype <s>", "account subtype")
    .option("--bank <name>", "bank name")
    .option("--masked <number>", "masked account number")
    .option("--due-day <n>", "payment due day")
    .option("--statement-day <n>", "statement closing day")
    .option("--metadata <json>", "additional metadata as JSON")
    .option("--input <path>", "batch-create accounts from an NDJSON/JSON file instead of individual flags")
    .action(runAction(createAccount));

  accounts
    .command("merge")
    .description("Merge one account into another")
    .option("--from <id>", "account id to merge from")
    .option("--to <id>", "account id to merge into")
    .option("--yes", "skip confirmation")
    .action(runAction(mergeAccounts));

  accounts
    .command("delete <id>")
    .description("Delete an account")
    .option("--yes", "skip confirmation")
    .action(runAction(deleteAccount));

  accounts
    .command("adjust <id>")
    .description("Adjust an account balance")
    .option("--to <amount>", "target balance amount")
    .option("--reason <text>", "reason for the adjustment")
    .option("--date <date>", "adjustment date")
    .action(runAction(adjustAccount));

  accounts
    .command("match")
    .description("Match accounts against a query")
    .option("--query <text>", "search text")
    .action(runAction(matchAccounts));

  accounts
    .command("update <id>")
    .description("Update an account's name and/or metadata")
    .option("--name <name>", "new account name")
    .option("--due-day <n>", "payment due day")
    .option("--statement-day <n>", "statement closing day")
    .option("--points <n>", "reward points balance")
    .option("--masked <number>", "masked account number")
    .option("--bank <name>", "bank name")
    .option("--metadata <json>", "additional metadata as JSON")
    .action(runAction(updateAccount));
}
