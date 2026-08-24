import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { Summary } from "./primitives.js";

// Mirrors FILE_STATUSES in db/queries/files.ts (duplicated to keep the contract a leaf);
// `ingest list`'s extra states are display-only, never stored.
export const FileStatus = z.enum(["pending", "ingested", "failed"]);
export type FileStatus = z.infer<typeof FileStatus>;

export const FileRecord = z.object({
  id: z.string(),
  path: z.string(),
  file_hash: z.string(),
  mime: z.string(),
  status: FileStatus,
  /** null until `ingest done` closes the file; a failed file never gets one. */
  ingested_at: z.iso.datetime().nullable(),
  source: z.string().nullable(),
  /** `ingest fail --error`'s text, and null on every other status. */
  error: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export type FileRecord = z.infer<typeof FileRecord>;

export const FilesListSummary = Summary.extend({
  total: z.number().int(),
  returned: z.number().int(),
  /** Present only when nothing is registered: `ingest list` is where new statements appear. */
  hint: z.string().optional(),
});
export type FilesListSummary = z.infer<typeof FilesListSummary>;

export const FileDetail = FileRecord.extend({
  type: z.literal("file_detail"),
  transaction_count: z.number().int(),
  open_question_count: z.number().int(),
});
export type FileDetail = z.infer<typeof FileDetail>;

export const FileDropResult = z.object({
  file_id: z.string(),
  removed_transactions: z.number().int(),
  removed_questions: z.number().int(),
  /** Mirrors in other files whose `void_of` pointed here; the cascade un-voided them. */
  unvoided: z.number().int(),
  cache_removed: z.array(z.string()),
});
export type FileDropResult = z.infer<typeof FileDropResult>;

export const FILES_CONTRACTS = {
  "files list": { lines: [FileRecord, FilesListSummary], summary: "plain" },
  "files show": { lines: [FileDetail] },
  "files drop": { lines: [FileDropResult] },
} as const satisfies Record<string, CommandContract>;
