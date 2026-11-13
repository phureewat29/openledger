import type { Command } from "commander";
import type Database from "libsql";
import { cappedSummary, runAction, type Invocation } from "../cli/output.js";
import type { Column } from "../cli/format.js";
import { fail, failReason, type FailureCode } from "../cli/errors.js";
import { redactionEnabled, requireYes } from "../cli/input.js";
import { openLedger } from "../config/cli.js";
import { inTransaction } from "../db/transaction.js";
import {
  listMerchants as queryMerchants,
  claimAlias,
  clampMerchantsLimit,
  countMerchants,
  findMerchantByAlias,
  findMerchantById,
  findMerchantByName,
  renameMerchant,
  upsertMerchant as upsertMerchantRow,
  setMerchantDefaultAccount,
  type MerchantRow,
  type MerchantUpsertInput,
} from "./queries.js";
import { mergeMerchants as mergeMerchantRows, type MergeMerchantsFailure } from "./merchants.js";
import type {
  Merchant,
  MerchantDefaultResult,
  MerchantMergeResult,
  MerchantResolveResult,
  MerchantUpdateResult,
  MerchantUpsertResult,
} from "../contract/merchants.js";
import { requireAccount } from "../accounts/cli.js";
import { noiseTokens } from "../datasets/datasets.js";
import { prepareRedaction } from "../privacy/redactor.js";
import * as z from "zod";
import { parseInput, str, bool, int } from "../lib/validate.js";
import { clampOffset } from "../lib/limit.js";

/**
 * `canonical_name` is the only free-text field; ids and the default-account link are structured data left verbatim.
 */
const MERCHANT_REDACT_FIELDS = ["canonical_name"] as const;

const MERCHANT_COLUMNS: Column<Merchant>[] = [
  { header: "ID", value: (m) => m.id },
  { header: "Name", value: (m) => m.canonical_name },
  { header: "Default Account", value: (m) => m.default_account_id ?? "" },
  { header: "Aliases", value: (m) => String(m.alias_count), align: "right" },
];

function requireMerchant(db: Database.Database, id: string): MerchantRow {
  const merchant = findMerchantById(db, id);
  if (!merchant) fail("NOT_FOUND", `merchant "${id}" not found`);
  return merchant;
}

interface ListMerchantsOpts {
  redact?: boolean;
}

const LIST_MERCHANTS_SPEC = z.object({
  limit: int().optional(),
  offset: int().optional(),
});

async function listMerchants(ctx: Invocation, opts: ListMerchantsOpts): Promise<void> {
  const parsed = parseInput(LIST_MERCHANTS_SPEC, opts);
  const { config, db } = await openLedger(ctx);
  const redact = prepareRedaction(redactionEnabled(opts), config);
  const rows = redact(
    queryMerchants(db, { limit: parsed.limit, offset: parsed.offset }),
    MERCHANT_REDACT_FIELDS,
  );
  ctx.out.emitList(rows, MERCHANT_COLUMNS);
  ctx.out.emitSummary(
    cappedSummary(
      countMerchants(db),
      rows.length,
      clampMerchantsLimit(parsed.limit),
      clampOffset(parsed.offset),
    ),
  );
}

const RESOLVE_MERCHANT_SPEC = z.object({ descriptor: str() });

async function resolveMerchant(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(RESOLVE_MERCHANT_SPEC, opts);
  const { config, db } = await openLedger(ctx);
  const match = findMerchantByAlias(db, parsed.descriptor, noiseTokens(config.country));
  const resolved: MerchantResolveResult = match
    ? {
        found: true,
        merchant_id: match.id,
        canonical_name: match.canonical_name,
        default_account_id: match.default_account_id,
      }
    : { found: false };
  ctx.out.emitObject(resolved);
}

const UPSERT_MERCHANT_SPEC = z.object({
  name: str(),
  alias: str().optional(),
  default_account: str().optional(),
});

async function upsertMerchant(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(UPSERT_MERCHANT_SPEC, opts);
  // An all-whitespace name is the flag not being passed, and reads that way.
  if (!parsed.name.trim()) fail("USAGE", "--name required");
  const { config, db } = await openLedger(ctx);
  if (parsed.default_account) requireAccount(db, parsed.default_account);
  const input: MerchantUpsertInput = {
    canonical_name: parsed.name,
    ...(parsed.alias ? { alias: parsed.alias } : {}),
    ...(parsed.default_account ? { default_account_id: parsed.default_account } : {}),
  };

  const merchant = upsertMerchantRow(db, input, noiseTokens(config.country));
  const payload: MerchantUpsertResult = {
    id: merchant.id,
    canonical_name: merchant.canonical_name,
    default_account_id: merchant.default_account_id,
    created_at: merchant.created_at,
    ...(merchant.alias_conflict ? { alias_conflict: merchant.alias_conflict } : {}),
  };
  ctx.out.emitObject(payload);
}

const UPDATE_MERCHANT_SPEC = z.object({
  merchant: str(),
  name: str().optional(),
  alias: str().optional(),
  default_account: str().optional(),
});

function renameUnlessTaken(
  db: Database.Database,
  id: string,
  name: string,
  noise: readonly string[],
): Pick<MerchantUpdateResult, "before" | "after" | "alias_conflict"> {
  const holder = findMerchantByName(db, name);
  if (holder && holder.id !== id) {
    fail("INVALID", `merchant name "${name.trim()}" already belongs to ${holder.id}`, {
      hint: `merge them instead: oled merchants merge --from ${id} --to ${holder.id} --yes`,
    });
  }
  return renameMerchant(db, id, name, noise);
}

