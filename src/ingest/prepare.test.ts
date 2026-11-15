import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type Database from "libsql";
import { createAccount } from "../accounts/accounts.js";
import { upsertMerchant } from "../merchants/queries.js";
import { insertTransaction, countTransactionsBySourceFile } from "../transactions/queries.js";
import { findFileById } from "../files/queries.js";
import { err, ok } from "../lib/result.js";
import type { PageReader } from "../extract/extract.js";
import { MAX_SOURCE_BYTES, loadSource, type LoadedSource } from "../extract/source.js";
import { corruptPDF, encryptedPDF, mixedPDF, pdfOf, scanPDF, textPDF } from "../../fixtures/pdf.js";
import { corruptPNG, samplePNG } from "../../fixtures/images.js";
import { failingStatement, freshDB } from "../../fixtures/db.js";
import { registerPendingFile } from "../files/files.js";
import { discoverFiles, prepareFile, type PrepareConfig } from "./prepare.js";
import { removeTree } from "../../fixtures/sandbox.js";
import { expectMode } from "../../fixtures/modes.js";

// Pass-through, so a single test can fail one artifact write the way a full disk would.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let dataDir: string;
let cacheDir: string;
let cfg: PrepareConfig;
const roots = { cwd: process.cwd() };
const png = samplePNG();

const read: PageReader = async () => ok("ocr text");
const unavailable: PageReader = async () => err("the engine did not load");

beforeEach(() => {
  dataDir = mkdtempSync(resolve(tmpdir(), "oled-ingest-data-"));
  cacheDir = mkdtempSync(resolve(tmpdir(), "oled-ingest-cache-"));
  cfg = { dataDir, cacheDir };
});

afterEach(() => Promise.all([dataDir, cacheDir].map(removeTree)));

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

