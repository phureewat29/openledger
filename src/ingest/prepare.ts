import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type Database from "libsql";
import type { OpenLedgerConfig } from "../config/config.js";
import { findFileByHash, replaceFile } from "../files/queries.js";
import { extractFile, type Extraction, type TextPage } from "../extract/extract.js";
import { resolveOCR, type OCRConfigSource } from "../extract/ocr.js";
import { isEncryptedPDF, unlockPDF, type UnlockFailureReason } from "../extract/pdf.js";
import { loadSource, type LoadedSource } from "../extract/source.js";
import { newFileId } from "../lib/ids.js";
import { ok, tryExecute, type Result } from "../lib/result.js";
import {
  RM_OPTS,
  cleanCache,
  pendingRow,
  registerPendingFile,
  resolveEntryPath,
  walkFiles,
  type WalkedFile,
} from "../files/files.js";
import type { IngestFile, PrepareImagesResult, PrepareTextResult, TextLayer } from "../contract/ingest.js";

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
  password?: string;
  /** Re-reads bytes, then replaces the prior row, dropping its transactions,
   *  questions, and artifacts. */
  force?: boolean;
  /** Ignore the text layer, for garbled or junk layers. */
  rescan?: boolean;
  /** Ignore the OCR endpoint, and read the page images yourself. */
  noOCR?: boolean;
}

export type PrepareFailure =
  | "not_found"
  | "unsupported_extension"
  | "kind_mismatch"
  | "too_large"
  | "unreadable"
  | "pdf_unreadable"
  | "password_required"
  | "wrong_password"
  | "ocr_unreachable"
  | "ocr_rejected";

interface TextPageChars {
  page: number;
  chars: number;
}

interface ImagePagePath {
  page: number;
  path: string;
}

type PrepareOutcome =
  | {
      ok: true;
      fileId: string;
      kind: "text";
      source: PrepareTextResult["source"];
      textLayer: TextLayer;
      /** The model that read the pages, on the ocr route only. */
      model?: string;
      pageCount: number;
      /** One file to read, pages separated by `--- page N ---` markers. */
      document: string;
      pages: TextPageChars[];
      /** Pages whose text is a placeholder because the endpoint failed on them. */
      failedPages: number[];
    }
  | {
      ok: true;
      fileId: string;
      kind: "images";
      source: PrepareImagesResult["source"];
      textLayer: TextLayer;
      pageCount: number;
      /** Present when the pages were rasterized from a PDF. */
      dpi?: number;
      pages: ImagePagePath[];
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
  /** The input file's own path: what an untouched image page cites. */
  sourcePath: string;
}

/** Rebuilt per prepare, so a prior run's artifacts can never be mistaken for this one's. */
function freshDir(dir: string): void {
  rmSync(dir, RM_OPTS);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeDocument(
  extraction: Extract<Extraction, { kind: "text" }>,
  target: WriteTarget,
): PrepareSuccess {
  freshDir(target.dir);
  const document = resolve(target.dir, DOCUMENT_FILE);
  writeFileSync(document, documentText(extraction.pages), { mode: 0o600 });
  return {
    ok: true,
    fileId: target.fileId,
    kind: "text",
    source: extraction.source,
    textLayer: extraction.textLayer,
    model: extraction.model,
    pageCount: extraction.pages.length,
    document,
    pages: extraction.pages.map((page) => ({ page: page.page, chars: page.text.length })),
    failedPages: extraction.failedPages,
  };
}

function writePages(
  extraction: Extract<Extraction, { kind: "images" }>,
  target: WriteTarget,
): PrepareSuccess {
  const head = {
    ok: true as const,
    fileId: target.fileId,
    kind: "images" as const,
    source: extraction.source,
    textLayer: extraction.textLayer,
    pageCount: extraction.pages.length,
    dpi: extraction.dpi,
  };

  // An untouched image is read where it lies; only a prior run's artifacts could be there to mislead.
  if (extraction.source === "original") {
    rmSync(target.dir, RM_OPTS);
    const pages = extraction.pages.map((page) => ({ page: page.page, path: target.sourcePath }));
    return { ...head, pages };
  }

  freshDir(target.dir);
  const pages = extraction.pages.map((page): ImagePagePath => {
    const path = resolve(target.dir, `p${page.page}.png`);
    writeFileSync(path, page.bytes, { mode: 0o600 });
    return { page: page.page, path };
  });
  return { ...head, pages };
}

const WRITE_ARTIFACTS: {
  [K in Extraction["kind"]]: (
    extraction: Extract<Extraction, { kind: K }>,
    target: WriteTarget,
  ) => PrepareSuccess;
} = {
  text: writeDocument,
  images: writePages,
};

export type PrepareConfig = Pick<OpenLedgerConfig, "dataDir" | "cacheDir"> & OCRConfigSource;

/** A failed --force keeps the prior file row and its transactions; only success replaces it. */
export async function prepareFile(
  db: Database.Database,
  cfg: PrepareConfig,
  entryOrId: string,
  opts: PrepareOptions = {},
): Promise<PrepareOutcome> {
  const absPath = resolveEntryPath(db, cfg.dataDir, entryOrId);
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
    { kind: source.kind, mime: source.mime, bytes: readable.bytes, path: source.path },
    { ocr: resolveOCR(cfg), overrides: { rescan: opts.rescan, noOCR: opts.noOCR } },
  );
  if (!extracted.ok) return { ok: false, reason: extracted.reason, message: extracted.message };

  const target: WriteTarget = {
    fileId,
    dir: resolve(cfg.cacheDir, fileId),
    sourcePath: source.path,
  };
  const written = WRITE_ARTIFACTS[extracted.value.kind](extracted.value as never, target);
  if (!prior) return written;

  // A failed swap leaves no row pointing at the new artifacts, so done/fail/drop could never purge them.
  try {
    replaceFile(db, prior.id, pendingRow(source, fileId));
  } catch (err) {
    cleanCache(cfg.cacheDir, fileId);
    throw err;
  }
  cleanCache(cfg.cacheDir, prior.id);
  return written;
}
