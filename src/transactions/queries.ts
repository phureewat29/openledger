import type Database from "libsql";
import { chunk, groupBy, pick, sumBy } from "es-toolkit";
import { accountCurrencySQL, accountExists } from "../accounts/queries.js";
import { upsertMerchant, type MerchantUpsertInput } from "../merchants/queries.js";
import { buildPatch, type PatchField } from "../lib/patch.js";
import { STRUCTURAL_SUFFIX, currencyOf, newTransactionId } from "../lib/ids.js";
import { clampLimit, clampOffset } from "../lib/limit.js";
import { ISO_DATE_RE } from "../lib/date.js";
import { inTransaction } from "../db/transaction.js";

/** `noise_tokens` lives here, not on `TransactionInput`, so only rows claiming an alias carry one. */
interface TransactionMerchantInput extends MerchantUpsertInput {
  noise_tokens: readonly string[];
}

/**
 * One debit account, one credit account, one positive minor-unit `amount`
 * (INTEGER). Decimal <-> minor conversion happens at the CLI/pipeline
 * boundary, never here.
 */
export interface TransactionInput {
  /** Pre-assigned id (`tx:`+hash) so mid-ingest questions can reference the transaction before commit. */
  id?: string;
  /** Links sibling legs (e.g. a split transaction, an FX pair). */
  group_id?: string | null;
  date: string;
  description: string;
  /** Pre-resolved merchant id. Overrides any `merchant` upsert when set. */
  merchant_id?: string | null;
  merchant?: TransactionMerchantInput | null;
  raw_descriptor?: string | null;
  source_file_id?: string | null;
  source_page?: number | null;
  debit_account_id: string;
  credit_account_id: string;
  /** Integer minor units. Positive (enforced by validateTransaction + CHECK). */
  amount: number;
}

export interface TransactionRow {
  id: string;
  group_id: string | null;
  date: string;
  description: string;
  merchant_id: string | null;
  raw_descriptor: string | null;
  source_file_id: string | null;
  source_page: number | null;
  debit_account_id: string;
  credit_account_id: string;
  amount: number;
  /** Not stored: derived from the debit account's ledger (the cross-ledger trigger guarantees the credit side matches). */
  currency: string;
  /** The surviving twin's id once `voidTransactionAsMirror` voids this row into it; NULL means live. */
  void_of: string | null;
  created_at: string;
  debit_account_name: string | null;
  credit_account_name: string | null;
  merchant_name: string | null;
}

/** A queried transaction plus every member of its group (self included). */
interface TransactionDetail extends TransactionRow {
  group?: TransactionRow[];
}

export type ValidateTransactionResult =
  | { ok: true }
  | { ok: false; reason: "invalid_transaction"; message: string };

const TRANSACTION_VALID: ValidateTransactionResult = { ok: true };

/** The fields a transaction carries whichever form its amount is in. */
interface TransactionFields {
  date: string;
  description: string;
  debit_account_id: string;
  credit_account_id: string;
}

/**
 * Shared with `validateRawTransaction` (src/ingest/commit.ts) so both
 * validators agree on wording; messages are field-first since they surface as
 * an agent's `dirty_input` reason.
 */
export function validateTransactionFields(input: TransactionFields): ValidateTransactionResult {
  if (!ISO_DATE_RE.test(input.date ?? "")) {
    return invalidTransaction("date must be an ISO date (YYYY-MM-DD).");
  }
  if (!input.description?.trim()) {
    return invalidTransaction("description must not be empty.");
  }
  if (!input.debit_account_id?.trim()) {
    return invalidTransaction("debit_account_id must not be empty.");
  }
  if (!input.credit_account_id?.trim()) {
    return invalidTransaction("credit_account_id must not be empty.");
  }
  if (input.debit_account_id === input.credit_account_id) {
    return invalidTransaction("debit and credit accounts must differ.");
  }
  return TRANSACTION_VALID;
}

export function invalidTransaction(message: string): ValidateTransactionResult {
  return { ok: false, reason: "invalid_transaction", message };
}

/** `isSafeInteger` subsumes the `amount <= 9007199254740991` CHECK, so an
 *  out-of-range amount fails here instead of aborting the insert on raw DDL text. */
