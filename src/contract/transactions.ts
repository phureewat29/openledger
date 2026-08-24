import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { CappedSummary, Summary } from "./primitives.js";

/** The wire row: decimal `amount`, free text redacted by default. Shared by `list`,
 *  its `--group` clusters, and `show`. */
export const TransactionView = z.object({
  id: z.string(),
  group_id: z.string().nullable(),
  date: z.iso.date(),
  description: z.string(),
  merchant_id: z.string().nullable(),
  raw_descriptor: z.string().nullable(),
  source_file_id: z.string().nullable(),
  source_page: z.number().int().nullable(),
  debit_account_id: z.string(),
  credit_account_id: z.string(),
  amount: z.number(),
  currency: z.string(),
  void_of: z.string().nullable(),
  created_at: z.iso.datetime(),
  debit_account_name: z.string().nullable(),
  credit_account_name: z.string().nullable(),
  merchant_name: z.string().nullable(),
});
export type TransactionView = z.infer<typeof TransactionView>;

/** One line per group; a null group_id is its own singleton cluster. */
export const TransactionClusterView = z.object({
  group_id: z.string().nullable(),
  transactions: z.array(TransactionView),
});
export type TransactionClusterView = z.infer<typeof TransactionClusterView>;

/** The row, plus every group sibling (itself included) when it has one. */
export const TransactionShowView = TransactionView.extend({
  group: z.array(TransactionView).optional(),
});
export type TransactionShowView = z.infer<typeof TransactionShowView>;

/** `transactions add` without `--resolve`: both accounts must already exist. */
export const TransactionAddResult = z.object({
  transaction_id: z.string(),
  duplicate: z.boolean(),
});
export type TransactionAddResult = z.infer<typeof TransactionAddResult>;

/**
 * `transactions add --resolve`: resolves accounts the way `ingest commit` does,
 * so it may auto-create placeholders and raise questions instead of failing.
 */
export const TransactionAddResolveResult = TransactionAddResult.extend({
  raised_questions: z.number().int(),
  currency_overridden: z.boolean(),
});
export type TransactionAddResolveResult = z.infer<typeof TransactionAddResolveResult>;

export const TransactionUpdateResult = z.object({
  transaction_id: z.string(),
  updated: z.literal(true),
});
export type TransactionUpdateResult = z.infer<typeof TransactionUpdateResult>;

export const TransactionDeleteResult = z.object({
  transaction_id: z.string(),
  deleted: z.literal(true),
  /** Mirrors un-voided because the surviving twin they pointed at was just deleted. */
  unvoided: z.number().int(),
});
export type TransactionDeleteResult = z.infer<typeof TransactionDeleteResult>;

export const TransactionRecategorizeResult = z.object({
  affected: z.number().int(),
  skipped_self_transaction: z.number().int(),
  skipped_currency_mismatch: z.number().int(),
  /** First 10 affected ids only; `affected` is the true count. */
  sample_transaction_ids: z.array(z.string()),
});
export type TransactionRecategorizeResult = z.infer<typeof TransactionRecategorizeResult>;

/** A duplicate candidate; `group` is its 0-based cluster index. */
export const TransactionDuplicateRow = z.object({
  id: z.string(),
  group_id: z.string().nullable(),
  date: z.iso.date(),
  description: z.string(),
  amount: z.number(),
  currency: z.string(),
  source_file_id: z.string().nullable(),
  merchant_id: z.string().nullable(),
  debit_account_id: z.string(),
  credit_account_id: z.string(),
  debit_account_name: z.string().nullable(),
  credit_account_name: z.string().nullable(),
  group: z.number().int(),
});
export type TransactionDuplicateRow = z.infer<typeof TransactionDuplicateRow>;

export const TransactionDedupeSummary = Summary.extend({
  groups: z.number().int(),
  /** Present only when `--auto-merge` ran. */
  auto_merged: z.number().int().optional(),
  /** Present only when nothing was auto-merged and groups remain to resolve by hand. */
  hint: z.string().optional(),
});
export type TransactionDedupeSummary = z.infer<typeof TransactionDedupeSummary>;

export const TransactionMergeResult = z.object({
  from: z.string(),
  to: z.string(),
  voided: z.literal(true),
});
export type TransactionMergeResult = z.infer<typeof TransactionMergeResult>;

/** The no-op shape: `--from` was already void. */
export const TransactionMergeAlreadyVoidResult = z.object({
  from: z.string(),
  to: z.string(),
  voided: z.literal(false),
  already_void: z.literal(true),
});
export type TransactionMergeAlreadyVoidResult = z.infer<typeof TransactionMergeAlreadyVoidResult>;

export const TRANSACTIONS_CONTRACTS = {
  "transactions list": {
    lines: [TransactionView, TransactionClusterView, CappedSummary],
    summary: "capped",
  },
  "transactions show": { lines: [TransactionShowView] },
  "transactions add": { lines: [TransactionAddResult, TransactionAddResolveResult] },
  "transactions update": { lines: [TransactionUpdateResult] },
  "transactions delete": { lines: [TransactionDeleteResult] },
  "transactions recategorize": { lines: [TransactionRecategorizeResult] },
  "transactions dedupe": {
    lines: [TransactionDuplicateRow, TransactionDedupeSummary],
    summary: "plain",
  },
  "transactions merge": { lines: [TransactionMergeResult, TransactionMergeAlreadyVoidResult] },
} as const satisfies Record<string, CommandContract>;
