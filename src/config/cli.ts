import type { Command } from "commander";
import type Database from "libsql";
import { existsSync, mkdirSync } from "fs";
import { mapValues, pick } from "es-toolkit";
import { openDB } from "../db/connection.js";
import { ensureStructuralAccounts } from "../accounts/accounts.js";
import {
  CONFIG_SECRETS,
  keyFingerprint,
  loadConfig,
  saveConfig,
  type LoadedConfig,
  type OpenLedgerConfig,
  type ResolvedConfig,
} from "./config.js";
import { expandHome, relativizeHomeIn, resolveFromCwd, type PathRoots } from "../lib/path.js";
import { tryExecute } from "../lib/result.js";
import { findCountryDefaults, availableCountries } from "../datasets/datasets.js";
import { createContextTemplate } from "./context.js";
import { DEFAULT_MODEL_ID } from "../extract/cards/index.js";
import { runAction, type Invocation, type Output } from "../cli/output.js";
import { fail } from "../cli/errors.js";
import * as z from "zod";
import { parseInput, str, bool } from "../lib/validate.js";
import type { ConfigShowResult, ConfigConvergeResult, ConfigSecretStatus } from "../contract/config.js";

/** Fails NOT_READY on a config that can't back a command: an unusable file, or a path with
 *  nothing at it. Shared by `requireConfig` (always) and `inspectConfig` (only once a
 *  `--config` was actually named). */
function assertUsable(loaded: LoadedConfig): ResolvedConfig {
  const { config, problem } = loaded;
  if (problem) {
    fail("NOT_READY", `config file ${config.configPath} is unusable: ${problem}`, {
      hint: "fix or remove it, then run `oled config --init`",
    });
  }
  if (!config.exists) {
    fail("NOT_READY", `no config file at ${config.configPath}`, {
      hint: "run `oled config --init`, or pass --config <path>",
    });
  }
  return config;
}

/** For commands that operate on the ledger: no config file, no ledger. */
export function requireConfig(path: string | undefined, roots: PathRoots): ResolvedConfig {
  return assertUsable(loadConfig(path, roots));
}

export async function openLedger(
  ctx: Invocation,
): Promise<{ config: ResolvedConfig; db: Database.Database }> {
  const config = requireConfig(ctx.configPath, ctx.roots);
  return { config, db: await openDB(config.dbPath) };
}

/** For `status`/`doctor`: an absent DEFAULT config loads leniently, but a named --config must still resolve, or the report would describe the default profile. */
export function inspectConfig(path: string | undefined, roots: PathRoots): LoadedConfig {
  const loaded = loadConfig(path, roots);
  // An explicit empty path still counts as "named"; only true absence stays lenient.
  if (path !== undefined) assertUsable(loaded);
  return loaded;
}

export type LedgerProbe =
  | { state: "missing" }
  | { state: "unreachable"; error: string }
  | { state: "open"; db: Database.Database };

export const NO_LEDGER = "no ledger yet";

/** Opens the ledger only if it exists (`openDB` would create it); the error names the path home-relative. */
export async function probeLedger(dbPath: string, home: string): Promise<LedgerProbe> {
  if (!existsSync(dbPath)) return { state: "missing" };
  const opened = await tryExecute(() => openDB(dbPath));
  if (!opened.ok) {
    return { state: "unreachable", error: relativizeHomeIn(opened.error, dbPath, home) };
  }
  return { state: "open", db: opened.value };
}

type SecretKey = (typeof CONFIG_SECRETS)[number];

type RedactedConfig = Omit<OpenLedgerConfig, SecretKey> & Record<SecretKey, ConfigSecretStatus>;

function secretStatus(value: string): ConfigSecretStatus {
  return value ? { set: true, fingerprint: keyFingerprint(value) } : { set: false };
}

/** Every CONFIG_SECRETS key surfaces as {set, fingerprint}, never plaintext: config output is safe to paste into shells/logs/bug reports. */
function redactConfig(cfg: OpenLedgerConfig): RedactedConfig {
  return { ...cfg, ...mapValues(pick(cfg, CONFIG_SECRETS), secretStatus) };
}

/** Strips the resolution fields: the two paths render as their own rows, and `home` never renders (it names the OS account). */
function configValues(cfg: ResolvedConfig): OpenLedgerConfig {
  const { configPath, contextPath, exists, home, ...values } = cfg;
  return values;
}

