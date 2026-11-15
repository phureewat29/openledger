import { describe, it, expect } from "vitest";
import { err, ok } from "../lib/result.js";
import type { Raster } from "../ocr/raster.js";
import { extractFile, type ExtractInput, type PageReader } from "./extract.js";
import { corruptPDF, mixedPDF, pdfOf, textPDF } from "../../fixtures/pdf.js";
import { corruptPNG, samplePNG } from "../../fixtures/images.js";

function pdfInput(bytes: Buffer): ExtractInput {
  return { kind: "pdf", bytes };
}

function imageInput(bytes: Buffer): ExtractInput {
  return { kind: "image", bytes };
}

/** Answers each page with its size, and keeps what it was handed. */
function fakeReader(): { read: PageReader; seen: Omit<Raster, "data">[] } {
  const seen: Omit<Raster, "data">[] = [];
  const read: PageReader = async ({ width, height, channels, data }) => {
    expect(data).toHaveLength(width * height * channels);
    seen.push({ width, height, channels });
    return ok(`read ${width}x${height}`);
  };
  return { read, seen };
}

function unavailableReader(): { read: PageReader; calls: () => number } {
  let calls = 0;
  const read: PageReader = async () => {
    calls += 1;
    return err("the engine did not load");
  };
  return { read, calls: () => calls };
}

describe("extractFile: text-layer route", () => {
  it("returns the probe's own text for a complete text layer, never calling the reader", async () => {
    const reader = fakeReader();
    const outcome = await extractFile(pdfInput(textPDF()), { read: reader.read });
    expect(outcome.ok && outcome.value).toMatchObject({ source: "text-layer", textLayer: "complete" });
    expect(outcome.ok && outcome.value.pages).toEqual([
      { page: 1, text: expect.stringContaining("1234.56 THB DEBIT ACME") },
    ]);
    expect(reader.seen).toEqual([]);
  });

  it("keeps a short digital slip, bare or with a logo, on its exact text layer", async () => {
    const reader = fakeReader();
    const outcome = await extractFile(pdfInput(pdfOf(["short", "logo"])), { read: reader.read });
    expect(outcome.ok && outcome.value).toMatchObject({ source: "text-layer", textLayer: "complete" });
    expect(reader.seen).toEqual([]);
  });
});

describe("extractFile: ocr route", () => {
  it("reads an image-only PDF page by page, each as a 300-dpi BGR raster", async () => {
    const reader = fakeReader();
    const outcome = await extractFile(pdfInput(pdfOf(["image", "image"])), { read: reader.read });
    expect(outcome.ok && outcome.value).toEqual({
      source: "ocr",
      textLayer: "none",
      pages: [
        { page: 1, text: "read 2550x3300" },
        { page: 2, text: "read 2550x3300" },
      ],
    });
    expect(reader.seen).toEqual([
      { width: 2550, height: 3300, channels: 3 },
      { width: 2550, height: 3300, channels: 3 },
    ]);
  });

  it("re-reads a partial document whole, so every page cites one source", async () => {
    const reader = fakeReader();
    const outcome = await extractFile(pdfInput(mixedPDF()), { read: reader.read });
    expect(outcome.ok && outcome.value).toMatchObject({ source: "ocr", textLayer: "partial" });
    expect(outcome.ok && outcome.value.pages.map((page) => page.page)).toEqual([1, 2, 3]);
    expect(reader.seen).toHaveLength(3);
  });

  it("reads an image as one page at its own size, without mupdf probing it", async () => {
    const reader = fakeReader();
    const outcome = await extractFile(imageInput(samplePNG()), { read: reader.read });
    expect(outcome.ok && outcome.value).toEqual({
      source: "ocr",
      textLayer: "none",
      pages: [{ page: 1, text: "read 16x16" }],
    });
  });

  it("--rescan reads a complete text layer by OCR instead", async () => {
    const reader = fakeReader();
    const outcome = await extractFile(pdfInput(textPDF()), { read: reader.read, rescan: true });
    expect(outcome.ok && outcome.value).toMatchObject({ source: "ocr", textLayer: "none" });
    expect(reader.seen).toHaveLength(1);
  });
});

describe("extractFile: failures", () => {
  it("stops at the first page the reader cannot read, as ocr_unavailable", async () => {
    const reader = unavailableReader();
    const outcome = await extractFile(pdfInput(pdfOf(["image", "image"])), { read: reader.read });
    expect(outcome).toEqual({ ok: false, reason: "ocr_unavailable", message: "the engine did not load" });
    expect(reader.calls()).toBe(1);
  });

  it("reports bytes mupdf cannot open as pdf_unreadable", async () => {
    const outcome = await extractFile(pdfInput(corruptPDF()), { read: fakeReader().read });
    expect(outcome).toMatchObject({ ok: false, reason: "pdf_unreadable" });
    if (!outcome.ok) expect(outcome.message).toBeTruthy();
  });

  it("reports an image body mupdf cannot decode as image_unreadable, before any read", async () => {
    const reader = fakeReader();
    const outcome = await extractFile(imageInput(corruptPNG()), { read: reader.read });
    expect(outcome).toMatchObject({ ok: false, reason: "image_unreadable" });
    expect(reader.seen).toEqual([]);
  });
});
