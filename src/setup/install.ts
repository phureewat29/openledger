/** Every target receives the checked-in skills/openledger/SKILL.md verbatim: no templating, no per-agent wrapper. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { resolveFromCwd, type PathRoots } from "../lib/path.js";
import { getVersion } from "../lib/version.js";

/** Default skills dir `setup` writes to when no `--dir` is given; callers name their own dir rather than picking a host id from a registry. */
export const DEFAULT_SKILLS_DIR = ".agents/skills";

/** The pack's own directory name inside a skills dir; agents discover it by name. */
const SKILL_PACK_DIR = "openledger";

/** Directories `doctor` probes for an installed pack; diagnostic only, `setup` never resolves a path from here. */
export const SKILL_DIRS: readonly string[] = [DEFAULT_SKILLS_DIR, ".claude/skills", ".skills"];

interface InstallOptions {
  /** Install under the home skills dir rather than the cwd. */
  global?: boolean;
  /** The skills directory to install into; the pack lands at <dir>/openledger. */
  dir?: string;
  /** Overwrite an installed skill dir whose VERSION differs. */
  force?: boolean;
}

type InstallResult =
  | { ok: true; path: string; version: string }
  | {
      ok: false;
      reason: "version_mismatch";
      message: string;
      path: string;
      installedVersion: string;
      cliVersion: string;
    };

export function skillMd(): string {
  return readFileSync(new URL("../../skills/openledger/SKILL.md", import.meta.url), "utf8");
}

/** The version of the pack installed under a skills dir, or null when there is none. */
export function installedVersion(skillsDir: string): string | null {
  const versionPath = join(skillsDir, SKILL_PACK_DIR, "VERSION");
  if (!existsSync(versionPath)) return null;
  return readFileSync(versionPath, "utf8").trim();
}

function skillsDirFor(opts: InstallOptions, roots: PathRoots): string {
  if (opts.dir) return resolveFromCwd(opts.dir, roots);
  return resolve(opts.global ? roots.home : roots.cwd, DEFAULT_SKILLS_DIR);
}

/** Idempotent at the same version; a pack at a different version stays untouched unless `force`. */
export function installSkill(opts: InstallOptions, roots: PathRoots): InstallResult {
  const cliVersion = getVersion();
  const skillsDir = skillsDirFor(opts, roots);
  const path = join(skillsDir, SKILL_PACK_DIR);

  const installed = installedVersion(skillsDir);
  if (installed !== null && installed !== cliVersion && !opts.force) {
    return {
      ok: false,
      reason: "version_mismatch",
      message: `skill pack already installed at ${path} (version ${installed}); this CLI is ${cliVersion}`,
      path,
      installedVersion: installed,
      cliVersion,
    };
  }

  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), skillMd());
  writeFileSync(join(path, "VERSION"), cliVersion + "\n");
  return { ok: true, path, version: cliVersion };
}
