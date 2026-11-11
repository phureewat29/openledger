import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { Summary } from "./primitives.js";
import { INSTITUTION_KINDS } from "./enums.js";

export const DatasetsSummaryRow = z.object({
  name: z.string(),
  countries: z.array(z.string()),
  rows: z.number().int(),
});
export type DatasetsSummaryRow = z.infer<typeof DatasetsSummaryRow>;

export const DatasetsInstitutionRow = z.object({
  code: z.string(),
  label: z.string(),
  kind: z.enum(INSTITUTION_KINDS),
  notes: z.string().optional(),
  country: z.string(),
});
export type DatasetsInstitutionRow = z.infer<typeof DatasetsInstitutionRow>;

export const DatasetsDefaultsRow = z.object({
  country: z.string(),
  locale: z.string(),
  currency: z.string(),
});
export type DatasetsDefaultsRow = z.infer<typeof DatasetsDefaultsRow>;

export const DatasetsNoiseRow = z.object({
  token: z.string(),
  country: z.string(),
});
export type DatasetsNoiseRow = z.infer<typeof DatasetsNoiseRow>;

export const DatasetsListSummary = Summary.extend({
  returned: z.number().int(),
});
export type DatasetsListSummary = z.infer<typeof DatasetsListSummary>;

export const DATASETS_CONTRACTS = {
  datasets: {
    lines: [
      DatasetsSummaryRow,
      DatasetsInstitutionRow,
      DatasetsDefaultsRow,
      DatasetsNoiseRow,
      DatasetsListSummary,
    ],
    summary: "plain",
  },
} as const satisfies Record<string, CommandContract>;
