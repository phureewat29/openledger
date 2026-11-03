import type { Command } from "commander";
import chalk from "chalk";
import { randomUUID } from "crypto";
import { existsSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import type { LoadedConfig, PathRoots, ResolvedConfig } from "../../config/config.js";
import { listMissingTables } from "../../db/schema.js";
import { inspectConfig, probeLedger, type LedgerProbe } from "../../config/cli.js";
import { getVersion } from "../../lib/version.js";
import { homeRelative, relativizeHomeIn } from "../../lib/path.js";
import { installedVersion, SKILL_DIRS } from "../../setup/install.js";
import { loadMupdf } from "../../extract/pdf.js";
import { runAction, type Invocation } from "../output.js";
import type { Column } from "../format.js";
import type { ExitCode } from "../../contract/exit.js";
import { err, flatMap, ok, tryExecute, type Result } from "../../lib/result.js";
import {
  pickServedModel,
  probeOcrEndpoint,
  resolveOcr,
  type OCRConfigSource,
} from "../../extract/ocr.js";
import type { DoctorCheck as Check, DoctorReport } from "../../contract/doctor.js";

const HARD_CHECKS = new Set(["db_open", "schema_tables_present"]);
const REQUIRED_TABLES = ["accounts", "transactions", "questions"];

// Diagnosing must not provision: doctor reports what's missing and points at `config --init`.
const INIT_HINT = "run `oled config --init` to create it";

function checkFrom(name: string, result: Result<unknown>): Check {
  return result.ok ? { name, ok: true } : { name, ok: false, detail: result.error };
}

function configCheck(cfg: ResolvedConfig): Check {
  const name = "config_exists";
  return cfg.exists ? { name, ok: true } : { name, ok: false, detail: INIT_HINT };
}

// loadConfig degrades to defaults so a bad file can't take down the CLI itself; this is where
// that silence ends.
function configReadableCheck(loaded: LoadedConfig): Check {
  const name = "config_readable";
  if (!loaded.problem) return { name, ok: true };
  const shown = homeRelative(loaded.config.configPath);
  return { name, ok: false, detail: `${shown} is unusable, so defaults are in use: ${loaded.problem}` };
}

function dbOpenCheck(ledger: LedgerProbe): Check {
  const name = "db_open";
  if (ledger.state === "missing") return { name, ok: false, detail: `no ledger yet: ${INIT_HINT}` };
  if (ledger.state === "unreachable") return { name, ok: false, detail: ledger.error };
  return { name, ok: true };
}

function dataDirWritableCheck(dir: string): Check {
  const name = "data_dir_writable";
  if (!existsSync(dir)) return { name, ok: false, detail: `missing: ${INIT_HINT}` };
  const probed = tryExecute(() => {
    const probe = join(dir, `.doctor-probe-${randomUUID()}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
  });
  if (!probed.ok) return { name, ok: false, detail: relativizeHomeIn(probed.error, dir) };
  return { name, ok: true };
}

function schemaTablesCheck(ledger: LedgerProbe): Check {
  const name = "schema_tables_present";
  if (ledger.state !== "open") return { name, ok: false, detail: "database not open" };
  const missing = tryExecute(() => listMissingTables(ledger.db, REQUIRED_TABLES));
  return checkFrom(
    name,
    flatMap(missing, (tables) => (tables.length ? err(`missing: ${tables.join(", ")}`) : ok(tables))),
  );
}

export async function ocrEndpointCheck(source: OCRConfigSource): Promise<Check> {
  const name = "ocr_endpoint";
  const settings = resolveOcr(source);
  if (!settings) return { name, ok: true, detail: "off (set --ocr-base-url to enable)" };

  const { baseUrl, model } = settings;
  const served = await probeOcrEndpoint(settings);
  if (!served.ok) return { name, ok: false, detail: `${baseUrl}: ${served.error}` };
  const match = pickServedModel(model, served.value);
  if (!match) {
    return {
      name,
      ok: false,
      detail: `${baseUrl} does not serve ${model} (serving: ${served.value.join(", ") || "nothing"})`,
    };
  }
  const shown = match === model ? model : `${model} → ${match}`;
  return { name, ok: true, detail: `${shown} at ${baseUrl}` };
}

/** Informational only; never a HARD_CHECK. */
function skillPackCheck({ cwd, home }: PathRoots): Check {
  const name = "skill_pack";
  // Probes conventional dirs only; a pack installed via `setup --dir` elsewhere reads as not installed.
  const found = ([["project", cwd], ["global", home]] as const)
    .flatMap(([scope, base]) =>
      SKILL_DIRS.flatMap((dir) => {
        const version = installedVersion(resolve(base, dir));
        return version === null ? [] : [{ version, where: `${dir}, ${scope}` }];
      }),
    )
    .at(0);
  if (!found) return { name, ok: true, detail: "not installed" };

  const cli = getVersion();
  if (found.version !== cli) {
    return {
      name,
      ok: false,
      detail: `installed ${found.version} (${found.where}), cli ${cli}: refresh the skill (oled setup --force) or upgrade the CLI (npm install -g @aquartier/openledger@latest)`,
    };
  }
  return { name, ok: true, detail: `installed ${found.version} (${found.where})` };
}

async function runChecks(loaded: LoadedConfig, roots: PathRoots): Promise<Check[]> {
  const cfg = loaded.config;
  const ledger = await probeLedger(cfg.dbPath);
  return [
    configCheck(cfg),
    configReadableCheck(loaded),
    dbOpenCheck(ledger),
    dataDirWritableCheck(cfg.dataDir),
    checkFrom("mupdf_loads", await tryExecute(loadMupdf)),
    schemaTablesCheck(ledger),
    skillPackCheck(roots),
    await ocrEndpointCheck(cfg),
  ];
}

type Verdict = "not_ready" | "degraded" | "ready";

const VERDICT: Record<Verdict, { line: string; paint: (text: string) => string }> = {
  not_ready: {
    line: "OpenLedger is not ready. Fix the failed checks above, then run `oled doctor` again.",
    paint: chalk.red,
  },
  degraded: {
    line: "OpenLedger is ready, but some checks failed. See the details above.",
    paint: chalk.yellow,
  },
  ready: { line: "Everything looks good. OpenLedger is ready.", paint: chalk.green },
};

function verdictOf(ready: boolean, checks: Check[]): Verdict {
  if (!ready) return "not_ready";
  return checks.every((c) => c.ok) ? "ready" : "degraded";
}

const CHECK_COLUMNS: Column<Check>[] = [
  { header: "Check", value: (r) => r.name },
  { header: "OK", value: (r) => (r.ok ? "yes" : "no") },
  { header: "Detail", value: (r) => r.detail ?? "" },
];

async function diagnoseEnvironment(ctx: Invocation): Promise<ExitCode | undefined> {
  const roots: PathRoots = { cwd: process.cwd(), home: homedir() };
  const checks = await runChecks(inspectConfig(ctx.configPath, roots.home), roots);
  const ready = checks.filter((c) => HARD_CHECKS.has(c.name)).every((c) => c.ok);

  const { out } = ctx;
  if (out.mode.json) {
    const result: DoctorReport = { checks, ok: ready };
    out.emit(result);
  } else {
    out.emitList(checks, CHECK_COLUMNS);
    const { line, paint } = VERDICT[verdictOf(ready, checks)];
    out.write("\n" + (out.mode.color ? paint(line) : line) + "\n");
  }
  return ready ? undefined : "NOT_READY";
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose the harness environment")
    .action(runAction(diagnoseEnvironment));
}