describe("discoverFiles", () => {
  it("walks recursively, dedups by hash, and flags known files", async () => {
    const db = freshDB();
    write("a.pdf", textPDF());
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    write("sub/b.pdf", textPDF());

    const first = await discoverFiles(db, dataDir);
    expect(first).toHaveLength(2);
    expect(first.every((e) => e.status === "new" && e.fileId === null)).toBe(true);
    expect(first.every((e) => !e.encrypted)).toBe(true);
    expect(first.map((e) => e.relPath).sort()).toEqual(["a.pdf", "sub/b.pdf"]);

    const target = first.find((e) => e.relPath === "a.pdf")!;
    const fileId = registerPendingFile(db, loaded(target.path));

    const second = await discoverFiles(db, dataDir);
    const known = second.find((e) => e.relPath === "a.pdf")!;
    expect(known.status).toBe("pending");
    expect(known.fileId).toBe(fileId);
  });

  it("filters by regex against the relative path", async () => {
    const db = freshDB();
    write("a.pdf", textPDF());
    mkdirSync(resolve(dataDir, "sub"), { recursive: true });
    write("sub/b.pdf", textPDF());

    const entries = await discoverFiles(db, dataDir, { regex: /^sub\// });
    expect(entries.map((e) => e.relPath)).toEqual(["sub/b.pdf"]);
  });

  it("lists images alongside PDFs and ignores extensions it cannot read", async () => {
    const db = freshDB();
    write("statement.pdf", textPDF());
    write("receipt.png", png);
    write("notes.docx", Buffer.from("PK"));

    const entries = await discoverFiles(db, dataDir);
    expect(entries.map((e) => e.relPath).sort()).toEqual(["receipt.png", "statement.pdf"]);
  });

  it("reports an oversized file as unreadable instead of sinking the walk", async () => {
    const db = freshDB();
    write("small.pdf", textPDF());
    const huge = resolve(dataDir, "huge.pdf");
    closeSync(openSync(huge, "w"));
    truncateSync(huge, MAX_SOURCE_BYTES + 1024);

    const entries = await discoverFiles(db, dataDir);
    const big = entries.find((e) => e.relPath === "huge.pdf")!;
    expect(big).toMatchObject({ status: "unreadable", hash: null, fileId: null });
    expect(big.note).toBeTruthy();
    expect(entries.find((e) => e.relPath === "small.pdf")!.status).toBe("new");
  });

  it("reports a PDF it cannot open as unreadable, naming the reason", async () => {
    const db = freshDB();
    write("broken.pdf", corruptPDF());

    const [entry] = await discoverFiles(db, dataDir);
    expect(entry.status).toBe("unreadable");
    expect(entry.note).toBeTruthy();
  });

  it("reports encryption and never probes an image", async () => {
    const db = freshDB();
    write("kbank.pdf", await encryptedPDF("secret"));
    write("kbank.png", png);

    const entries = await discoverFiles(db, dataDir);
    expect(entries.find((e) => e.relPath === "kbank.pdf")).toMatchObject({ encrypted: true });
    expect(entries.find((e) => e.relPath === "kbank.png")).toMatchObject({ encrypted: false });
  });
});

describe("prepareFile: text-layer route", () => {
  it("writes one document.txt (0600, in a 0700 dir) with a marker per page", async () => {
    const db = freshDB();
    // A blank middle page does not spoil "complete", so this stays on the text-layer route.
    const path = write("a.pdf", pdfOf(["text", "blank", "text"]));

    const outcome = await prepareFile(db, cfg, path, roots, { read });
    expect(outcome).toMatchObject({ ok: true, source: "text-layer", textLayer: "complete" });
    if (!outcome.ok) return;

    expect(outcome.document).toBe(resolve(cacheDir, outcome.fileId, "document.txt"));
    expectMode(outcome.document, 0o600);
    expectMode(resolve(cacheDir, outcome.fileId), 0o700);

    const text = readFileSync(outcome.document, "utf8");
    expect(text).toContain("--- page 1 ---");
    expect(text).toContain("--- page 3 ---");
    expect(text).toContain("1234.56 THB DEBIT ACME");
    expect(outcome.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(outcome.pages[0].chars).toBeGreaterThan(0);
  });

  it("resolves a file id as readily as a path", async () => {
    const db = freshDB();
    const path = write("a.pdf", textPDF());
    const fileId = registerPendingFile(db, loaded(path));

    const outcome = await prepareFile(db, cfg, fileId, roots, { read });
    expect(outcome.ok && outcome.fileId).toBe(fileId);
  });

  it("extracts a locked PDF's text without ever writing the statement itself to disk", async () => {
    const db = freshDB();
    const path = write("kbank.pdf", await encryptedPDF("secret"));

    const outcome = await prepareFile(db, cfg, path, roots, { read, password: "secret" });
    expect(outcome).toMatchObject({ ok: true, source: "text-layer" });
    if (!outcome.ok) return;

    expect(readFileSync(outcome.document, "utf8")).toContain("--- page 1 ---");
    expect(readdirSync(resolve(cacheDir, outcome.fileId))).toEqual(["document.txt"]);
  });

  it("purges a prior run's artifacts before writing its own", async () => {
    const db = freshDB();
    const path = write("a.pdf", textPDF());

    const first = await prepareFile(db, cfg, path, roots, { read });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const dir = resolve(cacheDir, first.fileId);
    writeFileSync(resolve(dir, "leftover.txt"), "stale");

    const second = await prepareFile(db, cfg, path, roots, { read });
    expect(second.ok && second.fileId).toBe(first.fileId);
    expect(readdirSync(dir)).toEqual(["document.txt"]);
  });
});

describe("prepareFile: ocr route", () => {
  it("reads an image into the same one-document shape", async () => {
    const db = freshDB();
    const path = write("receipt.png", png);

    const outcome = await prepareFile(db, cfg, path, roots, { read });
    expect(outcome).toMatchObject({
      ok: true,
      source: "ocr",
      textLayer: "none",
      pages: [{ page: 1, chars: "ocr text".length }],
    });
    if (!outcome.ok) return;
    expect(readFileSync(outcome.document, "utf8")).toBe("--- page 1 ---\nocr text\n");
    expectMode(outcome.document, 0o600);
  });

  it("reads every page of a partial text layer, cache modes intact", async () => {
    const db = freshDB();
    const path = write("mixed.pdf", mixedPDF());

    const outcome = await prepareFile(db, cfg, path, roots, { read });
    expect(outcome).toMatchObject({ ok: true, source: "ocr", textLayer: "partial" });
    if (!outcome.ok) return;
    expect(outcome.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expectMode(outcome.document, 0o600);
    expectMode(resolve(cacheDir, outcome.fileId), 0o700);
  });

  it("--rescan ignores a good text layer and reads by OCR instead", async () => {
    const db = freshDB();
    const path = write("a.pdf", textPDF());

    const outcome = await prepareFile(db, cfg, path, roots, { read, rescan: true });
    expect(outcome).toMatchObject({ ok: true, source: "ocr", textLayer: "none" });
  });
});

describe("prepareFile: refusals", () => {
  it("reports a missing path or id as not_found", async () => {
    const db = freshDB();
    const outcome = await prepareFile(db, cfg, "no/such/statement.pdf", roots, { read });
    expect(outcome).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("reports an extension it cannot read", async () => {
    const db = freshDB();
    const outcome = await prepareFile(db, cfg, write("notes.docx", Buffer.from("PK")), roots, { read });
    expect(outcome).toMatchObject({ ok: false, reason: "unsupported_extension" });
  });

  it("reports bytes that disagree with the extension", async () => {
    const db = freshDB();
    const outcome = await prepareFile(db, cfg, write("mislabeled.pdf", png), roots, { read });
    expect(outcome).toMatchObject({ ok: false, reason: "kind_mismatch" });
  });

  it("reports a PDF mupdf cannot open", async () => {
    const db = freshDB();
    const outcome = await prepareFile(db, cfg, write("broken.pdf", corruptPDF()), roots, { read });
    expect(outcome).toMatchObject({ ok: false, reason: "pdf_unreadable" });
  });

  it("reports password_required for a locked PDF with no password to try", async () => {
    const db = freshDB();
    const path = write("kbank.pdf", await encryptedPDF("secret"));
    const outcome = await prepareFile(db, cfg, path, roots, { read });
    expect(outcome).toMatchObject({ ok: false, reason: "password_required" });
  });

  it("reports wrong_password for a password that does not open it", async () => {
    const db = freshDB();
    const path = write("kbank.pdf", await encryptedPDF("secret"));
    const outcome = await prepareFile(db, cfg, path, roots, { read, password: "nope" });
    expect(outcome).toMatchObject({ ok: false, reason: "wrong_password" });
  });

  it("reports an image body mupdf cannot decode as image_unreadable", async () => {
    const db = freshDB();
    const outcome = await prepareFile(db, cfg, write("receipt.png", corruptPNG()), roots, { read });
    expect(outcome).toMatchObject({ ok: false, reason: "image_unreadable" });
  });

  it("reports ocr_unavailable when the reader cannot run, writing no artifacts", async () => {
    const db = freshDB();
    const outcome = await prepareFile(db, cfg, write("scan.pdf", scanPDF()), roots, { read: unavailable });
    expect(outcome).toEqual({ ok: false, reason: "ocr_unavailable", message: "the engine did not load" });
    expect(readdirSync(cacheDir)).toEqual([]);
  });
});

describe("prepareFile: --force", () => {
  // A re-prepare needs something to lose.
  function commitRow(db: Database.Database, fileId: string): void {
    createAccount(db, { id: "thb:expense", name: "Expenses (THB)", type: "expense", parent_id: null });
    createAccount(db, { id: "thb:asset", name: "Assets (THB)", type: "asset", parent_id: null });
    const merchant = upsertMerchant(db, { canonical_name: "Shop" }, []);
    insertTransaction(db, {
      date: "2026-05-01",
      description: "Shop",
      merchant_id: merchant.id,
      source_file_id: fileId,
      debit_account_id: "thb:expense",
      credit_account_id: "thb:asset",
      amount: 1000,
    });
    expect(countTransactionsBySourceFile(db, fileId)).toBe(1);
  }

  it("re-registers the bytes, cascading away the prior ingest's transactions and artifacts", async () => {
    const db = freshDB();
    const path = write("scan.pdf", scanPDF());

    const first = await prepareFile(db, cfg, path, roots, { read });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const oldDir = resolve(cacheDir, first.fileId);
    expect(existsSync(oldDir)).toBe(true);
    commitRow(db, first.fileId);

    const second = await prepareFile(db, cfg, path, roots, { read, force: true });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.fileId).not.toBe(first.fileId);
    expect(findFileById(db, first.fileId)).toBeNull();
    expect(countTransactionsBySourceFile(db, first.fileId)).toBe(0);
    expect(existsSync(oldDir)).toBe(false);
    expect(findFileById(db, second.fileId)?.status).toBe("pending");
    expect(existsSync(second.document)).toBe(true);
  });

  it("keeps the prior row and its transactions when the password does not open it", async () => {
    const db = freshDB();
    const path = write("kbank.pdf", await encryptedPDF("secret"));
    // Registered by hash without ever unlocking it, so only the wrong password below is tried.
    const fileId = registerPendingFile(db, loaded(path));
    commitRow(db, fileId);

    const forced = await prepareFile(db, cfg, path, roots, { read, force: true, password: "nope" });
    expect(forced).toMatchObject({ ok: false, reason: "wrong_password" });
    expect(findFileById(db, fileId)?.status).toBe("pending");
    expect(countTransactionsBySourceFile(db, fileId)).toBe(1);
  });

  it("keeps the prior row, its transactions and its artifacts when OCR is unavailable", async () => {
    const db = freshDB();
    const path = write("scan.pdf", scanPDF());

    const first = await prepareFile(db, cfg, path, roots, { read });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitRow(db, first.fileId);

    const forced = await prepareFile(db, cfg, path, roots, { read: unavailable, force: true });
    expect(forced).toMatchObject({ ok: false, reason: "ocr_unavailable" });
    expect(findFileById(db, first.fileId)?.status).toBe("pending");
    expect(countTransactionsBySourceFile(db, first.fileId)).toBe(1);
    expect(readdirSync(cacheDir)).toEqual([first.fileId]);
  });

  it("purges the new artifacts and keeps the prior row when the swap fails", async () => {
    const db = freshDB();
    const path = write("scan.pdf", scanPDF());

    const first = await prepareFile(db, cfg, path, roots, { read });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitRow(db, first.fileId);

    const broken = failingStatement(db, "DELETE FROM files");
    await expect(prepareFile(broken, cfg, path, roots, { read, force: true })).rejects.toThrow("disk I/O error");
    expect(readdirSync(cacheDir)).toEqual([first.fileId]);
    expect(findFileById(db, first.fileId)?.status).toBe("pending");
    expect(countTransactionsBySourceFile(db, first.fileId)).toBe(1);
  });

  it("purges the new artifacts and keeps the prior row when writing them fails", async () => {
    const db = freshDB();
    const path = write("statement.pdf", textPDF());

    const first = await prepareFile(db, cfg, path, roots, { read });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    commitRow(db, first.fileId);

    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("ENOSPC: no space left on device, write");
    });
    await expect(prepareFile(db, cfg, path, roots, { read, force: true })).rejects.toThrow("ENOSPC");
    expect(readdirSync(cacheDir)).toEqual([first.fileId]);
    expect(findFileById(db, first.fileId)?.status).toBe("pending");
    expect(countTransactionsBySourceFile(db, first.fileId)).toBe(1);
  });
});
