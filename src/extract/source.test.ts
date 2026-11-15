import { describe, it, expect, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SOURCE_BYTES, SUPPORTED_EXTS, loadSource, sniffSource } from "./source.js";
import { textPDF } from "../../fixtures/pdf.js";
import { samplePNG } from "../../fixtures/images.js";
import { removeTree } from "../../fixtures/sandbox.js";

// Sniffing reads signatures only, so a header is a complete jpeg or webp here.
const jpegBytes = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const webpBytes = () => Buffer.from("RIFF\0\0\0\0WEBP", "latin1");

const dir = mkdtempSync(join(tmpdir(), "oled-source-"));
afterAll(() => removeTree(dir));

function write(name: string, bytes: Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
}

describe("SUPPORTED_EXTS", () => {
  // The CLI quotes this list in its help text and hints.
  it("is the one pdf extension and three image extensions, in order", () => {
    expect(SUPPORTED_EXTS).toEqual([".pdf", ".png", ".jpg", ".jpeg"]);
  });
});

describe("sniffSource", () => {
  it("recognizes each accepted format from the real thing", () => {
    expect(sniffSource(textPDF())).toEqual({ kind: "pdf", mime: "application/pdf" });
    expect(sniffSource(samplePNG())).toEqual({ kind: "image", mime: "image/png" });
    expect(sniffSource(jpegBytes())).toEqual({ kind: "image", mime: "image/jpeg" });
  });

  it("finds a PDF header that sits behind a preamble", () => {
    const padded = Buffer.concat([Buffer.alloc(300, 0x20), textPDF()]);
    expect(sniffSource(padded)).toEqual({ kind: "pdf", mime: "application/pdf" });
  });

  it("returns null for bytes it cannot place, WebP among them", () => {
    expect(sniffSource(Buffer.from("just some text"))).toBeNull();
    expect(sniffSource(webpBytes())).toBeNull();
    expect(sniffSource(Buffer.alloc(0))).toBeNull();
  });
});

describe("loadSource", () => {
  it("loads a PDF with its kind, mime, bytes and content hash", () => {
    const bytes = textPDF();
    const path = write("statement.pdf", bytes);

    const result = loadSource(path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      path,
      kind: "pdf",
      mime: "application/pdf",
    });
    expect(result.value.bytes.equals(bytes)).toBe(true);
    expect(result.value.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("loads each image extension as kind image with the extension's mime", () => {
    const png = loadSource(write("receipt.png", samplePNG()));
    expect(png.ok).toBe(true);
    if (!png.ok) return;
    expect(png.value).toMatchObject({ kind: "image", mime: "image/png" });
    expect(png.value.bytes.equals(samplePNG())).toBe(true);

    expect(loadSource(write("a.jpg", jpegBytes()))).toMatchObject({
      ok: true,
      value: { kind: "image", mime: "image/jpeg" },
    });
    expect(loadSource(write("b.jpeg", jpegBytes()))).toMatchObject({
      ok: true,
      value: { kind: "image", mime: "image/jpeg" },
    });
  });

  it("rejects an extension it does not handle, WebP included, listing what it accepts", () => {
    const docx = loadSource(write("notes.docx", Buffer.from("PK")));
    expect(docx).toMatchObject({ ok: false, reason: "unsupported_extension" });
    if (!docx.ok) expect(docx.message).toContain(".docx");

    expect(loadSource(write("photo.webp", webpBytes()))).toEqual({
      ok: false,
      reason: "unsupported_extension",
      message: "unsupported extension .webp (accepted: .pdf .png .jpg .jpeg)",
    });
  });

  it("rejects bytes that disagree with the extension, naming what it found", () => {
    const result = loadSource(write("mislabeled.pdf", samplePNG()));
    expect(result).toMatchObject({ ok: false, reason: "kind_mismatch" });
    if (!result.ok) expect(result.message).toContain("image/png");
  });

  it("rejects a supported extension holding unrecognizable bytes", () => {
    const result = loadSource(write("empty.png", Buffer.alloc(0)));
    expect(result).toMatchObject({ ok: false, reason: "kind_mismatch" });
    if (!result.ok) expect(result.message).toContain("unrecognized");
  });

  it("rejects a file over the size cap without reading it", () => {
    const path = join(dir, "huge.pdf");
    closeSync(openSync(path, "w"));
    truncateSync(path, MAX_SOURCE_BYTES + 1024 * 1024);

    const result = loadSource(path);
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
  });

  it("reports a missing file as unreadable", () => {
    const result = loadSource(join(dir, "nope.pdf"));
    expect(result).toMatchObject({ ok: false, reason: "unreadable" });
    if (!result.ok) expect(result.message).toContain("ENOENT");
  });
});