function addAlias(
  db: Database.Database,
  id: string,
  alias: string,
  noise: readonly string[],
): Pick<MerchantUpdateResult, "alias_conflict" | "alias_added"> {
  const conflict = claimAlias(db, id, alias, noise);
  return conflict ? { alias_conflict: conflict } : { alias_added: alias };
}

async function updateMerchant(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const { merchant: id, ...parsed } = parseInput(UPDATE_MERCHANT_SPEC, opts, {
    atLeastOne: "at least one of --name, --alias, --default-account is required",
  });
  if (parsed.name !== undefined && !parsed.name.trim()) fail("USAGE", "--name required");
  const { config, db } = await openLedger(ctx);
  const noise = noiseTokens(config.country);

  const result = inTransaction(db, (): MerchantUpdateResult => {
    requireMerchant(db, id);
    if (parsed.default_account) requireAccount(db, parsed.default_account);
    const renamed = parsed.name ? renameUnlessTaken(db, id, parsed.name, noise) : {};
    const aliased = parsed.alias ? addAlias(db, id, parsed.alias, noise) : {};
    if (parsed.default_account) setMerchantDefaultAccount(db, id, parsed.default_account);
    return {
      merchant_id: id,
      ...renamed,
      ...aliased,
      ...(parsed.default_account ? { default_account: parsed.default_account } : {}),
    };
  });

  ctx.out.emitObject(result);
}

const SET_DEFAULT_SPEC = z.object({
  merchant: str(),
  account: str().optional(),
  clear: bool().optional(),
});

async function setMerchantDefault(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(SET_DEFAULT_SPEC, opts);
  const account = parsed.account;
  if (!!account === !!parsed.clear) {
    fail("USAGE", "exactly one of --account or --clear is required");
  }

  const { db } = await openLedger(ctx);
  const payload = inTransaction(db, (): MerchantDefaultResult => {
    const merchant = requireMerchant(db, parsed.merchant);
    if (account) requireAccount(db, account);
    const after = account ?? null;
    setMerchantDefaultAccount(db, parsed.merchant, after);
    return { merchant_id: parsed.merchant, before: merchant.default_account_id, after };
  });
  ctx.out.emitObject(payload);
}

const MERGE_MERCHANTS_SPEC = z.object({
  from: str(),
  to: str(),
});

export const MERGE_MERCHANTS_EXIT: Record<MergeMerchantsFailure, FailureCode> = {
  same_merchant: "INVALID",
  not_found: "NOT_FOUND",
};

interface MergeMerchantsOpts {
  from?: string;
  to?: string;
  yes?: boolean;
}

async function mergeMerchants(ctx: Invocation, opts: MergeMerchantsOpts): Promise<void> {
  const parsed = parseInput(MERGE_MERCHANTS_SPEC, opts);
  requireYes(opts, "merging merchants");
  const { db } = await openLedger(ctx);
  const result = mergeMerchantRows(db, parsed.from, parsed.to);
  if (!result.ok) failReason(MERGE_MERCHANTS_EXIT, result);
  const payload: MerchantMergeResult = {
    from: parsed.from,
    to: parsed.to,
    moved_transactions: result.moved_transactions,
    moved_aliases: result.moved_aliases,
    ...(result.adopted_default_account ? { adopted_default_account: result.adopted_default_account } : {}),
  };
  ctx.out.emitObject(payload);
}

export function registerMerchants(program: Command): void {
  const merchants = program
    .command("merchants")
    .description("Manage merchants and their default accounts")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: manages merchants and their default accounts; an alias maps raw bank text to a merchant.",
        "Typical flow: resolve a descriptor; if unknown, upsert with a name and alias, then set-default.",
        "Cleaning names: `update --merchant <id> --name <clean>` renames in place and keeps the raw name as an alias.",
        "Example: oled merchants resolve --descriptor \"POS STARBUCKS\" --json",
      ].join("\n"),
    );

  merchants
    .command("list")
    .description("List merchants")
    .option("--limit <n>", "max rows (default 200, max 1000)")
    .option("--offset <n>", "rows to skip; repeat with offset += returned while the summary says has_more")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(listMerchants));

  merchants
    .command("resolve")
    .description("Resolve a merchant from a descriptor")
    .option("--descriptor <text>", "raw transaction descriptor")
    .action(runAction(resolveMerchant));

  merchants
    .command("upsert")
    .description("Create or update a merchant")
    .option("--name <name>", "merchant canonical name")
    .option("--alias <alias>", "merchant alias to add")
    .option("--default-account <id>", "default account id, currency-prefixed (e.g. thb:expense:food)")
    .action(runAction(upsertMerchant));

  merchants
    .command("update")
    .description("Rename a merchant or add an alias; the old name keeps resolving")
    .option("--merchant <id>", "merchant id")
    .option("--name <name>", "new canonical name (the old one is kept as an alias)")
    .option("--alias <alias>", "additional alias to claim")
    .option("--default-account <id>", "default account id, currency-prefixed (e.g. thb:expense:food)")
    .addHelpText(
      "after",
      "\nNote: `transactions add --merchant-name` matches by name, so the old spelling there would create a new merchant; prefer ids after a rename.",
    )
    .action(runAction(updateMerchant));

  merchants
    .command("set-default")
    .description("Set or clear a merchant's default account")
    .option("--merchant <id>", "merchant id")
    .option("--account <id>", "account id, currency-prefixed (e.g. thb:expense:food)")
    .option("--clear", "clear the default account instead of setting one")
    .action(runAction(setMerchantDefault));

  merchants
    .command("merge")
    .description("Merge one merchant into another")
    .option("--from <id>", "merchant id to merge from")
    .option("--to <id>", "merchant id to merge into")
    .option("--yes", "skip confirmation")
    .action(runAction(mergeMerchants));
}
