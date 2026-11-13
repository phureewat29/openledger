import type Database from "libsql";
import { parseJSONOrNull } from "../lib/json.js";
import { normalizeMaskedAccountNumber } from "../lib/masked.js";
import { buildPatch, type PatchField, type PatchResult } from "../lib/patch.js";
import { inTransaction } from "../db/transaction.js";
import { ACCOUNT_TYPES } from "../contract/enums.js";

export type AccountType = (typeof ACCOUNT_TYPES)[number];

export function isAccountType(value: string): value is AccountType {
  return (ACCOUNT_TYPES as readonly string[]).includes(value);
}

/** Currency is the id's currency head, never stored: same rule as `currencyOf` and the cross-ledger trigger's `substr(id,1,4)`. Change all together. */
export function accountCurrencySQL(alias: string): string {
  return `upper(substr(${alias}.id,1,3))`;
}

export const ACCOUNT_CURRENCY_SQL = accountCurrencySQL("a");

/** The projection every account read goes through, so `AccountRow.currency` can
 *  never come back undefined. */
export const ACCOUNT_COLUMNS_SQL = `a.*, ${ACCOUNT_CURRENCY_SQL} AS currency`;

/** At rest: bank_name is uppercased or NULL, account_number_masked is check-digit-normalized, metadata is JSON. */
export interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  parent_id: string | null;
  subtype: string | null;
  bank_name: string | null;
  account_number_masked: string | null;
  currency: string;
  due_day: number | null;
  statement_day: number | null;
  metadata_json: string | null;
  created_at: string;
}

export interface CreateAccountInput {
  id: string;
  name: string;
  type: AccountType;
  parent_id?: string | null;
  subtype?: string | null;
  bank_name?: string | null;
  account_number_masked?: string | null;
  due_day?: number | null;
  statement_day?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateAccountMetadataPatch {
  due_day?: number | null;
  statement_day?: number | null;
  account_number_masked?: string | null;
  bank_name?: string | null;
  metadata?: Record<string, unknown>;
}

export function findAccountById(db: Database.Database, id: string): AccountRow | null {
  return (
    (db
      .prepare(`SELECT ${ACCOUNT_COLUMNS_SQL} FROM accounts a WHERE a.id = ?`)
      .get(id) as AccountRow | undefined) ?? null
  );
}

export function accountExists(db: Database.Database, id: string): boolean {
  return !!db.prepare(`SELECT 1 FROM accounts WHERE id = ? LIMIT 1`).get(id);
}

export function countAccounts(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM accounts`).get() as { n: number };
  return row.n;
}

export function listAccounts(db: Database.Database): AccountRow[] {
  return db
    .prepare(`SELECT ${ACCOUNT_COLUMNS_SQL} FROM accounts a ORDER BY a.name`)
    .all() as AccountRow[];
}

export function countChildAccounts(db: Database.Database, parentId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM accounts WHERE parent_id = ?`)
    .get(parentId) as { n: number };
  return row.n;
}

/** Currency heads that actually hold accounts, lowercase; never derived from config. */
export function listLedgerCurrencies(db: Database.Database): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT substr(id,1,3) AS currency FROM accounts ORDER BY currency`)
    .all() as { currency: string }[];
  return rows.map((r) => r.currency);
}

/** Half-open range seek on the primary key (';' is the byte after ':'), not a full scan. */
export function ledgerExists(db: Database.Database, currency: string): boolean {
  const lower = currency.toLowerCase();
  return !!db
    .prepare(`SELECT 1 FROM accounts WHERE id >= ? AND id < ? LIMIT 1`)
    .get(`${lower}:`, `${lower};`);
}

/** Empty and absent both store NULL, on insert and patch alike. */
function bankNameAtRest(value: string | null | undefined): string | null {
  return value ? value.toUpperCase() : null;
}

/** `inserted: false` means the id was already taken; hierarchy invariants are the caller's (`createAccount`). */
export function insertAccount(
  db: Database.Database,
  input: CreateAccountInput,
): { inserted: boolean } {
  const result = db
    .prepare(
      `INSERT INTO accounts (id, name, type, parent_id, subtype, bank_name, account_number_masked, due_day, statement_day, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      input.id,
      input.name,
      input.type,
      input.parent_id ?? null,
      input.subtype ?? null,
      bankNameAtRest(input.bank_name),
      normalizeMaskedAccountNumber(input.account_number_masked),
      input.due_day ?? null,
      input.statement_day ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    );
  return { inserted: result.changes > 0 };
}

