import type Database from "libsql";
import { sortBy, sumBy } from "es-toolkit";
import {
  listDuplicateCandidateTransactions,
  voidTransactionAsMirror,
  type DuplicateTransactionRow,
} from "./queries.js";
import { clusterDuplicateCandidates } from "../ingest/clustering.js";

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
      const { alreadyVoid } = voidTransactionAsMirror(db, cand.id, head.id);
      if (!alreadyVoid) merged++;
    }
  }
  return merged;
}
