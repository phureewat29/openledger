import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { findFileById, listFiles } from "./queries.js";
import { MAX_SOURCE_BYTES, loadSource, type LoadedSource } from "../extract/source.js";
import { pdfOf, textPDF } from "../../fixtures/pdf.js";
import { samplePNG } from "../../fixtures/images.js";
import { freshDB } from "../../fixtures/db.js";
import {
  cleanCache,
  countNewFiles,
  registerPendingFile,
  resolveEntryPath,
  walkFiles,
} from "./files.js";

let dataDir: string;
let cacheDir: string;
let outsideDir: string; // outside the data dir, for the cwd-relative resolution case
const png = samplePNG();

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
    const db = freshDB();
    const path = write("a.pdf", textPDF());
    write("b.pdf", pdfOf(["text", "text"]));
    expect(countNewFiles(db, dataDir)).toBe(2);

    registerPendingFile(db, loaded(path));
    expect(countNewFiles(db, dataDir)).toBe(1);
  });

  it("skips what it could never read, so status never advertises phantom work", () => {
    const db = freshDB();
    write("real.pdf", textPDF());
    write("notes.docx", Buffer.from("PK"));
    const huge = resolve(dataDir, "huge.pdf");
    closeSync(openSync(huge, "w"));
    truncateSync(huge, MAX_SOURCE_BYTES + 1024);

    expect(countNewFiles(db, dataDir)).toBe(1);
  });

  it("is zero on an empty data dir", () => {
    expect(countNewFiles(freshDB(), dataDir)).toBe(0);
  });
});

describe("registerPendingFile", () => {
  it("inserts a pending row and dedups on re-register", () => {
    const db = freshDB();
    const source = loaded(write("a.pdf", textPDF()));

    const first = registerPendingFile(db, source);
    expect(first.startsWith("sf-")).toBe(true);
    expect(findFileById(db, first)?.status).toBe("pending");

    expect(registerPendingFile(db, source)).toBe(first);
    expect(listFiles(db)).toHaveLength(1);
  });

  it("records the real mime, so an image is not filed as a PDF", () => {
    const db = freshDB();
    const fileId = registerPendingFile(db, loaded(write("receipt.png", png)));
    expect(findFileById(db, fileId)?.mime).toBe("image/png");
  });
});

describe("resolveEntryPath", () => {
  it("resolves a rel_path (as emitted by `ingest list`) relative to the data dir, whatever the cwd", () => {
    const db = freshDB();
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    const path = write("sub/b.pdf", textPDF());
    expect(resolveEntryPath(db, dataDir, "sub/b.pdf", outsideDir)).toBe(path);
  });

  it("still resolves an absolute path", () => {
    const db = freshDB();
    const path = write("a.pdf", textPDF());
    expect(resolveEntryPath(db, dataDir, path, outsideDir)).toBe(path);
  });

  it("resolves a relative path against the given cwd when it isn't rooted under the data dir", () => {
    const db = freshDB();
    writeFileSync(resolve(outsideDir, "c.pdf"), textPDF());
    expect(resolveEntryPath(db, dataDir, "c.pdf", outsideDir)).toBe(resolve(outsideDir, "c.pdf"));
  });

  it("still resolves a file id", () => {
    const db = freshDB();
    const path = write("a.pdf", textPDF());
    const fileId = registerPendingFile(db, loaded(path));
    expect(resolveEntryPath(db, dataDir, fileId, outsideDir)).toBe(path);
  });

  it("returns null for a path or id that matches nothing", () => {
    const db = freshDB();
    expect(resolveEntryPath(db, dataDir, "sf-does-not-exist", outsideDir)).toBeNull();
    expect(resolveEntryPath(db, dataDir, "no/such/file.pdf", outsideDir)).toBeNull();
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

  it("purges a legacy `sf:` id's subdir too", () => {
    const id = "sf:3f1c2a9e-0b4d-4c7e-9a1f-5d6e7f809a1b";
    const dir = resolve(cacheDir, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "document.txt"), "text");

    expect(cleanCache(cacheDir, id).removed).toEqual([dir]);
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses any id that is not exactly one entry inside the cache dir", () => {
    // Nested, so a broken guard could only ever reach this test's own temp dirs.
    const cache = resolve(cacheDir, "cache");
    mkdirSync(resolve(cache, "sf-1", "nested"), { recursive: true });
    mkdirSync(resolve(cache, "sf-2"));

    for (const id of ["..", ".", "", "sf-1/nested", "sf-1/../..", "sf-1/../sf-2", "sf:1/../..", outsideDir]) {
      expect(() => cleanCache(cache, id), id).toThrow(/refusing to clean/);
    }
    expect(existsSync(resolve(cache, "sf-1", "nested"))).toBe(true);
    expect(existsSync(resolve(cache, "sf-2"))).toBe(true);
    expect(existsSync(outsideDir)).toBe(true);
  });
});

describe("walkFiles", () => {
  it("cuts a symlink back into an ancestor, listing each file once", () => {
    mkdirSync(resolve(dataDir, "sub"));
    write("sub/a.pdf", textPDF());
    symlinkSync(dataDir, resolve(dataDir, "sub", "loop"), "dir");

    expect(walkFiles(dataDir).map((f) => f.relPath)).toEqual(["sub/a.pdf"]);
  });

  it("still follows a symlinked directory that closes no cycle", () => {
    writeFileSync(resolve(outsideDir, "b.pdf"), textPDF());
    symlinkSync(outsideDir, resolve(dataDir, "linked"), "dir");

    expect(walkFiles(dataDir).map((f) => f.relPath)).toEqual(["linked/b.pdf"]);
  });
});
