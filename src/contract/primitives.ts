import * as z from "zod";

/** Never a scalar: two currencies share no total; keys are ISO codes. */
export const CurrencyTotals = z.record(z.string(), z.number());
export type CurrencyTotals = z.infer<typeof CurrencyTotals>;

/** The terminal `{"type":"summary",...}` line a streaming command ends with. */
export const Summary = z.object({
  type: z.literal("summary"),
});
export type Summary = z.infer<typeof Summary>;

/** The shared base of every capped list's summary; commands `.extend(...)` their own fields onto it. */
export const CappedSummary = Summary.extend({
  total: z.number().int(),
  returned: z.number().int(),
  has_more: z.boolean(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type CappedSummary = z.infer<typeof CappedSummary>;
