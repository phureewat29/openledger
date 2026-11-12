import { groupBy, mapValues, partition } from "es-toolkit";
import type Database from "libsql";
import { findAccountById, type AccountRow, type AccountType } from "./queries.js";
import {
  getAccountLegSums,
  getPeriodLegSums,
  getSubtreeLegSums,
  type AccountLegSumsOptions,
  type TypeCurrencyLegSums,
} from "./balance-queries.js";
import {
  insertTransaction,
  validateTransaction,
  type TransactionInput,
} from "../transactions/queries.js";
import { inTransaction } from "../db/transaction.js";
import { currencyOf } from "../lib/ids.js";
import { fromMinorUnits, toMinorUnits } from "../lib/money.js";
/** Per-currency sums in minor units; the contract's CurrencyTotals carries decimals. */
export type MinorTotals = Record<string, number>;
import { ensureStructuralAccount, structuralAccountId } from "./accounts.js";

export interface AccountBalanceMinor extends AccountRow {
  /** Minor units. */
  debits_posted: number;
  /** Minor units. */
  credits_posted: number;
  balance_minor: number;
  balance: number;
}

// Minor units; the CLI converts with `toDecimalTotals`.
interface NetWorth {
  assets: MinorTotals;
  liabilities: MinorTotals;
  net_worth: MinorTotals;
}

interface PeriodTotals {
  income: MinorTotals;
  expenses: MinorTotals;
}

function addMinor(totals: MinorTotals, currency: string, minor: number): void {
  totals[currency] = (totals[currency] ?? 0) + minor;
}

function sumTotals(maps: MinorTotals[]): MinorTotals {
  const totals: MinorTotals = {};
  for (const map of maps) {
    for (const [currency, minor] of Object.entries(map)) addMinor(totals, currency, minor);
  }
  return totals;
}

/** Per-currency `a - b` over the union of both key sets; nothing collapses across keys. */
export function subtractTotals(a: MinorTotals, b: MinorTotals): MinorTotals {
  return sumTotals([a, mapValues(b, (minor) => -minor)]);
}

/** Normal-balance rule: asset/expense are debit-normal, others credit-normal. */
function isDebitNormal(type: AccountType): boolean {
  return ["asset", "expense"].includes(type);
}

/** Signed balance in minor units, from the account type's normal side. */
function balanceMinor(type: AccountType, sumDebit: number, sumCredit: number): number {
  return isDebitNormal(type) ? sumDebit - sumCredit : sumCredit - sumDebit;
}

/** Each (type, currency) row's normal-side balance, added per currency. */
function totalsOf(rows: TypeCurrencyLegSums[]): MinorTotals {
  const totals: MinorTotals = {};
  for (const r of rows) addMinor(totals, r.currency, balanceMinor(r.type, r.sum_debit, r.sum_credit));
  return totals;
}

/** `balance` is the decimal of `balance_minor` under the account's own currency exponent. */
export function getAccountBalances(
  db: Database.Database,
  opts: AccountLegSumsOptions = {},
): AccountBalanceMinor[] {
  return getAccountLegSums(db, opts).map(({ sum_debit, sum_credit, ...account }) => {
    const balance_minor = balanceMinor(account.type, sum_debit, sum_credit);
    return {
      ...account,
      debits_posted: sum_debit,
      credits_posted: sum_credit,
      balance_minor,
      balance: fromMinorUnits(balance_minor, account.currency),
    };
  });
}

/** One account's own signed balance in minor units, excluding its children;
 *  null when the account does not exist. */
export function getAccountBalanceMinor(db: Database.Database, accountId: string): number | null {
  const own = getAccountBalances(db, { idOrParent: accountId }).find((a) => a.id === accountId);
  return own?.balance_minor ?? null;
}

export function getNetWorth(db: Database.Database): NetWorth {
  const assets: MinorTotals = {};
  const liabilities: MinorTotals = {};
  for (const b of getAccountBalances(db)) {
    if (b.type === "asset") addMinor(assets, b.currency, b.balance_minor);
    else if (b.type === "liability") addMinor(liabilities, b.currency, b.balance_minor);
  }
  return { assets, liabilities, net_worth: subtractTotals(assets, liabilities) };
}

export function getPeriodTotals(
  db: Database.Database,
  from: string,
  to: string,
): PeriodTotals {
  const rows = getPeriodLegSums(db, from, to);
  return {
    income: totalsOf(rows.filter((r) => r.type === "income")),
    expenses: totalsOf(rows.filter((r) => r.type === "expense")),
  };
}

