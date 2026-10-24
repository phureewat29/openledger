import type { Command } from "commander";
import type Database from "libsql";
import { camelCase } from "es-toolkit";
import { runAction, type Invocation, type Output } from "../cli/output.js";
import type { Column } from "../cli/format.js";
import { fail, failReason, mapNotFoundError, type FailureCode } from "../cli/errors.js";
import { asRecord, readStdinBatch, redactionEnabled, requireYes } from "../cli/input.js";
import { openLedger } from "../config/cli.js";
import {
  createAccount as createAccountRow,
  mergeAccounts as mergeAccountRows,
  deleteAccount as deleteAccountRow,
  validateAccountId,
  type AccountFailure,
  type AccountRefusal,
} from "./accounts.js";
import {
  getAccountBalances,
  getBalanceTree,
  getRollupBalance,
  adjustAccountBalance,
  type AccountBalanceMinor,
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
  type AccountType,
  type CreateAccountInput,
  type UpdateAccountMetadataPatch,
} from "./queries.js";
import { findAccountsByFuzzyName, type FuzzyAccountMatch } from "./matching.js";
import { ensureAccountAncestors } from "./resolve.js";
import { isLedgerScopedId } from "../lib/ids.js";
import { formatFixed, fromMinorUnits, toDecimalTotals } from "../lib/money.js";
import { applyRedaction } from "../privacy/redactor.js";
import { tryExecute } from "../lib/result.js";
import * as z from "zod";
import { parseInput, safeParse, str, num, int, json } from "../lib/validate.js";
import type { ExitCode } from "../contract/exit.js";
import type {
  Account as PresentedAccount,
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
  if (isLedgerScopedId(id) && ledgerExists(db, id.slice(0, 3))) {
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

function renderTreeTty(nodes: PresentedTreeNode[], depth = 0): string {
  const indent = "  ".repeat(depth);
  return nodes
    .map((n) => {
      const line = `${indent}${n.name} (${n.id})  ${formatFixed(n.balance, n.currency)} [rollup ${formatTotals(n.rollup)}]\n`;
      return line + renderTreeTty(n.children, depth + 1);
    })
    .join("");
}

function flattenTree(nodes: PresentedTreeNode[], depth: number, out: string[]): void {
  for (const n of nodes) {
    out.push(
      [
        String(depth),
        n.id,
        n.name,
        n.type,
        n.currency,
        formatFixed(n.balance, n.currency),
        formatTotals(n.rollup),
      ].join("\t"),
    );
    flattenTree(n.children, depth + 1, out);
  }
}

function renderTreePlain(nodes: PresentedTreeNode[]): string {
  const out: string[] = [];
  flattenTree(nodes, 0, out);
  return out.length ? out.join("\n") + "\n" : "";
}

// Fails an invalid --type with the same wording zod produces for `accounts create --type`.
function parseAccountTypeFilter(type: string | undefined): AccountType | undefined {
  if (type === undefined) return undefined;
  if (!ACCOUNT_TYPES.includes(type as AccountType)) {
    fail("USAGE", `--type must be one of ${ACCOUNT_TYPES.join(", ")}, got "${type}"`);
  }
  return type as AccountType;
}

interface ListAccountsOpts {
  type?: string;
  redact?: boolean;
}

async function listAccounts(ctx: Invocation, opts: ListAccountsOpts): Promise<void> {
  const { config, db } = await openLedger(ctx.configPath);
  const type = parseAccountTypeFilter(opts.type);
  const rows = applyRedaction(
    getAccountBalances(db, type ? { type } : {}).map(presentAccount),
    redactionEnabled(opts),
    ACCOUNT_REDACT_FIELDS,
    config,
  );
  ctx.out.emitList(rows, ACCOUNT_COLUMNS);
  const summary: Omit<ListAccountsSummary, "type"> = { total: rows.length, returned: rows.length };
  ctx.out.emitSummary(summary);
}

interface ShowAccountTreeOpts {
  type?: string;
  redact?: boolean;
}

async function showAccountTree(ctx: Invocation, opts: ShowAccountTreeOpts): Promise<void> {
  const { config, db } = await openLedger(ctx.configPath);
  const type = parseAccountTypeFilter(opts.type);
  const roots = applyRedaction(
    getBalanceTree(db, type ? { type } : {}).map(presentTreeNode),
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
    tty: () => ctx.out.write(renderTreeTty(roots)),
    plain: () => ctx.out.write(renderTreePlain(roots)),
  });
}

async function showAccount(
  ctx: Invocation,
  id: string,
  opts: { redact?: boolean },
): Promise<void> {
  const { config, db } = await openLedger(ctx.configPath);
  const account = requireAccount(db, id);
  const balances = getAccountBalances(db, { idOrParent: id });
  const self = balances.find((b) => b.id === id);
  const children = balances
    .filter((b) => b.parent_id === id)
    .map((b) => ({ id: b.id, name: b.name, type: b.type, balance: b.balance }));
  ctx.out.emitObject(
    applyRedaction(
      {
        ...account,
        balance: self?.balance ?? 0,
        debits_posted: self ? fromMinorUnits(self.debits_posted, self.currency) : 0,
        credits_posted: self ? fromMinorUnits(self.credits_posted, self.currency) : 0,
        rollup: toDecimalTotals(getRollupBalance(db, id)),
        children,
      },
      redactionEnabled(opts),
      ACCOUNT_REDACT_FIELDS,
      config,
    ),
  );
}

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
  metadata: json<Record<string, unknown>>().optional(),
});

