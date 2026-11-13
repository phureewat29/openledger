/** Loader for the shipped reference datasets: one `<cc>.json` per country under `datasets/`; dataset-specific shape lives in datasets.ts. */

import * as z from "zod";
import { memoize } from "es-toolkit";
import { tryExecute } from "../lib/result.js";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Two levels below the package root under both tsx (src/datasets/) and the dist build. */
const DATASETS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../datasets");

/** A flattened dataset row, always tagged with the (uppercased) country it loaded from. */
export type DatasetRow = Readonly<Record<string, unknown> & { country: string }>;

/**
 * `flatten` returns base rows (the loader adds `country`); unknown sibling
 * keys in `<cc>.json` are ignored.
 */
export interface DatasetDefinition<F extends { country: string } = { country: string }> {
  schema: z.ZodType<F>;
  flatten: (file: F) => Record<string, unknown>[];
  sortKey?: (row: DatasetRow) => string;
  kinds?: readonly string[];
}

const readJSON = memoize((file: string): unknown => {
  const path = resolve(DATASETS_DIR, file);
  const raw = tryExecute(() => readFileSync(path, "utf8"));
  if (!raw.ok) throw new Error(`dataset file ${file} could not be read: ${raw.error}`);
  // A shipped file that won't parse is a packaging defect; surface it loudly rather than degrading to an empty registry.
  const parsed = tryExecute((): unknown => JSON.parse(raw.value));
  if (!parsed.ok) throw new Error(`dataset file ${file} is not valid JSON: ${parsed.error}`);
  return parsed.value;
});

function readCountryFile<F extends { country: string }>(
  def: DatasetDefinition<F>,
  file: string,
): DatasetRow[] {
  const parsed = def.schema.safeParse(readJSON(file));
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new Error(`dataset file ${file} has an invalid shape: ${detail}`);
  }
  const country = parsed.data.country.toUpperCase();
  return def.flatten(parsed.data).map((row) => ({ ...row, country }));
}

function loadAll<F extends { country: string }>(def: DatasetDefinition<F>): DatasetRow[] {
  const files = readdirSync(DATASETS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const rows = files.flatMap((f) => readCountryFile(def, f));
  rows.sort(
    (a, b) =>
      a.country.localeCompare(b.country) ||
      (def.sortKey ? def.sortKey(a).localeCompare(def.sortKey(b)) : 0),
  );
  return rows;
}

/** Every row of a dataset, sorted by country then sort key. Memoized on the definition, so importing a dataset module does no file I/O; the array is shared and read-only. */
export const loadDatasetRows = memoize(
  <F extends { country: string }>(def: DatasetDefinition<F>): readonly DatasetRow[] => loadAll(def),
);
