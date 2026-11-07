import type Database from "libsql";
import { randomUUID } from "crypto";
import { clampLimit, clampOffset } from "../lib/limit.js";
import { inTransaction } from "../db/transaction.js";

export interface MerchantUpsertInput {
  canonical_name: string;
  alias?: string;
  default_account_id?: string | null;
}

export interface MerchantRow {
  id: string;
  canonical_name: string;
  default_account_id: string | null;
  created_at: string;
}

const ROW_COLUMNS = "id, canonical_name, default_account_id, created_at";

const MERCHANT_SELECT = `SELECT ${ROW_COLUMNS} FROM merchants`;

const MERCHANT_SELECT_BY_ALIAS = `SELECT m.id, m.canonical_name, m.default_account_id, m.created_at
     FROM merchant_aliases ma
     JOIN merchants m ON m.id = ma.merchant_id`;

interface MerchantAliasConflict {
  pattern: string;
  held_by: string;
}

interface MerchantUpsertResult extends MerchantRow {
  /** Present when `input.alias` normalizes to a pattern another merchant already holds; the alias stays with its owner. */
  alias_conflict?: MerchantAliasConflict;
}

/** Tokens naming a PLACE are locale data; they belong in `datasets/<cc>.json`'s `noise` key, not here. */
const DEFAULT_NOISE = [
  "charge", "purchase", "payment", "pmt", "ref", "txn", "trx", "tx",
  "pos", "atm", "online", "web", "mobile", "app",
  "co", "ltd", "company", "inc", "llc", "plc", "intl",
] as const;

/**
 * Strips store ids, terminal codes, and transaction-type words to the form
 * `merchant_aliases.normalized_pattern` indexes. `noiseTokens` is the caller's
 * locale layer, stripped on top of DEFAULT_NOISE; the punctuation pass drops
 * non-ASCII, so only romanized tokens can match.
 */