const CREATE_ACCOUNT_ALIASES = {
  parent_id: ["parent"],
  bank_name: ["bank"],
  account_number_masked: ["masked"],
};

interface CreatedAccount {
  readonly ok: true;
  id: string;
  created_parents: string[];
  account_number_masked?: string | null;
}

type CreateOneAccountOutcome = CreatedAccount | AccountRefusal;

// db.transaction rolls back only on throw, so a refusal must throw to undo any
// parent-ledger write that preceded it.
class RefusedCreate extends Error {
  constructor(readonly failure: AccountRefusal) {
    super(failure.message);
  }
}

// Ancestors are auto-created only when --parent was omitted.
export function createOneAccount(
  db: Database.Database,
  parsed: z.infer<typeof CREATE_ACCOUNT_SPEC>,
): CreateOneAccountOutcome {
  const grammar = validateAccountId(parsed.id, parsed.type);
  if (!grammar.ok) return grammar;

  try {
    return db.transaction((): CreateOneAccountOutcome => {
      let parentId = parsed.parent_id ?? null;
      let createdParents: string[] = [];
      if (parsed.parent_id === undefined) {
        const ancestors = ensureAccountAncestors(db, parsed.id, parsed.type);
        if (!ancestors.ok) throw new RefusedCreate(ancestors);
        if (ancestors.parentId !== null) {
          parentId = ancestors.parentId;
          createdParents = ancestors.createdParents;
        }
      }

      const input: CreateAccountInput = {
        id: parsed.id,
        name: parsed.name,
        type: parsed.type,
        parent_id: parentId,
        subtype: parsed.subtype ?? null,
        bank_name: parsed.bank_name ?? null,
        account_number_masked: parsed.account_number_masked ?? null,
        due_day: parsed.due_day ?? null,
        statement_day: parsed.statement_day ?? null,
        metadata: parsed.metadata ?? null,
      };
      const created = createAccountRow(db, input);
      if (!created.ok) throw new RefusedCreate(created);

      const result: CreatedAccount = { ok: true, id: input.id, created_parents: createdParents };
      // Echo the stored (post-normalization) value rather than re-deriving it.
      if (parsed.account_number_masked !== undefined) {
        result.account_number_masked = findAccountById(db, input.id)?.account_number_masked ?? null;
      }
      return result;
    })();
  } catch (err) {
    if (err instanceof RefusedCreate) return err.failure;
    throw err;
  }
}

function maskedResultField(result: CreatedAccount): Record<string, unknown> {
  return result.account_number_masked !== undefined
    ? { account_number_masked: result.account_number_masked }
    : {};
}

