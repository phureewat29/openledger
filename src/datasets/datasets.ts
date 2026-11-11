import * as z from "zod";
import { memoize, uniq } from "es-toolkit";
import { loadDatasetRows, type DatasetDefinition, type DatasetRow } from "./loader.js";
import { INSTITUTION_KINDS } from "../contract/enums.js";

const institutionSchema = z.object({
  code: z.string(),
  label: z.string(),
  kind: z.enum(INSTITUTION_KINDS),
  notes: z.string().optional(),
});

export const institutionsFileSchema = z.object({
  country: z.string(),
  institutions: z.array(institutionSchema).optional(),
});

export const institutionsDataset: DatasetDefinition<z.infer<typeof institutionsFileSchema>> = {
  schema: institutionsFileSchema,
  flatten: (file) => file.institutions ?? [],
  sortKey: (row) => String(row.code ?? ""),
  kinds: INSTITUTION_KINDS,
};

// Locale + currency read from the top level of `datasets/<cc>.json`.

const countryDefaultsSchema = z.object({
  country: z.string(),
  locale: z.string(),
  currency: z.string(),
});

type CountryDefaults = z.infer<typeof countryDefaultsSchema>;

const defaultsDataset: DatasetDefinition<CountryDefaults> = {
  schema: countryDefaultsSchema,
  // `country` is re-added by the loader (uppercased); the row carries only the display fields here.
  flatten: (file) => [{ locale: file.locale, currency: file.currency }],
  sortKey: (row) => row.country,
};

function all(): readonly CountryDefaults[] {
  return loadDatasetRows(defaultsDataset) as unknown as readonly CountryDefaults[];
}

/** Case-insensitive lookup; null when the country has no defaults. */
export function findCountryDefaults(country: string): CountryDefaults | null {
  const cc = country.toUpperCase();
  return all().find((r) => r.country === cc) ?? null;
}

/** Uppercased country codes that have defaults, sorted, for "unknown country" hints. */
export function availableCountries(): string[] {
  return all().map((r) => r.country);
}

/** Place words only, seen on a real statement; `normalizeDescriptor` (src/merchants/queries.ts) owns the locale-free half and strips both together. */
const noiseFileSchema = z.object({
  country: z.string(),
  noise: z.array(z.string()).optional(),
});

type NoiseFile = z.infer<typeof noiseFileSchema>;

const noiseDataset: DatasetDefinition<NoiseFile> = {
  schema: noiseFileSchema,
  flatten: (file) => (file.noise ?? []).map((token) => ({ token })),
  sortKey: (row) => String(row.token ?? ""),
};

const noiseTokensOf = memoize((cc: string): readonly string[] =>
  loadDatasetRows(noiseDataset)
    .filter((row) => row.country === cc)
    .map((row) => String(row.token)),
);

export function noiseTokens(country: string): readonly string[] {
  return noiseTokensOf(country.toUpperCase());
}

// `any` only erases each entry's own concrete `DatasetDefinition<...>` file shape, which the registry doesn't need.
const REGISTRY = {
  institutions: institutionsDataset,
  defaults: defaultsDataset,
  noise: noiseDataset,
} satisfies Record<string, DatasetDefinition<any>>;

export type DatasetName = keyof typeof REGISTRY;

function definition(name: DatasetName): DatasetDefinition<any> {
  return REGISTRY[name];
}

export function isDatasetName(name: string): name is DatasetName {
  return Object.hasOwn(REGISTRY, name);
}

export function listDatasetNames(): DatasetName[] {
  return Object.keys(REGISTRY) as DatasetName[];
}

/** Drives the CLI `--kind` guard. */
export function datasetHasKinds(name: DatasetName): boolean {
  return !!definition(name).kinds;
}

export interface DatasetSummary {
  name: DatasetName;
  countries: string[];
  rows: number;
}

export function listDatasets(): DatasetSummary[] {
  return listDatasetNames().map((name) => {
    const rows = loadDatasetRows(definition(name));
    const countries = uniq(rows.map((r) => r.country)).sort();
    return { name, countries, rows: rows.length };
  });
}

export function readDataset(
  name: DatasetName,
  filter: { country?: string; kind?: string } = {},
): DatasetRow[] {
  const country = filter.country?.toUpperCase();
  const { kind } = filter;
  return loadDatasetRows(definition(name)).filter(
    (r) => (!country || r.country === country) && (!kind || r.kind === kind),
  );
}
