import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { dirname, resolve } from "path";
import { isPlainObject, mapValues, pick, pickBy } from "es-toolkit";
import { DEFAULT_MODEL_ID } from "../extract/cards/index.js";
import { expandHome, relativizeHomeIn, resolveFromCwd, type PathRoots } from "../lib/path.js";
import { decodeUserText } from "../lib/text.js";
import { chmod600 } from "../lib/perms.js";
import { tryExecute } from "../lib/result.js";

export interface OpenLedgerConfig {
  country: string;
  displayLocale: string;
  displayCurrency: string;
  dbPath: string;
  dataDir: string;
  cacheDir: string;
  userName: string;
  ocrBaseUrl: string;
  ocrModel: string;
  ocrApiKey: string;
}

/** What one invocation resolved: the config values plus where they came from. */
export interface ResolvedConfig extends OpenLedgerConfig {
  /** Absolute path of the file this invocation resolves to (`--config` or the default). */
  configPath: string;
  /** Freeform agent context lives beside the config file, so each profile carries its own. */
  contextPath: string;
  /** Whether the config file was present at load; data commands refuse to run without it. */
  exists: boolean;
  /** What `~` expanded to here, and what every path this invocation prints collapses back to. */
  home: string;
}

export interface LoadedConfig {
  config: ResolvedConfig;
  /** File values only, no defaults folded in; lets converge tell an explicitly-persisted value from a defaulted one. */
  fileValues: Partial<OpenLedgerConfig>;
  /** Why the file is unusable, or null when it is fine or simply absent. */
  problem: string | null;
}

/** The default config file lives here. */
function oledDir(home: string): string {
  return resolve(home, ".oled");
}

/** Also the persisted-key list: unknown keys on disk are tolerated on read, dropped on next write (`saveConfig` writes only these fields). */
const CONFIG_FIELDS: Record<keyof OpenLedgerConfig, { default: (configDir: string) => string }> = {
  /** Picks `datasets/<cc>.json`; deliberately not derived from `displayLocale`, which only formats numbers and dates. */
  country: { default: () => "TH" },
  displayLocale: { default: () => "th-TH" },
  /** Resolved value only; no module may hardcode a currency. `config --init` overrides it. */
  displayCurrency: { default: () => "THB" },
  dbPath: { default: (configDir) => resolve(configDir, "db.sqlite") },
  dataDir: { default: (configDir) => resolve(configDir, "data") },
  cacheDir: { default: (configDir) => resolve(configDir, "cache") },
  userName: { default: () => "User" },
  ocrBaseUrl: { default: () => "" },
  ocrModel: { default: () => DEFAULT_MODEL_ID },
  ocrApiKey: { default: () => "" },
};

const CONFIG_KEYS = Object.keys(CONFIG_FIELDS) as readonly (keyof OpenLedgerConfig)[];

/** Fields never echoed in plaintext; `oled config` renders each as `{ set, fingerprint }` via `keyFingerprint()` instead. */
export const CONFIG_SECRETS = ["ocrApiKey"] as const;

/** Non-reversible, so `oled config` can prove a secret is set without printing it. */
export function keyFingerprint(key: string): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 8)}`;
}

/** Known keys with string values only: drops `undefined` (so a patch can never
 *  delete a persisted key by accident) and hand-edited non-strings alike. */
function pickConfigFields(obj: Record<string, unknown>): Partial<OpenLedgerConfig> {
  return pickBy(pick(obj, CONFIG_KEYS), (value) => typeof value === "string") as Partial<OpenLedgerConfig>;
}

/** V8's message quotes the input around a bad token, and this file holds ocrApiKey. */
const JSON_POSITION_RE = /at position (\d+)/;

/** A fixed message with at most a line and column; never any of the file's text. */
function jsonProblem(text: string, parseError: string): string {
  const position = JSON_POSITION_RE.exec(parseError)?.[1];
  if (!position) return "it is not valid JSON";
  const before = text.slice(0, Number(position));
  const line = before.split("\n").length;
  const column = before.length - before.lastIndexOf("\n");
  return `it is not valid JSON at line ${line}, column ${column}`;
}

interface FileValues {
  fileValues: Partial<OpenLedgerConfig>;
  problem: string | null;
  exists: boolean;
}

function unusable(problem: string): FileValues {
  return { fileValues: {}, problem, exists: true };
}

function readFileValues(configPath: string, home: string): FileValues {
  if (!existsSync(configPath)) return { fileValues: {}, problem: null, exists: false };
  const text = tryExecute(() => decodeUserText(readFileSync(configPath)));
  if (!text.ok) return unusable(relativizeHomeIn(text.error, configPath, home));
  const parsed = tryExecute((): unknown => JSON.parse(text.value));
  if (!parsed.ok) return unusable(jsonProblem(text.value, parsed.error));
  if (!isPlainObject(parsed.value)) return unusable("it does not hold a JSON object");
  return { fileValues: pickConfigFields(parsed.value), problem: null, exists: true };
}

/** Fields naming filesystem locations: `~/x` in any of them must expand, not resolve under the cwd. */
const PATH_FIELDS = ["dbPath", "dataDir", "cacheDir"] as const;

/** Precedence: file > default. `||`, not `??`, so an empty-string value means unset. */
function withDefaults(
  fileValues: Partial<OpenLedgerConfig>,
  configPath: string,
  home: string,
): OpenLedgerConfig {
  // Defaults sit beside the config file, so each profile is its own ledger.
  const configDir = dirname(configPath);
  const values = mapValues(CONFIG_FIELDS, (field, key) => fileValues[key] || field.default(configDir));
  // A hand-edited relative path resolves against the config file's dir, so it names one place from every cwd.
  const paths = mapValues(pick(values, PATH_FIELDS), (path) => resolve(configDir, expandHome(path, home)));
  return { ...values, ...paths };
}

/** Reads the config file (default: `<home>/.oled/config.json`). A broken file degrades
 *  to defaults with `problem` set; the caller decides whether that is fatal. */
export function loadConfig(configPath: string | undefined, roots: PathRoots): LoadedConfig {
  const { home } = roots;
  const named = expandHome(configPath ?? resolve(oledDir(home), "config.json"), home);
  const resolved = resolveFromCwd(named, roots);
  const { fileValues, problem, exists } = readFileValues(resolved, home);
  const config: ResolvedConfig = {
    ...withDefaults(fileValues, resolved, home),
    configPath: resolved,
    contextPath: resolve(dirname(resolved), "context.md"),
    exists,
    home,
  };
  return { config, fileValues, problem };
}

/** Merges the file's values with the DEFINED entries of `patch`, writes 0600,
 *  and returns the merged values with defaults folded in. No module state. */
export function saveConfig(
  configPath: string,
  patch: Partial<OpenLedgerConfig>,
  home: string,
): OpenLedgerConfig {
  const dir = dirname(configPath);
  // 0700 like the cache dir: this tree holds financial data.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Only the default dir is oled's own to tighten; a profile's dir is the caller's, and may be shared.
  if (dir === oledDir(home) && process.platform !== "win32") chmodSync(dir, 0o700);

  // A broken file degrades to {} here; the write below repairs it.
  const { fileValues } = readFileValues(configPath, home);
  const merged = { ...fileValues, ...pickConfigFields(patch) };
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  chmod600(configPath);

  return withDefaults(merged, configPath, home);
}
