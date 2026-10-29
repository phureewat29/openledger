import type Database from "libsql";
import { groupBy, range, sortBy, sumBy } from "es-toolkit";
import {
  listDuplicateCandidateTransactions,
  voidTransactionAsMirror,
  type DuplicateTransactionRow,
} from "./queries.js";

/** Candidate duplicates share an amount and an account pair. */
export function bucketDuplicateCandidates(
  rows: DuplicateTransactionRow[],
): DuplicateTransactionRow[][] {
  const buckets = groupBy(rows, (r) => `${r.amount}|${r.debit_account_id}|${r.credit_account_id}`);
  return Object.values(buckets);
}

/** Two rows join a component when within `toleranceDays` and not already
 *  sharing a group_id. Components chain transitively. */
export function proximityComponents(
  bucket: DuplicateTransactionRow[],
  toleranceDays: number,
): DuplicateTransactionRow[][] {
  const n = bucket.length;
  const parent = range(n);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = bucket[i];
      const b = bucket[j];
      if (dayDiff(a.date, b.date) > toleranceDays) continue;
      if (a.group_id && b.group_id && a.group_id === b.group_id) continue;
      union(i, j);
    }
  }

  // Not groupBy: a Record hoists the numeric root keys into ascending order,
  // while cluster order on the wire must follow first appearance.
  const comps = new Map<number, DuplicateTransactionRow[]>();
  bucket.forEach((row, i) => {
    const root = find(i);
    const rows = comps.get(root) ?? [];
    rows.push(row);
    comps.set(root, rows);
  });
  return [...comps.values()];
}

/** Whole-day distance between two ISO dates; +Infinity on unparseable input. */
export function dayDiff(a: string, b: string): number {
  const aDate = Date.parse(a);
  const bDate = Date.parse(b);
  if (Number.isNaN(aDate) || Number.isNaN(bDate)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((bDate - aDate) / 86_400_000));
}

/** Keeps only components of size >= 2; a lone candidate isn't a duplicate. */
export function clusterDuplicateCandidates(
  rows: DuplicateTransactionRow[],
  toleranceDays: number,
): DuplicateTransactionRow[][] {
  const groups: DuplicateTransactionRow[][] = [];
  for (const bucket of bucketDuplicateCandidates(rows)) {
    if (bucket.length < 2) continue;
    for (const comp of proximityComponents(bucket, toleranceDays)) {
      if (comp.length >= 2) groups.push(comp);
    }
  }
  return groups;
}

interface FindDuplicateTransactionsOptions {
  /** Day slack when grouping by date. 0 = same-day only. Default 2: the same
   *  transaction can reach the ledger from two sources dated a day or two
   *  apart (one by posting, one by value), which same-day-only would miss. */
  toleranceDays?: number;
  /** Skip transactions below this amount (minor units). */
  minAmount?: number;
}

/**
 * Rows sharing a non-null group_id never match each other (a salary's legs
 * aren't duplicates); returns components of size >= 2.
 */
export function findDuplicateTransactions(
  db: Database.Database,
  opts: FindDuplicateTransactionsOptions = {},
): DuplicateTransactionRow[][] {
  const toleranceDays = Math.max(0, Math.floor(opts.toleranceDays ?? 2));
  const rows = listDuplicateCandidateTransactions(db, { minAmount: opts.minAmount });
  return clusterDuplicateCandidates(rows, toleranceDays);
}

/** Voids cross-statement mirrors into the earliest transaction, never deletes:
 *  a delete's `void_of` self-FK (ON DELETE SET NULL) would un-void an
 *  already-voided mirror. */
export function autoMergeStrictDuplicateTransactions(db: Database.Database): { merged: number } {
  const merged = sumBy(findDuplicateTransactions(db), (group) => autoMergeStrictGroup(db, group));
  return { merged };
}

/** One cluster: how many of its rows were voided into the earliest. */
function autoMergeStrictGroup(db: Database.Database, group: DuplicateTransactionRow[]): number {
  const sorted = sortBy(group, ["date", "id"]);
  const head = sorted[0];
  if (!head.merchant_id || !head.source_file_id) return 0;

  // Two contenders from one statement make every pairing a guess, and the wrong
  // guess voids a real purchase. `transactions dedupe` still lists them.
  const contenders = sorted.filter(
    (r) => r.date === head.date && r.amount === head.amount && r.merchant_id === head.merchant_id,
  );
  if (new Set(contenders.map((r) => r.source_file_id)).size !== contenders.length) return 0;

  let merged = 0;
  for (let i = 1; i < sorted.length; i++) {
    const cand = sorted[i];
    if (
      cand.merchant_id === head.merchant_id &&
      !!cand.source_file_id &&
      cand.source_file_id !== head.source_file_id &&
      cand.date === head.date &&
      cand.amount === head.amount
    ) {
      const voided = voidTransactionAsMirror(db, cand.id, head.id);
      // The bucket key (amount and both accounts) already made these mirrors.
      if (!voided.ok) throw new Error(voided.message);
      if (!voided.alreadyVoid) merged++;
    }
  }
  return merged;
}
