import type { Command } from "commander";
import { runAction, type Invocation } from "../cli/output.js";
import type { Column } from "../cli/format.js";
import { fail } from "../cli/errors.js";
import {
  listDatasets as queryDatasets,
  readDataset,
  listDatasetNames,
  datasetHasKinds,
  type DatasetSummary,
} from "./datasets.js";
import type { DatasetRow } from "./loader.js";
import type { DatasetsListSummary } from "../contract/datasets.js";

const DATASET_COLUMNS: Column<DatasetSummary>[] = [
  { header: "Name", value: (d) => d.name },
  { header: "Countries", value: (d) => d.countries.join(", ") },
  { header: "Rows", value: (d) => String(d.rows), align: "right" },
];

const INSTITUTION_COLUMNS: Column<DatasetRow>[] = [
  { header: "Code", value: (r) => String(r.code ?? "") },
  { header: "Label", value: (r) => String(r.label ?? "") },
  { header: "Kind", value: (r) => String(r.kind ?? "") },
  { header: "Country", value: (r) => r.country },
];

const DEFAULTS_COLUMNS: Column<DatasetRow>[] = [
  { header: "Country", value: (r) => r.country },
  { header: "Locale", value: (r) => String(r.locale ?? "") },
  { header: "Currency", value: (r) => String(r.currency ?? "") },
];

const NOISE_COLUMNS: Column<DatasetRow>[] = [
  { header: "Token", value: (r) => String(r.token ?? "") },
  { header: "Country", value: (r) => r.country },
];

// Falls back to the generic country column so an unmapped dataset still renders something.
const COLUMNS_BY_DATASET: Record<string, Column<DatasetRow>[]> = {
  institutions: INSTITUTION_COLUMNS,
  defaults: DEFAULTS_COLUMNS,
  noise: NOISE_COLUMNS,
};

const GENERIC_COLUMNS: Column<DatasetRow>[] = [{ header: "Country", value: (r) => r.country }];

interface ListDatasetsOpts {
  country?: string;
  kind?: string;
}

function listDatasets(ctx: Invocation, name: string | undefined, opts: ListDatasetsOpts): void {
  if (name === undefined) {
    if (opts.country || opts.kind) {
      fail("USAGE", "--country/--kind need a dataset name (e.g. `oled datasets institutions --country th`)");
    }
    const sets = queryDatasets();
    ctx.out.emitList(sets, DATASET_COLUMNS);
    const summary: Omit<DatasetsListSummary, "type"> = { returned: sets.length };
    ctx.out.emitSummary(summary);
    return;
  }

  const names = listDatasetNames();
  if (!names.includes(name)) {
    fail("NOT_FOUND", `unknown dataset "${name}"`, { hint: `known datasets: ${names.join(", ")}` });
  }
  if (opts.kind && !datasetHasKinds(name)) {
    fail("USAGE", `dataset "${name}" has no kinds; drop --kind`);
  }
  const rows = readDataset(name, { country: opts.country, kind: opts.kind });
  ctx.out.emitList(rows, COLUMNS_BY_DATASET[name] ?? GENERIC_COLUMNS);
  const summary: Omit<DatasetsListSummary, "type"> = { returned: rows.length };
  ctx.out.emitSummary(summary);
}

export function registerDatasets(program: Command): void {
  program
    .command("datasets [name]")
    .description("Reference datasets")
    .option("--country <code>", "filter rows by country (e.g. th)")
    .option("--kind <kind>", "filter institutions by kind")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: read-only reference data, institution codes, per-country defaults, and the noise words merchant aliases strip.",
        "Typical flow: bare datasets lists them; datasets institutions --country th filters a country's institutions.",
        "Example: oled datasets institutions --country th --kind bank --json",
      ].join("\n"),
    )
    .action(runAction(listDatasets));
}
