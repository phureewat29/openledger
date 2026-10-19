import * as z from "zod";
import { memoize, uniq } from "es-toolkit";
import { loadDatasetRows, type DatasetDefinition, type DatasetRow } from "./loader.js";

const INSTITUTION_KINDS = [
  "bank",
  "card_issuer",
  "wallet",
  "payment_rail",
  "broker",
  "crypto_exchange",
  "insurer",
  "gov",
  "telco",
  "utility",
] as const;

const institutionSchema = z.object({
  code: z.string(),
  label: z.string(),
  kind: z.enum(INSTITUTION_KINDS),
  notes: z.string().optional(),
});

export const countryFileSchema = z.object({
  country: z.string(),
  institutions: z.array(institutionSchema).optional(),
});

export const institutionsDataset: DatasetDefinition<z.infer<typeof countryFileSchema>> = {
  schema: countryFileSchema,
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

export const defaultsDataset: DatasetDefinition<CountryDefaults> = {
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

export const noiseDataset: DatasetDefinition<NoiseFile> = {
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
const REGISTRY: Record<string, DatasetDefinition<any>> = {
  institutions: institutionsDataset,
  defaults: defaultsDataset,
  noise: noiseDataset,
};

export function listDatasetNames(): string[] {
  return Object.keys(REGISTRY);
}

/** Drives the CLI `--kind` guard. */
export function datasetHasKinds(name: string): boolean {
  return !!REGISTRY[name]?.kinds;
}

export interface DatasetSummary {
  name: string;
  countries: string[];
  rows: number;
}

export function listDatasets(): DatasetSummary[] {
  return Object.entries(REGISTRY).map(([name, def]) => {
    const rows = loadDatasetRows(def);
    const countries = uniq(rows.map((r) => r.country)).sort();
    return { name, countries, rows: rows.length };
  });
}

/** Throws on an unknown name: the CLI validates the name first for a clean error. */
export function readDataset(
  name: string,
  filter: { country?: string; kind?: string } = {},
): DatasetRow[] {
  const def = REGISTRY[name];
  if (!def) throw new Error(`unknown dataset "${name}"`);
  const country = filter.country?.toUpperCase();
  const { kind } = filter;
  return loadDatasetRows(def).filter(
    (r) => (!country || r.country === country) && (!kind || r.kind === kind),
  );
}