async function createSingleAccount(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(CREATE_ACCOUNT_SPEC, opts, { aliases: CREATE_ACCOUNT_ALIASES });
  const { db } = await openLedger(ctx.configPath);
  const outcome = createOneAccount(db, parsed);
  if (!outcome.ok) failReason(ACCOUNT_FAILURE_EXIT, outcome);
  const result: CreateAccountResult = {
    id: outcome.id,
    created: true,
    created_parents: outcome.created_parents,
    ...maskedResultField(outcome),
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

/**
 * One result row per item plus a summary row; exits PARTIAL on any failure.
 * `account_exists` counts as success (`duplicate: true`); a throw from one
 * item becomes that item's failure row instead of aborting the batch.
 */
export function createAccountsBatch(
  out: Output,
  db: Database.Database,
  items: unknown[],
): ExitCode | undefined {
  const results: AccountsCreateBatchRow[] = [];
  let created = 0;
  let duplicates = 0;
  let failed = 0;

  function failedRow(index: number, message: string): CreateAccountBatchFailure {
    failed++;
    return { type: "result", index, ok: false, message };
  }

  for (let index = 0; index < items.length; index++) {
    const record = asRecord(items[index]);
    if (!record) {
      results.push(failedRow(index, "each account must be a JSON object."));
      continue;
    }

    const parsed = safeParse(CREATE_ACCOUNT_SPEC, record, { aliases: CREATE_ACCOUNT_ALIASES });
    if (!parsed.ok) {
      results.push(failedRow(index, parsed.error));
      continue;
    }

    const attempt = tryExecute(() => createOneAccount(db, parsed.value));
    if (!attempt.ok) {
      results.push(failedRow(index, attempt.error));
      continue;
    }
    const one = attempt.value;
    if (one.ok) {
      created++;
      const row: CreateAccountBatchCreated = {
        type: "result",
        index,
        ok: true,
        id: one.id,
        created: true,
        created_parents: one.created_parents,
        ...maskedResultField(one),
      };
      results.push(row);
      continue;
    }
    if (one.reason === "account_exists") {
      duplicates++;
      const row: CreateAccountBatchDuplicate = {
        type: "result",
        index,
        ok: true,
        id: parsed.value.id,
        duplicate: true,
      };
      results.push(row);
      continue;
    }
    results.push(failedRow(index, one.message));
  }

  if (out.mode.json) {
    for (const r of results) out.emit(r);
    const summary: Omit<CreateAccountBatchSummary, "type"> = { created, duplicates, failed };
    out.emitSummary(summary);
  } else {
    for (const r of results) out.emitObject(r);
    out.write(`\n${created} created, ${duplicates} duplicate(s), ${failed} failed\n`);
  }

  return failed > 0 ? "PARTIAL" : undefined;
}

interface CreateAccountOpts extends Record<string, unknown> {
  input?: string;
}

async function createAccount(
  ctx: Invocation,
  opts: CreateAccountOpts,
): Promise<ExitCode | undefined> {
  if (opts.input !== undefined) {
    if (ACCOUNT_FLAG_KEYS.some((k) => opts[k] !== undefined)) {
      fail("USAGE", "--input and per-account flags are mutually exclusive");
    }
    const items = await readStdinBatch(opts.input);
    if (items.length === 0) fail("USAGE", "no account data provided");
    const { db } = await openLedger(ctx.configPath);
    return createAccountsBatch(ctx.out, db, items);
  }
  await createSingleAccount(ctx, opts);
}

const MERGE_ACCOUNTS_SPEC = z.object({
  from: str(),
  to: str(),
});

interface MergeAccountsOpts {
  from?: string;
  to?: string;
  yes?: boolean;
}

async function mergeAccounts(ctx: Invocation, opts: MergeAccountsOpts): Promise<void> {
  const parsed = parseInput(MERGE_ACCOUNTS_SPEC, opts as Record<string, unknown>);
  requireYes(opts, "merging accounts");
  const { db } = await openLedger(ctx.configPath);
  let merged;
  try {
    merged = mergeAccountRows(db, parsed.from, parsed.to);
  } catch (err) {
    // A cross-ledger merge's message matches neither not-found pattern, so it maps to INVALID.
    mapNotFoundError(err);
  }
  const result: MergeAccountsResult = {
    from: parsed.from,
    to: parsed.to,
    moved: merged.moved,
    deleted_self_transactions: merged.deletedSelfTransactions,
    moved_merchant_defaults: merged.movedMerchantDefaults,
  };
  ctx.out.emitObject(result);
}

async function deleteAccount(ctx: Invocation, id: string, opts: { yes?: boolean }): Promise<void> {
  const { db } = await openLedger(ctx.configPath);
  requireAccount(db, id);
  requireYes(opts, "deleting this account");
  try {
    deleteAccountRow(db, id);
  } catch (err) {
    mapNotFoundError(err);
  }
  const result: DeleteAccountResult = { id, deleted: true };
  ctx.out.emitObject(result);
}

const ADJUST_ACCOUNT_SPEC = z.object({
  to: num(),
  reason: str(),
  date: str().optional(),
});

async function adjustAccount(
  ctx: Invocation,
  id: string,
  opts: Record<string, unknown>,
): Promise<void> {
  const parsed = parseInput(ADJUST_ACCOUNT_SPEC, opts);

  const { db } = await openLedger(ctx.configPath);
  let outcome;
  try {
    outcome = adjustAccountBalance(db, {
      accountId: id,
      targetAmount: parsed.to,
      reason: parsed.reason,
      date: parsed.date,
    });
  } catch (err) {
    mapNotFoundError(err);
  }
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
  metadata: json<Record<string, unknown>>().optional(),
});

const UPDATE_ACCOUNT_ALIASES = {
  points_balance: ["points"],
  account_number_masked: ["masked"],
  bank_name: ["bank"],
};

// Reward points aren't a ledger unit, so they ride in the metadata blob rather than a stored column.
function buildAccountPatch(
  parsed: Omit<z.infer<typeof UPDATE_ACCOUNT_SPEC>, "name">,
): UpdateAccountMetadataPatch {
  const { points_balance, metadata, ...rest } = parsed;
  const patch: UpdateAccountMetadataPatch = { ...rest };
  if (metadata !== undefined) patch.metadata = metadata;
  if (points_balance !== undefined) patch.metadata = { ...patch.metadata, points_balance };
  return patch;
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

  // One transaction: a metadata patch that throws must not leave the rename committed.
  const result = db.transaction((): UpdateAccountResult => {
    const out: UpdateAccountResult = { id };

    if (name !== undefined) {
      const changes = renameAccount(db, id, name);
      if (changes === 0) failAccountNotFound(db, id);
      out.name = name;
      out.renamed = true;
    }

    if (Object.keys(patch).length > 0) {
      let metaResult;
      try {
        metaResult = updateAccountMetadata(db, id, patch);
      } catch (err) {
        mapNotFoundError(err);
      }
      out.before = metaResult.before;
      out.after = metaResult.after;
    }

    return out;
  })();

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