/** A concurrent writer claiming the id between check and insert is a lost race, not a broken invariant. */
export function insertStructuralAccount(
  db: Database.Database,
  row: { id: string; name: string; type: AccountType; parent_id: string | null },
): void {
  db.prepare(
    `INSERT INTO accounts (id, name, type, parent_id) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(row.id, row.name, row.type, row.parent_id);
}

export function renameAccount(db: Database.Database, id: string, name: string): number {
  return db.prepare(`UPDATE accounts SET name = ? WHERE id = ?`).run(name, id).changes;
}

export type UpdateAccountMetadataFailure = "not_found" | "unreadable_metadata";

type UpdateAccountMetadataOutcome =
  | { ok: true; before: Record<string, unknown>; after: Record<string, unknown> }
  | { ok: false; reason: UpdateAccountMetadataFailure; message: string };

const ACCOUNT_PATCH: Record<string, PatchField> = {
  due_day: {},
  statement_day: {},
  account_number_masked: {
    transform: (v) => normalizeMaskedAccountNumber(v as string | null),
  },
  bank_name: {
    transform: (v) => bankNameAtRest(v as string | null),
  },
};

/** Null for a blob that is not a JSON object, so a corrupt one refuses rather than becoming {}. */
function storedMetadata(metadataJSON: string | null): Record<string, unknown> | null {
  if (metadataJSON === null) return {};
  const parsed = parseJSONOrNull(metadataJSON);
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

const NO_METADATA_PATCH: PatchResult = { sets: [], params: [], before: {}, after: {} };

/** Null when the stored blob is unreadable. */
function metadataPatch(
  current: AccountRow,
  metadata: Record<string, unknown> | undefined,
): PatchResult | null {
  if (metadata === undefined) return NO_METADATA_PATCH;
  const existing = storedMetadata(current.metadata_json);
  if (!existing) return null;
  const merged = { ...existing, ...metadata };
  return {
    sets: ["metadata_json = ?"],
    params: [JSON.stringify(merged)],
    before: { metadata: existing },
    after: { metadata: merged },
  };
}

/** `metadata` is shallow-merged into the existing `metadata_json` blob, not replaced. */
export function updateAccountMetadata(
  db: Database.Database,
  id: string,
  patch: UpdateAccountMetadataPatch,
): UpdateAccountMetadataOutcome {
  return inTransaction(db, (): UpdateAccountMetadataOutcome => {
    const current = findAccountById(db, id);
    if (!current) return { ok: false, reason: "not_found", message: `Account "${id}" not found.` };

    const fields = buildPatch(ACCOUNT_PATCH, current, patch);
    const metadata = metadataPatch(current, patch.metadata);
    if (!metadata) {
      return {
        ok: false,
        reason: "unreadable_metadata",
        message: `Account "${id}" has unreadable metadata_json; refusing to overwrite it.`,
      };
    }

    const sets = [...fields.sets, ...metadata.sets];
    if (sets.length > 0) {
      db.prepare(`UPDATE accounts SET ${sets.join(", ")} WHERE id = ?`)
        .run(...fields.params, ...metadata.params, id);
    }
    return {
      ok: true,
      before: { ...fields.before, ...metadata.before },
      after: { ...fields.after, ...metadata.after },
    };
  });
}

/** Deletes the row alone; transaction/child guards are the caller's (src/accounts/accounts.ts). */
export function deleteAccount(db: Database.Database, id: string): boolean {
  return db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id).changes > 0;
}