export function normalizeDescriptor(raw: string, noiseTokens: readonly string[]): string {
  if (!raw) return "";
  const lowered = raw.toLowerCase();
  const stripped = lowered
    .replace(/[#*][a-z0-9]+/gi, " ")
    .replace(/\b\d{2,}\b/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  const noise = new Set<string>([...DEFAULT_NOISE, ...noiseTokens]);
  const tokens = stripped.split(" ").filter(t => t.length > 1 && !noise.has(t));
  if (tokens.length === 0) return stripped;
  return tokens.join(" ");
}

/**
 * Meant to run inside the same DB transaction as the write it serves, so a
 * transaction never lands without its merchant.
 */
export function upsertMerchant(
  db: Database.Database,
  input: MerchantUpsertInput,
  noiseTokens: readonly string[],
): MerchantUpsertResult {
  const canonical = input.canonical_name.trim();
  if (!canonical) throw new Error("merchant canonical_name is required");

  return inTransaction(db, (): MerchantUpsertResult => {
    const existing = findMerchantByName(db, canonical);
    const merchant = existing
      ? adoptDefaultAccount(db, existing, input.default_account_id)
      : insertMerchant(db, canonical, input.default_account_id);
    const aliasConflict = input.alias
      ? claimAlias(db, merchant.id, input.alias, noiseTokens)
      : undefined;
    return aliasConflict ? { ...merchant, alias_conflict: aliasConflict } : merchant;
  });
}

function adoptDefaultAccount(
  db: Database.Database,
  merchant: MerchantRow,
  accountId: string | null | undefined,
): MerchantRow {
  if (!accountId || accountId === merchant.default_account_id) return merchant;
  db.prepare(`UPDATE merchants SET default_account_id = ? WHERE id = ?`).run(accountId, merchant.id);
  return { ...merchant, default_account_id: accountId };
}

function insertMerchant(
  db: Database.Database,
  canonicalName: string,
  defaultAccountId: string | null | undefined,
): MerchantRow {
  // RETURNING captures the created_at DEFAULT the insert assigned.
  return db
    .prepare(
      `INSERT INTO merchants (id, canonical_name, default_account_id) VALUES (?, ?, ?)
       RETURNING ${ROW_COLUMNS}`,
    )
    .get(`m:${randomUUID()}`, canonicalName, defaultAccountId ?? null) as MerchantRow;
}

/** A pattern already held by another merchant stays with its owner and is reported as a conflict. */
export function claimAlias(
  db: Database.Database,
  merchantId: string,
  rawText: string,
  noiseTokens: readonly string[],
): MerchantAliasConflict | undefined {
  const normalized = normalizeDescriptor(rawText, noiseTokens);
  if (!normalized) return undefined;
  db.prepare(
    `INSERT INTO merchant_aliases (id, merchant_id, normalized_pattern) VALUES (?, ?, ?)
     ON CONFLICT(normalized_pattern) DO NOTHING`,
  ).run(`ma:${randomUUID()}`, merchantId, normalized);
  const holder = db
    .prepare(`SELECT merchant_id FROM merchant_aliases WHERE normalized_pattern = ?`)
    .get(normalized) as { merchant_id: string } | undefined;
  if (!holder || holder.merchant_id === merchantId) return undefined;
  return { pattern: normalized, held_by: holder.merchant_id };
}

export function findMerchantByName(db: Database.Database, name: string): MerchantRow | null {
  const row = db
    .prepare(`${MERCHANT_SELECT} WHERE canonical_name = ?`)
    .get(name.trim()) as MerchantRow | undefined;
  return row ?? null;
}

interface RenameMerchantResult {
  before: string;
  after: string;
  /** The old name's pattern was already claimed by another merchant. */
  alias_conflict?: MerchantAliasConflict;
}

/**
 * Keeps the old name as an alias so raw descriptors that produced it still
 * resolve to this merchant. Display names are a live join, so no transaction
 * rows need touching.
 */
export function renameMerchant(
  db: Database.Database,
  id: string,
  name: string,
  noiseTokens: readonly string[],
): RenameMerchantResult {
  const canonical = name.trim();
  if (!canonical) throw new Error("merchant canonical_name is required");

  return inTransaction(db, (): RenameMerchantResult => {
    const current = findMerchantById(db, id);
    if (!current) throw new Error(`merchant "${id}" not found`);
    if (current.canonical_name === canonical) {
      return { before: current.canonical_name, after: canonical };
    }

    db.prepare(`UPDATE merchants SET canonical_name = ? WHERE id = ?`).run(canonical, id);
    const conflict = claimAlias(db, id, current.canonical_name, noiseTokens);
    const renamed = { before: current.canonical_name, after: canonical };
    return conflict ? { ...renamed, alias_conflict: conflict } : renamed;
  });
}

export function findMerchantByAlias(
  db: Database.Database,
  rawDescriptor: string,
  noiseTokens: readonly string[],
): MerchantRow | null {
  const normalized = normalizeDescriptor(rawDescriptor, noiseTokens);
  if (!normalized) return null;

  const row = db.prepare(
    `${MERCHANT_SELECT_BY_ALIAS}
     WHERE ma.normalized_pattern = ?`,
  ).get(normalized) as MerchantRow | undefined;

  return row ?? null;
}

interface ListMerchantsOptions {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

export function clampMerchantsLimit(limit?: number): number {
  return clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
}

export function listMerchants(
  db: Database.Database,
  opts: ListMerchantsOptions = {},
): (MerchantRow & { alias_count: number })[] {
  const limit = clampMerchantsLimit(opts.limit);
  return db.prepare(
    `SELECT m.id, m.canonical_name, m.default_account_id, m.created_at,
            (SELECT COUNT(*) FROM merchant_aliases ma WHERE ma.merchant_id = m.id) AS alias_count
     FROM merchants m
     ORDER BY m.canonical_name
     LIMIT ? OFFSET ?`,
  ).all(limit, clampOffset(opts.offset)) as (MerchantRow & { alias_count: number })[];
}

export function countMerchants(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM merchants`).get() as { n: number };
  return row.n;
}

export function merchantExists(db: Database.Database, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM merchants WHERE id = ?`).get(id);
}

export function findMerchantById(
  db: Database.Database,
  id: string,
): MerchantRow | null {
  const row = db
    .prepare(`${MERCHANT_SELECT} WHERE id = ?`)
    .get(id) as MerchantRow | undefined;
  return row ?? null;
}

/** A null `accountId` clears the default; false when no merchant has `merchantId`. */
export function setMerchantDefaultAccount(
  db: Database.Database,
  merchantId: string,
  accountId: string | null,
): boolean {
  return db
    .prepare(`UPDATE merchants SET default_account_id = ? WHERE id = ?`)
    .run(accountId, merchantId).changes > 0;
}

/** The merchant half of `mergeAccounts`: the routing hint follows the survivor instead of being FK-nulled. */
export function repointMerchantDefaultAccount(
  db: Database.Database,
  fromAccountId: string,
  toAccountId: string,
): number {
  return db
    .prepare(`UPDATE merchants SET default_account_id = ? WHERE default_account_id = ?`)
    .run(toAccountId, fromAccountId).changes;
}

export type MergeMerchantsFailure = "same_merchant" | "not_found";

type MergeMerchantsOutcome =
  | {
      ok: true;
      moved_transactions: number;
      moved_aliases: number;
      /** Present only when the destination had no default_account_id and the
       *  source's was adopted in its place. */
      adopted_default_account?: string;
    }
  | { ok: false; reason: MergeMerchantsFailure; message: string };

export function mergeMerchants(
  db: Database.Database,
  fromId: string,
  toId: string,
): MergeMerchantsOutcome {
  if (fromId === toId) {
    return { ok: false, reason: "same_merchant", message: "Cannot merge a merchant into itself." };
  }

  return inTransaction(db, (): MergeMerchantsOutcome => {
    const from = findMerchantById(db, fromId);
    if (!from) return { ok: false, reason: "not_found", message: `Source merchant ${fromId} not found.` };
    const to = findMerchantById(db, toId);
    if (!to) return { ok: false, reason: "not_found", message: `Destination merchant ${toId} not found.` };

    const movedTransactions = db
      .prepare(`UPDATE transactions SET merchant_id = ? WHERE merchant_id = ?`)
      .run(toId, fromId).changes;
    const movedAliases = db
      .prepare(`UPDATE merchant_aliases SET merchant_id = ? WHERE merchant_id = ?`)
      .run(toId, fromId).changes;
    const adopted = !to.default_account_id && from.default_account_id;
    if (adopted) {
      db.prepare(`UPDATE merchants SET default_account_id = ? WHERE id = ?`).run(adopted, toId);
    }
    db.prepare(`DELETE FROM merchants WHERE id = ?`).run(fromId);

    return {
      ok: true,
      moved_transactions: movedTransactions,
      moved_aliases: movedAliases,
      ...(adopted ? { adopted_default_account: adopted } : {}),
    };
  });
}