/** Single-currency by the id grammar, but derived here, not assumed. */
export function getRollupBalance(db: Database.Database, rootId: string): MinorTotals {
  return totalsOf(getSubtreeLegSums(db, rootId));
}

export interface BalanceTreeNode {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  balance_minor: number;
  /** This account's balance plus every descendant's. */
  rollup: MinorTotals;
  children: BalanceTreeNode[];
}

function treeNode(
  row: AccountBalanceMinor,
  childrenByParent: Record<string, AccountBalanceMinor[]>,
): BalanceTreeNode {
  const children = (childrenByParent[row.id] ?? []).map((child) =>
    treeNode(child, childrenByParent),
  );
  const rollup = sumTotals([
    ...children.map((child) => child.rollup),
    { [row.currency]: row.balance_minor },
  ]);
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    currency: row.currency,
    balance_minor: row.balance_minor,
    rollup,
    children,
  };
}

/** A row whose parent is outside the selection becomes a root here. */
export function getBalanceTree(
  db: Database.Database,
  opts: AccountLegSumsOptions = {},
): BalanceTreeNode[] {
  const rows = getAccountBalances(db, opts);
  const selected = new Set(rows.map((r) => r.id));
  const [children, roots] = partition(rows, (r) => !!r.parent_id && selected.has(r.parent_id));
  // Every account id carries a colon, so no key here collides with Object.prototype.
  const childrenByParent = groupBy(children, (r) => r.parent_id!);
  return roots.map((row) => treeNode(row, childrenByParent));
}

interface AdjustAccountBalanceOpts {
  accountId: string;
  /** New desired balance in the account's currency, decimal, natural sign. */
  targetAmount: number;
  reason: string;
  /** ISO YYYY-MM-DD. */
  date: string;
}

export type AdjustBalanceFailure = "not_found" | "balancing_account" | "invalid_transaction";

type AdjustAccountBalanceOutcome =
  | {
      ok: true;
      /** Id of the balancing transaction, or null when already at target (no-op). */
      transactionId: string | null;
      /** target - current, decimal, natural sign. 0 on no-op. */
      delta: number;
    }
  | { ok: false; reason: AdjustBalanceFailure; message: string };

/**
 * Ledger comes from the target account, never config; delta math is integer
 * minor units. The balance is read under the write lock, so a concurrent
 * write can't move it between the read and the balancing entry.
 */
export function adjustAccountBalance(
  db: Database.Database,
  opts: AdjustAccountBalanceOpts,
): AdjustAccountBalanceOutcome {
  return inTransaction(db, (): AdjustAccountBalanceOutcome => {
    const account = findAccountById(db, opts.accountId);
    if (!account) return { ok: false, reason: "not_found", message: `Account "${opts.accountId}" not found.` };

    const currency = currencyOf(account.id);
    const adjustmentsId = structuralAccountId(currency, "adjustments");
    if (account.id === adjustmentsId) {
      return {
        ok: false,
        reason: "balancing_account",
        message:
          `Account "${adjustmentsId}" is the balancing side of every adjustment on its own ledger, ` +
          "so adjusting it would need both legs on one account. Adjust the account that is wrong instead.",
      };
    }

    const currentMinor = getAccountBalanceMinor(db, account.id) ?? 0;
    const targetMinor = toMinorUnits(opts.targetAmount, currency);
    const deltaMinor = targetMinor - currentMinor;
    if (deltaMinor === 0) return { ok: true, transactionId: null, delta: 0 };

    const debitNormal = isDebitNormal(account.type);
    const accountIsDebit = (debitNormal && deltaMinor > 0) || (!debitNormal && deltaMinor < 0);
    const entry: TransactionInput = {
      date: opts.date,
      description: (opts.reason || "Balance adjustment").trim(),
      debit_account_id: accountIsDebit ? account.id : adjustmentsId,
      credit_account_id: accountIsDebit ? adjustmentsId : account.id,
      amount: Math.abs(deltaMinor),
    };
    const check = validateTransaction(entry);
    if (!check.ok) return check;

    ensureStructuralAccount(db, currency, "adjustments");
    const { id } = insertTransaction(db, entry);
    return { ok: true, transactionId: id, delta: fromMinorUnits(deltaMinor, currency) };
  });
}
