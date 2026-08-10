import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { findFileById } from "../db/queries/files.js";
import { MAX_SOURCE_BYTES, loadSource, type LoadedSource } from "../extract/source.js";
import { pdfOf, textPdf } from "../../fixtures/pdf.js";
import { samplePng } from "../../fixtures/images.js";
import { freshDb } from "../../fixtures/db.js";
import { cleanCache, countNewFiles, registerPendingFile, resolveEntryPath } from "./files.js";

let dataDir: string;
let cacheDir: string;
let outsideDir: string; // outside the data dir, for the cwd-relative resolution case
const png = samplePng();

beforeEach(() => {
  dataDir = mkdtempSync(resolve(tmpdir(), "oled-files-data-"));
  cacheDir = mkdtempSync(resolve(tmpdir(), "oled-files-cache-"));
  outsideDir = mkdtempSync(resolve(tmpdir(), "oled-files-outside-"));
});

afterEach(() => {
  for (const dir of [dataDir, cacheDir, outsideDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function write(name: string, bytes: Buffer): string {
  const path = resolve(dataDir, name);
  writeFileSync(path, bytes);
  return path;
}

function loaded(path: string): LoadedSource {
  const source = loadSource(path);
  if (!source.ok) throw new Error(`fixture is not loadable: ${source.message}`);
  return source.value;
}

describe("countNewFiles", () => {
  it("counts what ingest has not registered, and stops counting once it has", () => {
    const db = freshDb();
    const path = write("a.pdf", textPdf());
    write("b.pdf", pdfOf(["text", "text"]));
    expect(countNewFiles(db, dataDir)).toBe(2);

    registerPendingFile(db, loaded(path));
    expect(countNewFiles(db, dataDir)).toBe(1);
  });

  it("skips what it could never read, so status never advertises phantom work", () => {
    const db = freshDb();
    write("real.pdf", textPdf());
    write("notes.docx", Buffer.from("PK"));
    const huge = resolve(dataDir, "huge.pdf");
    closeSync(openSync(huge, "w"));
    truncateSync(huge, MAX_SOURCE_BYTES + 1024);

    expect(countNewFiles(db, dataDir)).toBe(1);
  });

  it("is zero on an empty data dir", () => {
    expect(countNewFiles(freshDb(), dataDir)).toBe(0);
  });
});

describe("registerPendingFile", () => {
  it("inserts a pending row and dedups on re-register", () => {
    const db = freshDb();
    const source = loaded(write("a.pdf", textPdf()));

    const first = registerPendingFile(db, source);
    expect(first.alreadyKnown).toBe(false);
    expect(first.fileId.startsWith("sf-")).toBe(true);
    expect(findFileById(db, first.fileId)?.status).toBe("pending");

    const second = registerPendingFile(db, source);
    expect(second).toEqual({ fileId: first.fileId, alreadyKnown: true });
  });

  it("records the real mime, so an image is not filed as a PDF", () => {
    const db = freshDb();
    const { fileId } = registerPendingFile(db, loaded(write("receipt.png", png)));
    expect(findFileById(db, fileId)?.mime).toBe("image/png");
  });
});

describe("resolveEntryPath", () => {
  it("resolves a rel_path (as emitted by `ingest list`) relative to the data dir, regardless of cwd", () => {
    const db = freshDb();
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    const path = write("sub/b.pdf", textPdf());

    const elsewhere = mkdtempSync(resolve(tmpdir(), "oled-files-elsewhere-"));
    const prevCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      expect(resolveEntryPath(db, dataDir, "sub/b.pdf")).toBe(path);
    } finally {
      process.chdir(prevCwd);
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("still resolves an absolute path", () => {
    const db = freshDb();
    const path = write("a.pdf", textPdf());
    expect(resolveEntryPath(db, dataDir, path)).toBe(path);
  });

  it("still resolves a cwd-relative path when it isn't rooted under the data dir", () => {
    const db = freshDb();
    writeFileSync(resolve(outsideDir, "c.pdf"), textPdf());
    const prevCwd = process.cwd();
    process.chdir(outsideDir);
    try {
      // Compare against process.cwd(), not the pre-chdir string: macOS tmpdir is a
      // symlink that chdir resolves to its real path.
      expect(resolveEntryPath(db, dataDir, "c.pdf")).toBe(resolve(process.cwd(), "c.pdf"));
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("still resolves a file id", () => {
    const db = freshDb();
    const path = write("a.pdf", textPdf());
    const { fileId } = registerPendingFile(db, loaded(path));
    expect(resolveEntryPath(db, dataDir, fileId)).toBe(path);
  });

  it("returns null for a path or id that matches nothing", () => {
    const db = freshDb();
    expect(resolveEntryPath(db, dataDir, "sf-does-not-exist")).toBeNull();
    expect(resolveEntryPath(db, dataDir, "no/such/file.pdf")).toBeNull();
  });
});

describe("cleanCache", () => {
  it("purges that file's subdir and reports it", () => {
    const dir = resolve(cacheDir, "sf-1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "document.txt"), "text");

    expect(cleanCache(cacheDir, "sf-1").removed).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(cacheDir)).toBe(true);
  });

  it("is a no-op for a file that wrote no artifacts", () => {
    expect(cleanCache(cacheDir, "sf-nothing").removed).toEqual([]);
  });
});