function showPayload(loaded: LoadedConfig): ConfigShowResult {
  const cfg = loaded.config;
  return {
    ...redactConfig(configValues(cfg)),
    config_path: cfg.configPath,
    context_path: cfg.contextPath,
    // A broken file degrades to defaults; the payload must say so, not imply them.
    ...(loaded.problem ? { problem: loaded.problem } : {}),
  };
}

/** The display currency names a ledger (`<currency>:<type>`), so anything but three
 *  letters can never become one. */
const CURRENCY_CODE_RE = /^[a-z]{3}$/i;

/** A tag Intl rejects would make every later money format throw; "" stays allowed and means unset. */
function checkLocale(value: string, ctx: z.RefinementCtx): void {
  if (!value || tryExecute(() => Intl.getCanonicalLocales(value)).ok) return;
  ctx.addIssue({
    code: "invalid_format",
    format: "locale",
    input: value,
    message: "must be a BCP 47 locale, e.g. th-TH",
  });
}

/** Every flag the `config` action accepts; snake_case so parseInput auto-bridges commander's camelCase opts. */
const CONVERGE_FLAGS_SPEC = z.object({
  data_dir: str().optional(),
  db: str().optional(),
  cache_dir: str().optional(),
  init: bool().optional(),
  locale: str().superRefine(checkLocale).optional(),
  // Not str(): must fail USAGE before saveConfig persists a bad code.
  currency: z
    .string()
    .regex(CURRENCY_CODE_RE, "must be a 3-letter currency code, e.g. THB")
    // Rows derive currency as uppercase from the id prefix.
    .transform((code) => code.toUpperCase())
    .optional(),
  user_name: str().optional(),
  country: str().optional(),
  ocr_base_url: str().optional(),
  ocr_model: str().optional(),
  ocr_api_key: str().optional(),
});

type ConvergeFlags = z.infer<typeof CONVERGE_FLAGS_SPEC>;

type SettingFlags = Omit<ConvergeFlags, "init">;

/**
 * ocrApiKey may be undefined here; saveConfig drops undefined entries, so an
 * absent flag can never clear a persisted key.
 */
type ConvergedConfig = Omit<OpenLedgerConfig, "ocrApiKey"> & { ocrApiKey?: string };

/**
 * Precedence: flag > file > default; country is validated first so an unknown
 * name never reaches the file.
 */
function resolveConvergedConfig(
  flags: SettingFlags,
  loaded: LoadedConfig,
  roots: PathRoots,
): ConvergedConfig {
  const current = loaded.config;
  const country = flags.country ?? current.country;
  const defaults = findCountryDefaults(country);
  if (!defaults) {
    fail("USAGE", `unknown country "${country}"`, {
      hint: `available: ${availableCountries().join(", ")}`,
    });
  }
  const persisted = loaded.fileValues;
  // Persisted absolute so the path means the same from every later cwd; `~` is expanded
  // because Windows shells pass it through literally. "" stays "", which means unset.
  const pathFlag = (flag: string | undefined, fallback: string): string =>
    flag === undefined ? fallback : flag && resolveFromCwd(expandHome(flag, roots.home), roots);

  return {
    country: defaults.country,
    dataDir: pathFlag(flags.data_dir, current.dataDir),
    dbPath: pathFlag(flags.db, current.dbPath),
    cacheDir: pathFlag(flags.cache_dir, current.cacheDir),
    displayLocale: flags.locale || persisted.displayLocale || defaults.locale,
    displayCurrency: flags.currency || persisted.displayCurrency || defaults.currency,
    userName: flags.user_name ?? current.userName,
    // The URL alone decides whether OCR is enabled.
    ocrBaseUrl: flags.ocr_base_url ?? current.ocrBaseUrl,
    ocrModel: flags.ocr_model ?? current.ocrModel,
    ocrApiKey: flags.ocr_api_key,
  };
}

