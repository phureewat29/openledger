import type Database from "libsql";
import { groupBy, range, sortBy, sum } from "es-toolkit";
import { inTransaction } from "../db/transaction.js";
import {
  listDuplicateCandidateTransactions,
  voidTransactionAsMirror,
  type DuplicateTransactionRow,
} from "./queries.js";

/** One transaction can reach the ledger from two sources a day or two apart (posting vs value date). */
const TOLERANCE_DAYS = 2;

/** Candidate duplicates share an amount and an account pair. */
export function bucketDuplicateCandidates(
  rows: DuplicateTransactionRow[],
): DuplicateTransactionRow[][] {
  const buckets = groupBy(rows, (r) => `${r.amount}|${r.debit_account_id}|${r.credit_account_id}`);
  return Object.values(buckets);
}

/** Two rows join a component when within `TOLERANCE_DAYS` and not sharing a group_id
 *  (a split's legs aren't duplicates). Components chain transitively. */
export function proximityComponents(bucket: DuplicateTransactionRow[]): DuplicateTransactionRow[][] {
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
    parent[find(a)] = find(b);
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = bucket[i];
      const b = bucket[j];
      if (dayDiff(a.date, b.date) > TOLERANCE_DAYS) continue;
      if (a.group_id && a.group_id === b.group_id) continue;
      union(i, j);
    }
  }

  // Prefixed: a Record hoists integer-like keys, and components must keep first-appearance order.
  return Object.values(groupBy(bucket, (_row, i) => `root:${find(i)}`));
}

/** Whole-day distance between two ISO dates; +Infinity on unparseable input. */
export function dayDiff(a: string, b: string): number {
  const aDate = Date.parse(a);
  const bDate = Date.parse(b);
  if (Number.isNaN(aDate) || Number.isNaN(bDate)) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((bDate - aDate) / 86_400_000));
}

/** A lone candidate isn't a duplicate, so only components of two or more survive. */
export function clusterDuplicateCandidates(
  rows: DuplicateTransactionRow[],
): DuplicateTransactionRow[][] {
  return bucketDuplicateCandidates(rows)
    .flatMap((bucket) => proximityComponents(bucket))
    .filter((component) => component.length >= 2);
}

export function findDuplicateTransactions(db: Database.Database): DuplicateTransactionRow[][] {
  return clusterDuplicateCandidates(listDuplicateCandidateTransactions(db));
}

/**
 * Voids cross-statement mirrors into the earliest transaction, never deletes:
 * a delete's `void_of` self-FK (ON DELETE SET NULL) would un-void an
 * already-voided mirror. Candidates are read under the voids' own lock, so the
 * strict rule still holds for every row it voids.
 */
export function autoMergeStrictDuplicateTransactions(db: Database.Database): { merged: number } {
  return inTransaction(db, () => {
    const voided = findDuplicateTransactions(db).map((group) => autoMergeStrictGroup(db, group));
    return { merged: sum(voided) };
  });
}

/** One cluster: how many of its rows were voided into the earliest. */
function autoMergeStrictGroup(db: Database.Database, group: DuplicateTransactionRow[]): number {
  // Stable: same-day rows keep the candidate query's insertion order.
  const sorted = sortBy(group, ["date"]);
  const head = sorted[0];
  if (!head.merchant_id || !head.source_file_id) return 0;

  // Two contenders from one statement make every pairing a guess, and the wrong
  // guess voids a real purchase. `transactions dedupe` still lists them.
  const contenders = sorted.filter(
    (r) => r.date === head.date && r.amount === head.amount && r.merchant_id === head.merchant_id,
  );
  if (new Set(contenders.map((r) => r.source_file_id)).size !== contenders.length) return 0;

  const mirrors = contenders.slice(1).filter((r) => r.source_file_id);
  const voided = mirrors.map((mirror) => voidIntoHead(db, mirror.id, head.id));
  return sum(voided);
}

/** 1 when this call voided the mirror, 0 when it already was. */
function voidIntoHead(db: Database.Database, mirrorId: string, headId: string): number {
  const voided = voidTransactionAsMirror(db, mirrorId, headId);
  // The bucket key (amount and both accounts) already made these mirrors.
  if (!voided.ok) throw new Error(voided.message);
  return voided.alreadyVoid ? 0 : 1;
}