export function validateTransaction(input: TransactionInput): ValidateTransactionResult {
  const fields = validateTransactionFields(input);
  if (!fields.ok) return fields;
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    return invalidTransaction("amount must be a positive integer in minor units.");
  }
  return TRANSACTION_VALID;
}

const INSERT_COLUMNS =
  "id, group_id, date, description, merchant_id, raw_descriptor, source_file_id, source_page, debit_account_id, credit_account_id, amount";

function insertParams(id: string, merchantId: string | null, input: TransactionInput): unknown[] {
  return [
    id,
    input.group_id ?? null,
    input.date,
    input.description,
    merchantId,
    input.raw_descriptor ?? null,
    input.source_file_id ?? null,
    input.source_page ?? null,
    input.debit_account_id,
    input.credit_account_id,
    input.amount,
  ];
}

/** `ON CONFLICT(id) DO NOTHING`: re-inserting the same derived id is a no-op, reported as `duplicate`. */
export function insertTransaction(
  db: Database.Database,
  input: TransactionInput,
): { id: string; duplicate: boolean } {
  const check = validateTransaction(input);
  if (!check.ok) throw new Error(check.message);

  const id = input.id ?? newTransactionId();
  const merchantId =
    !input.merchant_id && input.merchant
      ? upsertMerchant(db, input.merchant, input.merchant.noise_tokens).id
      : (input.merchant_id ?? null);

  const result = db
    .prepare(
      `INSERT INTO transactions (${INSERT_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(...insertParams(id, merchantId, input));
  return { id, duplicate: result.changes === 0 };
}

/** Every leg takes `groupId`; any leg's failure rolls back all of them. */
export function insertLinkedTransactions(
  db: Database.Database,
  inputs: TransactionInput[],
  groupId: string,
): { id: string; duplicate: boolean }[] {
  if (inputs.length === 0) {
    throw new Error("insertLinkedTransactions requires at least one transaction.");
  }
  return inTransaction(db, () =>
    inputs.map((input) => insertTransaction(db, { ...input, group_id: groupId })),
  );
}

// Shared by listing and counts so a `--query` filter (reads joined names) matches in both.
const LIST_FROM = `FROM transactions t
   LEFT JOIN accounts da ON da.id = t.debit_account_id
   LEFT JOIN accounts ca ON ca.id = t.credit_account_id
   LEFT JOIN merchants m ON m.id = t.merchant_id`;

const ROW_SELECT = `SELECT t.id, t.group_id, t.date, t.description, t.merchant_id,
        t.raw_descriptor, t.source_file_id, t.source_page,
        t.debit_account_id, t.credit_account_id, t.amount,
        ${accountCurrencySQL("da")} AS currency,
        t.void_of, t.created_at,
        da.name AS debit_account_name,
        ca.name AS credit_account_name,
        m.canonical_name AS merchant_name
   ${LIST_FROM}`;

/** `group` is in insertion order, so legs read as committed. */
export function findTransactionById(db: Database.Database, id: string): TransactionDetail | null {
  const row = db.prepare(`${ROW_SELECT} WHERE t.id = ?`).get(id) as TransactionRow | undefined;
  if (!row) return null;
  if (!row.group_id) return row;
  const group = db
    .prepare(`${ROW_SELECT} WHERE t.group_id = ? ORDER BY t.rowid`)
    .all(row.group_id) as TransactionRow[];
  return { ...row, group };
}

export interface ListTransactionsOptions {
  /** Match either side (debit OR credit) of the transaction. */
  account?: string;
  /** ISO code of the ledger to scope rows to. Ignored when `account` is set. */
  ledger?: string;
  from?: string;
  to?: string;
  /** Literal substring of description, raw_descriptor, merchant name, or either account name. */
  query?: string;
  /** Exact match on the stored minor-unit amount. */
  amount?: number;
  limit?: number;
  /** Page with `offset += returned` while the summary says `has_more`. */
  offset?: number;
  /** Voided mirrors are hidden by default, so counts agree with balances. */
  includeVoid?: boolean;
}

type ListFilters = Omit<ListTransactionsOptions, "limit" | "offset">;

const QUERY_COLUMNS = ["t.description", "t.raw_descriptor", "m.canonical_name", "da.name", "ca.name"];

const QUERY_SQL = `(${QUERY_COLUMNS.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`;

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

// Shared by listTransactions and countTransactions so a filtered count matches the list.
function buildListWhere(opts: ListFilters): { whereSQL: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!opts.includeVoid) conditions.push("t.void_of IS NULL");
  if (opts.account) {
    conditions.push("(t.debit_account_id = ? OR t.credit_account_id = ?)");
    params.push(opts.account, opts.account);
  }
  // Same expression the `currency` column is projected from, so filtering matches what's reported.
  if (opts.ledger && !opts.account) {
    conditions.push(`${accountCurrencySQL("da")} = upper(?)`);
    params.push(opts.ledger);
  }
  if (opts.from) {
    conditions.push("t.date >= ?");
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push("t.date <= ?");
    params.push(opts.to);
  }
  if (opts.query) {
    const like = `%${escapeLike(opts.query)}%`;
    conditions.push(QUERY_SQL);
    params.push(...QUERY_COLUMNS.map(() => like));
  }
  if (opts.amount !== undefined) {
    conditions.push("t.amount = ?");
    params.push(opts.amount);
  }

  const whereSQL = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return { whereSQL, params };
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

export function clampListLimit(limit?: number): number {
  return clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
}

/** Newest date first; same-day rows newest insert first, since random ids can't break that tie stably. */
export function listTransactions(
  db: Database.Database,
  opts: ListTransactionsOptions = {},
): TransactionRow[] {
  const { whereSQL, params } = buildListWhere(opts);
  return db
    .prepare(`${ROW_SELECT} ${whereSQL} ORDER BY t.date DESC, t.rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, clampListLimit(opts.limit), clampOffset(opts.offset)) as TransactionRow[];
}

/** Deleting a surviving twin un-voids its mirrors (`void_of` ON DELETE SET NULL). */
export function deleteTransaction(
  db: Database.Database,
  id: string,
): { deleted: boolean; unvoided: number } {
  return inTransaction(db, () => {
    const mirrors = (
      db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE void_of = ?`).get(id) as { n: number }
    ).n;
    const deleted = db.prepare(`DELETE FROM transactions WHERE id = ?`).run(id).changes > 0;
    return { deleted, unvoided: deleted ? mirrors : 0 };
  });
}

/** Spot-check sample, not the full id list. */
const RECATEGORIZE_SAMPLE_LIMIT = 10;

/** Comfortably under libsql's ~32.7k bound-parameter cap (4 fixed params + one per id). */
const RECATEGORIZE_UPDATE_CHUNK_SIZE = 10_000;

interface BulkRecategorizeResult {
  affected: number;
  /** Rows skipped because moving them would make debit == credit. */
  skipped_self_transaction: number;
  /** Rows skipped because the target sits on another ledger. */
  skipped_currency_mismatch: number;
  /** First RECATEGORIZE_SAMPLE_LIMIT updated ids; `affected` is the true count. */
  sample_transaction_ids: string[];
}

export type RecategorizeFailure = "same_account" | "not_found";

type BulkRecategorizeOutcome =
  | ({ ok: true } & BulkRecategorizeResult)
  | { ok: false; reason: RecategorizeFailure; message: string };

interface RecategorizeCandidate {
  id: string;
  debit_account_id: string;
  credit_account_id: string;
}

type RecategorizeFate = "self_transaction" | "currency_mismatch" | "update";

function recategorizeFate(row: RecategorizeCandidate, from: string, to: string): RecategorizeFate {
  const other = row.debit_account_id === from ? row.credit_account_id : row.debit_account_id;
  if (other === to) return "self_transaction";
  if (currencyOf(other) !== currencyOf(to)) return "currency_mismatch";
  return "update";
}

function repointSides(db: Database.Database, from: string, to: string, ids: string[]): number {
  return db
    .prepare(
      `UPDATE transactions
         SET debit_account_id  = CASE WHEN debit_account_id  = ? THEN ? ELSE debit_account_id  END,
             credit_account_id = CASE WHEN credit_account_id = ? THEN ? ELSE credit_account_id END
       WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .run(from, to, from, to, ...ids).changes;
}

/**
 * Re-points the `fromId` side of every transaction touching it onto `toId`,
 * skipping the rows the debit<>credit CHECK or the
 * cross-ledger trigger would abort the statement on.
 */
export function bulkRecategorize(
  db: Database.Database,
  fromId: string,
  toId: string,
): BulkRecategorizeOutcome {
  if (fromId === toId) {
    return {
      ok: false,
      reason: "same_account",
      message: "Cannot recategorize an account into itself.",
    };
  }

  return inTransaction(db, (): BulkRecategorizeOutcome => {
    if (!accountExists(db, toId)) {
      return { ok: false, reason: "not_found", message: `account "${toId}" not found` };
    }
    const rows = db
      .prepare(
        `SELECT id, debit_account_id, credit_account_id FROM transactions
          WHERE debit_account_id = ? OR credit_account_id = ?`,
      )
      .all(fromId, fromId) as RecategorizeCandidate[];
    const {
      self_transaction = [],
      currency_mismatch = [],
      update = [],
    } = groupBy(rows, (row) => recategorizeFate(row, fromId, toId));

    const ids = update.map((row) => row.id);
    const affected = sumBy(chunk(ids, RECATEGORIZE_UPDATE_CHUNK_SIZE), (batch) =>
      repointSides(db, fromId, toId, batch),
    );
    return {
      ok: true,
      affected,
      skipped_self_transaction: self_transaction.length,
      skipped_currency_mismatch: currency_mismatch.length,
      sample_transaction_ids: ids.slice(0, RECATEGORIZE_SAMPLE_LIMIT),
    };
  });
}

/**
 * The re-point step of `mergeAccounts` (src/accounts/accounts.ts). Rows that
 * would become a degenerate self-transaction are deleted FIRST, since the
 * debit<>credit CHECK forbids that state even transiently.
 */
export function repointTransactions(
  db: Database.Database,
  fromId: string,
  toId: string,
): { moved: number; deletedSelfTransactions: number } {
  if (fromId === toId) throw new Error("Cannot re-point transactions to the same account.");

  return inTransaction(db, () => {
    const deletedSelfTransactions = db
      .prepare(
        `DELETE FROM transactions
          WHERE (debit_account_id = ? AND credit_account_id = ?)
             OR (credit_account_id = ? AND debit_account_id = ?)`,
      )
      .run(fromId, toId, fromId, toId).changes;

    const d = db
      .prepare(`UPDATE transactions SET debit_account_id = ? WHERE debit_account_id = ?`)
      .run(toId, fromId).changes;
    const c = db
      .prepare(`UPDATE transactions SET credit_account_id = ? WHERE credit_account_id = ?`)
      .run(toId, fromId).changes;
    return { moved: d + c, deletedSelfTransactions };
  });
}

/** Same filters as listTransactions, no limit; with no opts it counts every live row (voided mirrors excluded). */
export function countTransactions(db: Database.Database, opts: ListFilters = {}): number {
  const { whereSQL, params } = buildListWhere(opts);
  return (
    db.prepare(`SELECT COUNT(*) AS n ${LIST_FROM} ${whereSQL}`).get(...params) as { n: number }
  ).n;
}

export function countTransactionsBySourceFile(db: Database.Database, fileId: string): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE source_file_id = ?`).get(fileId) as {
      n: number;
    }
  ).n;
}

export function accountHasTransactions(db: Database.Database, accountId: string): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM transactions WHERE debit_account_id = ? OR credit_account_id = ? LIMIT 1`,
    )
    .get(accountId, accountId);
}

export interface UpdateTransactionMetaFields {
  date?: string;
  description?: string;
  merchant_id?: string | null;
}

const TRANSACTION_META_PATCH: Record<keyof UpdateTransactionMetaFields, PatchField> = {
  date: {},
  description: {},
  merchant_id: {},
};

/** Amount and account columns aren't accepted here: moving accounts is `bulkRecategorize`'s job, and amount edits go through delete and re-add. */
export function updateTransactionMeta(
  db: Database.Database,
  id: string,
  fields: UpdateTransactionMetaFields,
): number {
  const { sets, params } = buildPatch(TRANSACTION_META_PATCH, {}, fields);
  if (sets.length === 0) return 0;
  return db
    .prepare(`UPDATE transactions SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params, id).changes;
}

interface VoidCandidate {
  amount: number;
  debit_account_id: string;
  credit_account_id: string;
  void_of: string | null;
}

export type VoidMirrorFailure = "same_transaction" | "not_found" | "target_voided" | "not_mirrors";

type VoidMirrorOutcome =
  | { ok: true; alreadyVoid: boolean }
  | { ok: false; reason: VoidMirrorFailure; message: string };

/**
 * Voids `fromId` into surviving `toId` (sets `void_of=toId`); never deletes,
 * so re-ingesting the mirror's source file can't resurrect it. Requires
 * matching amount and both accounts, but not date (statement vs. posting
 * dates legitimately differ). Re-voiding an already-void row is a no-op.
 * The checks share the UPDATE's transaction, or crossed merges (A into B, B
 * into A) would both pass the live check and void the pair.
 */
export function voidTransactionAsMirror(
  db: Database.Database,
  fromId: string,
  toId: string,
): VoidMirrorOutcome {
  if (fromId === toId) {
    return { ok: false, reason: "same_transaction", message: "Cannot merge a transaction into itself." };
  }

  return inTransaction(db, (): VoidMirrorOutcome => {
    const select = db.prepare(
      `SELECT amount, debit_account_id, credit_account_id, void_of FROM transactions WHERE id = ?`,
    );
    const from = select.get(fromId) as VoidCandidate | undefined;
    if (!from) return { ok: false, reason: "not_found", message: `transaction "${fromId}" not found` };
    const to = select.get(toId) as VoidCandidate | undefined;
    if (!to) return { ok: false, reason: "not_found", message: `transaction "${toId}" not found` };

    if (from.void_of !== null) return { ok: true, alreadyVoid: true };
    if (to.void_of !== null) {
      return {
        ok: false,
        reason: "target_voided",
        message: `cannot merge into voided transaction "${toId}"`,
      };
    }

    if (
      from.amount !== to.amount ||
      from.debit_account_id !== to.debit_account_id ||
      from.credit_account_id !== to.credit_account_id
    ) {
      return {
        ok: false,
        reason: "not_mirrors",
        message: `transactions "${fromId}" and "${toId}" are not mirrors (amount and both accounts must match)`,
      };
    }

    db.prepare(`UPDATE transactions SET void_of = ? WHERE id = ?`).run(toId, fromId);
    return { ok: true, alreadyVoid: false };
  });
}

// Key order is the `transactions dedupe` wire order.
const DUPLICATE_FIELDS = [
  "id",
  "group_id",
  "date",
  "description",
  "amount",
  "currency",
  "source_file_id",
  "merchant_id",
  "debit_account_id",
  "credit_account_id",
  "debit_account_name",
  "credit_account_name",
] as const;

export type DuplicateTransactionRow = Pick<TransactionRow, (typeof DUPLICATE_FIELDS)[number]>;

/** Adjustments legitimately repeat on one account/amount/day and aren't duplicate statement rows. */
const NOT_ADJUSTMENT = `t.debit_account_id NOT LIKE '%:${STRUCTURAL_SUFFIX.adjustments}'
          AND t.credit_account_id NOT LIKE '%:${STRUCTURAL_SUFFIX.adjustments}'`;

/** Live, non-adjustment rows by date, then insertion order, which dedupe's group
 *  order and auto-merge's choice of survivor both follow. */
export function listDuplicateCandidateTransactions(db: Database.Database): DuplicateTransactionRow[] {
  const rows = db
    .prepare(`${ROW_SELECT} WHERE t.void_of IS NULL AND ${NOT_ADJUSTMENT} ORDER BY t.date, t.rowid`)
    .all() as TransactionRow[];
  return rows.map((row) => pick(row, DUPLICATE_FIELDS));
}
