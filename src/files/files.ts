import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type Database from "libsql";
import {
  findFileByHash,
  findFileById,
  insertPendingFile,
  type PendingFileInput,
} from "./queries.js";
import { SOURCES, loadSource, type LoadedSource } from "../extract/source.js";
import { newFileId } from "../lib/ids.js";
import { tryExecute } from "../lib/result.js";

export interface WalkedFile {
  path: string;
  /** Forward-slashed relative path from the data dir. */
  relPath: string;
}

/** `lineage` holds the real paths of the directories above `dir`, so a symlink back into one is a cycle, not a subtree. */
function walk(dir: string, root: string, lineage: readonly string[]): WalkedFile[] {
  const real = tryExecute(() => realpathSync(dir));
  if (!real.ok || lineage.includes(real.value)) return [];
  const entries = tryExecute(() => readdirSync(dir));
  if (!entries.ok) return [];

  const below = [...lineage, real.value];
  return entries.value
    .filter((entry) => !entry.startsWith("."))
    .flatMap((entry) => walkEntry(resolve(dir, entry), root, below));
}

function walkEntry(full: string, root: string, lineage: readonly string[]): WalkedFile[] {
  const stat = tryExecute(() => statSync(full));
  if (!stat.ok) return [];
  if (stat.value.isDirectory()) return walk(full, root, lineage);
  if (!stat.value.isFile() || !SOURCES[extname(full).toLowerCase()]) return [];
  return [{ path: full, relPath: relative(root, full).split(sep).join("/") }];
}

export function walkFiles(root: string): WalkedFile[] {
  return walk(root, root, []);
}

/** Hashes but never parses, so this stays off mupdf's import path. A null db
 *  means no ledger yet, so every readable file counts as new. */
export function countNewFiles(db: Database.Database | null, dataDir: string): number {
  return walkFiles(dataDir).filter((file) => {
    const loaded = loadSource(file.path);
    return loaded.ok && (!db || !findFileByHash(db, loaded.value.hash));
  }).length;
}

export function pendingRow(source: LoadedSource, fileId: string): PendingFileInput {
  return { id: fileId, path: source.path, file_hash: source.hash, mime: source.mime };
}

/** Keyed by content hash: re-registering the same bytes returns the existing id. */
export function registerPendingFile(db: Database.Database, source: LoadedSource): string {
  const known = findFileByHash(db, source.hash);
  if (known) return known.id;

  const fileId = newFileId();
  insertPendingFile(db, pendingRow(source, fileId));
  return fileId;
}

/** Resolution order: absolute, data-dir-relative, cwd-relative, then file id; null if none match. */
export function resolveEntryPath(
  db: Database.Database,
  dataDir: string,
  entryOrId: string,
  cwd: string,
): string | null {
  if (isAbsolute(entryOrId) && existsSync(entryOrId)) return entryOrId;

  const viaDataDir = resolve(dataDir, entryOrId);
  if (existsSync(viaDataDir)) return viaDataDir;

  const viaCwd = resolve(cwd, entryOrId);
  if (existsSync(viaCwd)) return viaCwd;

  return findFileById(db, entryOrId)?.path ?? null;
}

/** Retries absorb the transient EBUSY/EPERM thrown while a Windows scanner briefly holds a fresh artifact. */
export const RM_OPTS = { recursive: true, force: true, maxRetries: 3 } as const;

/** The shape `newFileId` mints, plus the legacy `sf:` form still stored by older ledgers:
 *  one plain path segment, so it resolves to exactly `<cacheDir>/<id>`. */
const FILE_ID_RE = /^sf[-:][A-Za-z0-9-]+$/;

/** Throws unless `fileId` is a file id, naming exactly one directory inside `cacheDir`: the delete is recursive. */
export function cleanCache(cacheDir: string, fileId: string): { removed: string[] } {
  if (!FILE_ID_RE.test(fileId)) {
    throw new Error(`refusing to clean "${fileId}": not a file id, so not a single entry inside the cache dir`);
  }
  const dir = resolve(cacheDir, fileId);
  if (!existsSync(dir)) return { removed: [] };
  rmSync(dir, RM_OPTS);
  return { removed: [dir] };
}
