import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "libsql";
import type { OpenLedgerConfig } from "../config/config.js";
import { findFileByHash, replaceFile } from "../files/queries.js";
import { extractFile, type Extraction, type PageReader, type TextPage } from "../extract/extract.js";
import { isEncryptedPDF, unlockPDF, type UnlockFailureReason } from "../extract/pdf.js";
import { loadSource, type LoadedSource } from "../extract/source.js";
import { newFileId } from "../lib/ids.js";
import { ok, tryExecute, type Result } from "../lib/result.js";
import type { PathRoots } from "../lib/path.js";
import {
  RM_OPTS,
  cleanCache,
  pendingRow,
  registerPendingFile,
  resolveEntryPath,
  walkFiles,
  type WalkedFile,
} from "../files/files.js";
import type { IngestFile, PreparePage, PrepareResult, TextLayer } from "../contract/ingest.js";

type IngestStatus = IngestFile["status"];

export interface IngestEntry extends WalkedFile {
  /** null when the bytes could not be read. */
  hash: string | null;
  fileId: string | null;
  status: IngestStatus;
  encrypted: boolean;
  note?: string;
}

/** Only a PDF can be locked, and only a PDF can be unopenable; an image needs neither probe. */
async function encryptionOf(source: LoadedSource): Promise<Result<boolean>> {
  if (source.kind !== "pdf") return ok(false);
  return tryExecute(() => isEncryptedPDF(source.bytes));
}

function unreadableEntry(file: WalkedFile, note: string): IngestEntry {
  return { ...file, hash: null, fileId: null, status: "unreadable", encrypted: false, note };
}

/** A file this harness can't read becomes an `unreadable` row, rather than sinking the listing. */
async function discoverEntry(db: Database.Database, file: WalkedFile): Promise<IngestEntry> {
  const loaded = loadSource(file.path);
  if (!loaded.ok) return unreadableEntry(file, loaded.message);
  const encryption = await encryptionOf(loaded.value);
  if (!encryption.ok) return unreadableEntry(file, encryption.error);

  const known = findFileByHash(db, loaded.value.hash);
  return {
    ...file,
    hash: loaded.value.hash,
    fileId: known?.id ?? null,
    status: known ? known.status : "new",
    encrypted: encryption.value,
  };
}

export async function discoverFiles(
  db: Database.Database,
  dataDir: string,
  opts: { regex?: RegExp } = {},
): Promise<IngestEntry[]> {
  const { regex } = opts;
  const files = walkFiles(dataDir).filter((file) => !regex || regex.test(file.relPath));
  // One at a time: each probe holds a whole statement's bytes in memory.
  const entries: IngestEntry[] = [];
  for (const file of files) entries.push(await discoverEntry(db, file));
  return entries;
}

interface PrepareOptions {
  /** Reads a page that has no usable text layer; the CLI passes the OCR engine's. */
  read: PageReader;
  password?: string;
  /** Re-reads bytes, then replaces the prior row, dropping its transactions,
   *  questions, and artifacts. */
  force?: boolean;
  /** Ignore the text layer, for garbled or junk layers. */
  rescan?: boolean;
}

export type PrepareFailure =
  | "not_found"
  | "unsupported_extension"
  | "kind_mismatch"
  | "too_large"
  | "unreadable"
  | "pdf_unreadable"
  | "image_unreadable"
  | "password_required"
  | "wrong_password"
  | "ocr_unavailable";

type PrepareOutcome =
  | {
      ok: true;
      fileId: string;
      source: PrepareResult["source"];
      textLayer: TextLayer;
      /** One file to read, pages separated by `--- page N ---` markers. */
      document: string;
      pages: PreparePage[];
    }
  | { ok: false; reason: PrepareFailure; message: string };

export type PrepareSuccess = Extract<PrepareOutcome, { ok: true }>;

type UnlockedBytes =
  | { ok: true; bytes: Buffer }
  | {
      ok: false;
      reason: Extract<PrepareFailure, "pdf_unreadable" | "password_required" | "wrong_password">;
      message: string;
    };

