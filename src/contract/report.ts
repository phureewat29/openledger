import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { CurrencyTotals } from "./primitives.js";

export const ReportResult = z.object({
  from: z.string(),
  to: z.string(),
  income: CurrencyTotals,
  expenses: CurrencyTotals,
  // Minor units are netted per currency before converting to decimal, so a THB income
  // and a USD expense never collapse into one number.
  net: CurrencyTotals,
});
export type ReportResult = z.infer<typeof ReportResult>;

export const REPORT_CONTRACTS = {
  report: { lines: [ReportResult] },
} as const satisfies Record<string, CommandContract>;
