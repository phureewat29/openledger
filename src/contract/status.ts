import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { CONTRACT_VERSION } from "./version.js";
import { CurrencyTotals } from "./primitives.js";

export const StatusDb = z.object({
  path: z.string(),
  reachable: z.boolean(),
  error: z.string().nullable(),
});
export type StatusDb = z.infer<typeof StatusDb>;

export const StatusCounts = z.object({
  accounts: z.number().int(),
  transactions: z.number().int(),
  merchants: z.number().int(),
  notes: z.number().int(),
});
export type StatusCounts = z.infer<typeof StatusCounts>;

export const StatusFileCounts = z.object({
  new: z.number().int(),
  ingested: z.number().int(),
  pending: z.number().int(),
  failed: z.number().int(),
});
export type StatusFileCounts = z.infer<typeof StatusFileCounts>;

export const StatusQuestionCounts = z.object({
  open: z.number().int(),
  deferred: z.number().int(),
});
export type StatusQuestionCounts = z.infer<typeof StatusQuestionCounts>;

export const StatusNetWorth = z.object({
  assets: CurrencyTotals,
  liabilities: CurrencyTotals,
  net_worth: CurrencyTotals,
});
export type StatusNetWorth = z.infer<typeof StatusNetWorth>;

/** `oled status --json`. `contract_version` pins this exact shape; it bumps on any wire change. */
export const StatusReport = z.object({
  type: z.literal("status"),
  contract_version: z.literal(CONTRACT_VERSION),
  version: z.string(),
  configured: z.boolean(),
  config_path: z.string(),
  // Non-null only for the default profile: a named --config that fails is refused first.
  config_problem: z.string().nullable(),
  data_dir: z.string(),
  locale: z.string(),
  currency: z.string(),
  user_name: z.string(),
  db: StatusDb,
  counts: StatusCounts.nullable(),
  // `new` counts unregistered data-dir files: the work-waiting signal.
  files: StatusFileCounts,
  questions: StatusQuestionCounts.nullable(),
  // Keyed per currency with an asset or liability account; an untouched ledger reports {"THB":0}.
  net_worth: StatusNetWorth.nullable(),
});
export type StatusReport = z.infer<typeof StatusReport>;

export const STATUS_CONTRACTS = {
  status: { lines: [StatusReport] },
} as const satisfies Record<string, CommandContract>;
