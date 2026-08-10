import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import type Database from "libsql";
import {
  findFileByHash,
  findFileById,
  insertPendingFile,
  type PendingFileInput,
} from "../db/queries/files.js";
import { SOURCES, loadSource, type LoadedSource } from "../extract/source.js";
import { newFileId } from "../lib/ids.js";
import { tryExecute } from "../lib/result.js";

export interface WalkedFile {
  path: string;
  /** Forward-slashed relative path from the data dir. */
  relPath: string;
}

function walk(dir: string, root: string, out: WalkedFile[]): void {
  const entries = tryExecute(() => readdirSync(dir));
  if (!entries.ok) return;

  for (const entry of entries.value) {
    if (entry.startsWith(".")) continue;
    const full = resolve(dir, entry);

    const stat = tryExecute(() => statSync(full));
    if (!stat.ok) continue;

    if (stat.value.isDirectory()) {
      walk(full, root, out);
      continue;
    }
    if (!stat.value.isFile()) continue;
    if (!SOURCES[extname(entry).toLowerCase()]) continue;

    out.push({ path: full, relPath: relative(root, full).split(sep).join("/") });
  }
}

export function walkFiles(root: string): WalkedFile[] {
  const out: WalkedFile[] = [];
  walk(root, root, out);
  return out;
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

/** Pending row keyed by content hash, so re-registering the same bytes is a
 *  no-op that returns the existing id. */
export function registerPendingFile(
  db: Database.Database,
  source: LoadedSource,
): { fileId: string; alreadyKnown: boolean } {
  const known = findFileByHash(db, source.hash);
  if (known) return { fileId: known.id, alreadyKnown: true };

  const fileId = newFileId();
  insertPendingFile(db, pendingRow(source, fileId));
  return { fileId, alreadyKnown: false };
}

/** Resolution order: absolute, data-dir-relative, cwd-relative, then file id; null if none match. */
export function resolveEntryPath(
  db: Database.Database,
  dataDir: string,
  entryOrId: string,
): string | null {
  if (isAbsolute(entryOrId) && existsSync(entryOrId)) return entryOrId;

  const viaDataDir = resolve(dataDir, entryOrId);
  if (existsSync(viaDataDir)) return viaDataDir;

  const viaCwd = resolve(entryOrId);
  if (existsSync(viaCwd)) return viaCwd;

  const byId = findFileById(db, entryOrId);
  if (byId) return byId.path;

  return null;
}

/** Retries absorb the transient EBUSY/EPERM thrown while a Windows scanner briefly holds a fresh artifact. */
export const RM_OPTS = { recursive: true, force: true, maxRetries: 3 } as const;

export function cleanCache(cacheDir: string, fileId: string): { removed: string[] } {
  const dir = resolve(cacheDir, fileId);
  if (!existsSync(dir)) return { removed: [] };
  rmSync(dir, RM_OPTS);
  return { removed: [dir] };
}
