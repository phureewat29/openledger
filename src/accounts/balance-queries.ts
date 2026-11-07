import type Database from "libsql";
import {
  ACCOUNT_COLUMNS_SQL,
  ACCOUNT_CURRENCY_SQL,
  type AccountRow,
  type AccountType,
} from "./queries.js";

// Leg expansion only: the normal-balance rule and decimal conversion are the caller's (src/accounts/balances.ts).

/** Debit + credit legs of every non-void transaction, one row per leg (`void_of`
 *  rows excluded so a merged mirror never double-counts). */
const TRANSACTION_LEGS = `SELECT debit_account_id  AS acct, amount, date, 'D' AS side FROM transactions WHERE void_of IS NULL
       UNION ALL
       SELECT credit_account_id AS acct, amount, date, 'C' AS side FROM transactions WHERE void_of IS NULL`;

/** Minor units per side over legs aliased `t`; 0, never NULL, for an account with no legs. */
const LEG_SUMS_SQL = `COALESCE(SUM(CASE WHEN t.side = 'D' THEN t.amount ELSE 0 END), 0) AS sum_debit,
              COALESCE(SUM(CASE WHEN t.side = 'C' THEN t.amount ELSE 0 END), 0) AS sum_credit`;

interface AccountLegSums extends AccountRow {
  /** Minor units. */
  sum_debit: number;
  /** Minor units. */
  sum_credit: number;
}

export interface AccountLegSumsOptions {
  type?: AccountType;
  /** The account itself, or any account whose parent it is. */
  idOrParent?: string;
}

/** Per-account leg sums, including accounts with no legs at all. */
export function getAccountLegSums(
  db: Database.Database,
  opts: AccountLegSumsOptions = {},
): AccountLegSums[] {
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.type) {
    where.push("a.type = ?");
    params.push(opts.type);
  }
  if (opts.idOrParent) {
    where.push("(a.id = ? OR a.parent_id = ?)");
    params.push(opts.idOrParent, opts.idOrParent);
  }
  const whereSQL = where.length ? `WHERE ${where.join(" AND ")}` : "";

  return db
    .prepare(
      `SELECT ${ACCOUNT_COLUMNS_SQL}, ${LEG_SUMS_SQL}
         FROM accounts a
         LEFT JOIN (${TRANSACTION_LEGS}) t ON t.acct = a.id
         ${whereSQL}
         GROUP BY a.id
         ORDER BY a.type, a.id`,
    )
    .all(...params) as AccountLegSums[];
}

export interface TypeCurrencyLegSums {
  type: AccountType;
  currency: string;
  sum_debit: number;
  sum_credit: number;
}

/**
 * Income and expense legs dated within `from`..`to`, summed per
 * (type, currency) so each ledger is netted and converted on its own.
 */
export function getPeriodLegSums(
  db: Database.Database,
  from: string,
  to: string,
): TypeCurrencyLegSums[] {
  return db
    .prepare(
      `SELECT a.type AS type, ${ACCOUNT_CURRENCY_SQL} AS currency, ${LEG_SUMS_SQL}
         FROM (${TRANSACTION_LEGS}) t
         JOIN accounts a ON a.id = t.acct
         WHERE t.date BETWEEN ? AND ? AND a.type IN ('income', 'expense')
         GROUP BY a.type, ${ACCOUNT_CURRENCY_SQL}`,
    )
    .all(from, to) as TypeCurrencyLegSums[];
}

/** Leg sums over `rootId` and every descendant, per (type, currency); no rows when the root does not exist. */
export function getSubtreeLegSums(db: Database.Database, rootId: string): TypeCurrencyLegSums[] {
  return db
    .prepare(
      `WITH RECURSIVE subtree(id, type) AS (
         SELECT id, type FROM accounts WHERE id = ?
         UNION ALL
         SELECT a.id, a.type FROM accounts a JOIN subtree s ON a.parent_id = s.id
       )
       SELECT a.type AS type, ${ACCOUNT_CURRENCY_SQL} AS currency, ${LEG_SUMS_SQL}
         FROM subtree a
         LEFT JOIN (${TRANSACTION_LEGS}) t ON t.acct = a.id
         GROUP BY a.type, ${ACCOUNT_CURRENCY_SQL}`,
    )
    .all(rootId) as TypeCurrencyLegSums[];
}
