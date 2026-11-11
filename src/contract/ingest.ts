import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { Summary } from "./primitives.js";
import { FileStatus } from "./files.js";
import { FILE_STATUSES } from "./enums.js";

/** One row per readable statement under the data dir, registered or not. */
export const IngestFile = z.object({
  type: z.literal("file"),
  path: z.string(),
  rel_path: z.string(),
  hash: z.string().nullable(),
  /** null until a prepare registers the file. */
  file_id: z.string().nullable(),
  status: z.enum(["new", ...FILE_STATUSES, "unreadable"]),
  encrypted: z.boolean(),
  note: z.string().nullable(),
});
export type IngestFile = z.infer<typeof IngestFile>;

export const IngestListSummary = Summary.extend({
  new: z.number().int(),
  pending: z.number().int(),
  ingested: z.number().int(),
  failed: z.number().int(),
  unreadable: z.number().int(),
  total: z.number().int(),
});
export type IngestListSummary = z.infer<typeof IngestListSummary>;

export const TextLayer = z.enum(["complete", "partial", "none"]);
export type TextLayer = z.infer<typeof TextLayer>;

export const PrepareTextPage = z.object({
  /** 1-based; cite as `source_page` on commit. */
  page: z.number().int(),
  chars: z.number().int(),
});
export type PrepareTextPage = z.infer<typeof PrepareTextPage>;

export const PrepareImagePage = z.object({
  page: z.number().int(),
  path: z.string(),
});
export type PrepareImagePage = z.infer<typeof PrepareImagePage>;

/** One `document` to read, pages separated by `--- page N ---` markers. */
export const PrepareTextResult = z.object({
  file_id: z.string(),
  kind: z.literal("text"),
  source: z.enum(["text-layer", "ocr"]),
  text_layer: TextLayer,
  page_count: z.number().int(),
  ocr_model: z.string().optional(),
  document: z.string(),
  pages: z.array(PrepareTextPage),
  /** Pages OCR lost (the reason `prepare` exits 7); the `ocr` source only, `[]` when none. */
  failed_pages: z.array(z.number().int()).optional(),
});
export type PrepareTextResult = z.infer<typeof PrepareTextResult>;

/** One image path per page, in order, for the caller to read itself. */
export const PrepareImagesResult = z.object({
  file_id: z.string(),
  kind: z.literal("images"),
  source: z.enum(["raster", "original"]),
  text_layer: TextLayer,
  page_count: z.number().int(),
  dpi: z.number().int().optional(),
  pages: z.array(PrepareImagePage),
});
export type PrepareImagesResult = z.infer<typeof PrepareImagesResult>;

export const PrepareResult = z.union([PrepareTextResult, PrepareImagesResult]);
export type PrepareResult = z.infer<typeof PrepareResult>;

export const CommitSide = z.object({
  side: z.enum(["debit", "credit"]),
  requested: z.string(),
  resolved: z.string(),
  /** `as_committed` reports what a duplicate row already holds, not this run's resolution. */
  how: z.enum([
    "exact",
    "similar_account",
    "placeholder_created",
    "uncategorized_fallback",
    "as_committed",
  ]),
  similar_to: z.string().optional(),
});
export type CommitSide = z.infer<typeof CommitSide>;

/** `unknown`: the row named a merchant id nothing here answers to. */
export const CommitMerchant = z.object({
  how: z.enum(["none", "unknown", "linked"]),
  merchant_id: z.string().optional(),
});
export type CommitMerchant = z.infer<typeof CommitMerchant>;

export const CommitLeg = z.object({
  transaction_id: z.string(),
  duplicate: z.boolean(),
});
export type CommitLeg = z.infer<typeof CommitLeg>;

/** `unexpected_error` is the batch loop's own catch-all. */
export const CommitFailureReason = z.enum([
  "dirty_input",
  "currency_mismatch",
  "unexpected_error",
]);
export type CommitFailureReason = z.infer<typeof CommitFailureReason>;

/** A refused row: nothing posted, and the raised question is the repair. */
export const CommitFailureResult = z.object({
  type: z.literal("result"),
  index: z.number().int(),
  ok: z.literal(false),
  reason: CommitFailureReason,
  message: z.string(),
  raised_questions: z.number().int(),
  /** The `currency_mismatch` repair is opening this ledger; branch on the field, never the message. */
  unopened_ledger: z.string().optional(),
});
export type CommitFailureResult = z.infer<typeof CommitFailureResult>;

/** A `linked:[...]` row: every leg posted atomically under one group id. */
export const CommitCompoundResult = z.object({
  type: z.literal("result"),
  index: z.number().int(),
  ok: z.literal(true),
  group_id: z.string(),
  legs: z.array(CommitLeg),
  /** True only when every leg was already there. */
  duplicate: z.boolean(),
  currency_overridden: z.boolean(),
  raised_questions: z.number().int(),
  merchant: CommitMerchant,
});
export type CommitCompoundResult = z.infer<typeof CommitCompoundResult>;

/** A single-pair row; compound rows carry no `sides`, their legs have their own pairs. */
export const CommitStandaloneResult = z.object({
  type: z.literal("result"),
  index: z.number().int(),
  ok: z.literal(true),
  transaction_id: z.string(),
  duplicate: z.boolean(),
  currency_overridden: z.boolean(),
  raised_questions: z.number().int(),
  merchant: CommitMerchant,
  /** Debit first, then credit. */
  sides: z.array(CommitSide),
});
export type CommitStandaloneResult = z.infer<typeof CommitStandaloneResult>;

export const CommitResult = z.union([
  CommitFailureResult,
  CommitCompoundResult,
  CommitStandaloneResult,
]);
export type CommitResult = z.infer<typeof CommitResult>;

export const CommitSummary = Summary.extend({
  /** Scope this run's questions with `questions list --batch <id>`. */
  batch_id: z.string(),
  /** Rows, not ledger transactions: a compound row counts once. */
  posted: z.number().int(),
  duplicates: z.number().int(),
  failed: z.number().int(),
  raised_questions: z.number().int(),
  /** The fields below appear only with `--file`; the counts are cumulative for that file. */
  file_id: z.string().optional(),
  file_status: FileStatus.optional(),
  file_transaction_count: z.number().int().optional(),
  file_open_question_count: z.number().int().optional(),
  hint: z.string().optional(),
});
export type CommitSummary = z.infer<typeof CommitSummary>;

export const Reconciliation = z.object({
  account: z.string(),
  closing: z.number(),
  balance: z.number(),
});
export type Reconciliation = z.infer<typeof Reconciliation>;

export const IngestDoneResult = z.object({
  file_id: z.string(),
  status: z.literal("ingested"),
  cache_removed: z.array(z.string()),
  /** Only when `--account` and `--closing-balance` were both given. */
  reconciliation: Reconciliation.optional(),
});
export type IngestDoneResult = z.infer<typeof IngestDoneResult>;

export const IngestFailResult = z.object({
  file_id: z.string(),
  status: z.literal("failed"),
  cache_removed: z.array(z.string()),
});
export type IngestFailResult = z.infer<typeof IngestFailResult>;

export const INGEST_CONTRACTS = {
  "ingest list": { lines: [IngestFile, IngestListSummary], summary: "plain" },
  "ingest prepare": { lines: [PrepareTextResult, PrepareImagesResult] },
  "ingest commit": {
    lines: [CommitFailureResult, CommitCompoundResult, CommitStandaloneResult, CommitSummary],
    summary: "plain",
  },
  "ingest done": { lines: [IngestDoneResult] },
  "ingest fail": { lines: [IngestFailResult] },
} as const satisfies Record<string, CommandContract>;