/** Idempotent: each value resolves to an explicit flag, the file, or a default. */
async function convergeConfig(
  out: Output,
  flags: SettingFlags,
  loaded: LoadedConfig,
  roots: PathRoots,
): Promise<void> {
  const converged = resolveConvergedConfig(flags, loaded, roots);
  // 0700: the data dir holds the raw statements, the most sensitive files here.
  mkdirSync(converged.dataDir, { recursive: true, mode: 0o700 });

  const configPath = loaded.config.configPath;
  const merged = saveConfig(configPath, converged, roots.home);

  // After saveConfig, and from the returned values, so the migration lands on the new db path.
  const db = await openDB(merged.dbPath);

  // Seeds the display-currency ledger's structural accounts so first ingest resolves them.
  ensureStructuralAccounts(db, merged.displayCurrency);

  createContextTemplate(loaded.config.contextPath, merged.userName);

  const result: ConfigConvergeResult = {
    ...redactConfig(merged),
    config_path: configPath,
    context_path: loaded.config.contextPath,
    created: { config: configPath, db: merged.dbPath, data_dir: merged.dataDir },
  };
  out.emitRecord(result);
}

/** `--init` asserts a fresh setup; a missing db or data dir is a recovery case it may rebuild. */
function fullyInitialized(cfg: ResolvedConfig): boolean {
  return cfg.exists && existsSync(cfg.dbPath) && existsSync(cfg.dataDir);
}

function showConfig(out: Output, path: string | undefined, loaded: LoadedConfig): void {
  // Naming a file that does not exist is a mistake, not a defaults view:
  // `config show` muscle memory would otherwise read a file named "show".
  if (path && !loaded.config.exists) {
    fail("NOT_FOUND", `no config file at ${loaded.config.configPath}`, {
      hint: "create it with `oled config <path> --init`",
    });
  }
  out.emitRecord(showPayload(loaded));
}

async function configureHarness(
  ctx: Invocation,
  path: string | undefined,
  opts: Record<string, unknown>,
): Promise<void> {
  // One spelling only: a root-consumed --config would be silently ignored here otherwise.
  if (ctx.configPath !== undefined) {
    fail("USAGE", "config names its file as a positional", {
      hint: "oled config <path> …",
    });
  }
  const flags = parseInput(CONVERGE_FLAGS_SPEC, opts);
  const loaded = loadConfig(path, ctx.roots);
  const { init, ...settings } = flags;
  const writing = init || Object.keys(settings).length > 0;
  if (!writing) return showConfig(ctx.out, path, loaded);

  // A file that exists but does not parse never converges: writing would
  // silently discard whatever the user hand-edited into it.
  if (loaded.problem) {
    fail("NOT_READY", `config file ${loaded.config.configPath} is unusable: ${loaded.problem}`, {
      hint: "fix or remove it, then try again",
    });
  }
  if (init && fullyInitialized(loaded.config)) {
    fail("INVALID", `already initialized: ${loaded.config.configPath}`, {
      hint: "drop --init to change settings",
    });
  }
  await convergeConfig(ctx.out, settings, loaded, ctx.roots);
}

export function registerConfig(program: Command): void {
  program
    .command("config")
    .description("OpenLedger configuration")
    .argument("[path]", "config file to read or write (default ~/.oled/config.json)")
    .option("--data-dir <dir>", "drop statement files here; oled open opens it")
    .option("--db <path>", "database path")
    .option("--cache-dir <dir>", "extracted text and page images land here")
    .option("--init", "create the config file, database, and data dir; refuses a config that already exists")
    .option("--locale <locale>", "locale used to format money, e.g. th-TH")
    .option("--currency <code>", "display currency; also seeds that ledger's structural accounts")
    .option("--country <code>", "country whose reference data applies; also seeds locale/currency (default: TH)")
    .option("--user-name <name>", "your name; config shows it and redaction masks it")
    .option("--ocr-base-url <url>", "OCR endpoint base URL, e.g. http://127.0.0.1:1234/v1; OCR is off until this is set")
    .option("--ocr-model <id>", `model id, or a variant of it (default ${DEFAULT_MODEL_ID}); does nothing until --ocr-base-url is set`)
    .option("--ocr-api-key <key>", 'API key for the OCR endpoint; saved to the config file (0600), shown only as a fingerprint; "" clears it')
    .addHelpText(
      "after",
      [
        "",
        "Bare `oled config` shows the current settings; any setting flag writes",
        "them, creating the file on first touch. The positional argument names the",
        "config file (default ~/.oled/config.json); every other oled command",
        "reaches the same config file with --config <path>."
      ].join("\n"),
    )
    .action(runAction(configureHarness));
}