const UNLOCK_FAILURES: Record<UnlockFailureReason, Extract<UnlockedBytes, { ok: false }>> = {
  wrong_password: {
    ok: false,
    reason: "wrong_password",
    message: "the supplied password did not open the PDF",
  },
  unsupported_document: {
    ok: false,
    reason: "pdf_unreadable",
    message: "the file carries PDF magic bytes but does not open as a PDF document",
  },
};

/** Images are never locked; decrypted PDF bytes stay in memory: only extracted text is written to disk. */
async function readableBytes(source: LoadedSource, password?: string): Promise<UnlockedBytes> {
  if (source.kind !== "pdf") return { ok: true, bytes: source.bytes };

  const probe = await encryptionOf(source);
  if (!probe.ok) return { ok: false, reason: "pdf_unreadable", message: probe.error };
  if (!probe.value) return { ok: true, bytes: source.bytes };
  if (!password) {
    return {
      ok: false,
      reason: "password_required",
      message: "the PDF is locked and no password was given",
    };
  }

  const attempt = await tryExecute(() => unlockPDF(source.bytes, password));
  if (!attempt.ok) return { ok: false, reason: "pdf_unreadable", message: attempt.error };
  if (!attempt.value.ok) return UNLOCK_FAILURES[attempt.value.reason];
  return { ok: true, bytes: attempt.value.decrypted };
}

const DOCUMENT_FILE = "document.txt";

/** Markers give every row a 1-based page to cite as `source_page`. */
function documentText(pages: TextPage[]): string {
  return `${pages.map((page) => `--- page ${page.page} ---\n${page.text}`).join("\n\n")}\n`;
}

interface WriteTarget {
  fileId: string;
  dir: string;
}

/** Rebuilt per prepare, so a prior run's artifacts can never be mistaken for this one's. */
function writeDocument(extraction: Extraction, target: WriteTarget): PrepareSuccess {
  rmSync(target.dir, RM_OPTS);
  mkdirSync(target.dir, { recursive: true, mode: 0o700 });
  const document = resolve(target.dir, DOCUMENT_FILE);
  writeFileSync(document, documentText(extraction.pages), { mode: 0o600 });
  return {
    ok: true,
    fileId: target.fileId,
    source: extraction.source,
    textLayer: extraction.textLayer,
    document,
    pages: extraction.pages.map((page) => ({ page: page.page, chars: page.text.length })),
  };
}

export type PrepareConfig = Pick<OpenLedgerConfig, "dataDir" | "cacheDir">;

/** A failed --force keeps the prior file row and its transactions; only success replaces it. */
export async function prepareFile(
  db: Database.Database,
  cfg: PrepareConfig,
  entryOrId: string,
  roots: Pick<PathRoots, "cwd">,
  opts: PrepareOptions,
): Promise<PrepareOutcome> {
  const absPath = resolveEntryPath(db, cfg.dataDir, entryOrId, roots);
  if (absPath === null) {
    return { ok: false, reason: "not_found", message: `no ingest entry or file at "${entryOrId}"` };
  }

  const loaded = loadSource(absPath);
  if (!loaded.ok) return { ok: false, reason: loaded.reason, message: loaded.message };
  const source = loaded.value;

  // Registers now (except --force's swap): a file that never opens still needs an id.
  const prior = opts.force ? findFileByHash(db, source.hash) : null;
  const fileId = prior ? newFileId() : registerPendingFile(db, source);

  const readable = await readableBytes(source, opts.password);
  if (!readable.ok) return readable;

  const extracted = await extractFile(
    { kind: source.kind, bytes: readable.bytes },
    { read: opts.read, rescan: opts.rescan },
  );
  if (!extracted.ok) return extracted;

  const target: WriteTarget = { fileId, dir: resolve(cfg.cacheDir, fileId) };
  if (!prior) return writeDocument(extracted.value, target);

  // No row points at the new id until the swap lands, so done/fail/drop could never purge what a failure leaves.
  let written: PrepareSuccess;
  try {
    written = writeDocument(extracted.value, target);
    replaceFile(db, prior.id, pendingRow(source, fileId));
  } catch (thrown) {
    tryExecute(() => cleanCache(cfg.cacheDir, fileId));
    throw thrown;
  }
  cleanCache(cfg.cacheDir, prior.id);
  return written;
}
