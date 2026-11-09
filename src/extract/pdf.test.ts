import { describe, it, expect } from "vitest";
import { classifyPage } from "./route.js";
import { isEncryptedPDF, probePDFPages, renderPDFPages, unlockPDF } from "./pdf.js";
import {
  corruptPDF,
  encryptedPDF,
  mixedPDF,
  pngSize,
  scanPDF,
  textPDF,
} from "../../fixtures/pdf.js";

const RENDER = { dpi: 200, maxLongestDimPx: 1800 };

describe("probePDFPages", () => {
  it("extracts the text layer and measures it in one pass, 1-based", async () => {
    const probe = await probePDFPages(textPDF());
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value).toHaveLength(1);
    expect(probe.value[0].page).toBe(1);
    expect(probe.value[0].chars).toBeGreaterThan(400);
    expect(probe.value[0].chars).toBe(probe.value[0].text.length);
    expect(probe.value[0].text).toContain("1234.56 THB DEBIT ACME");
    expect(probe.value[0].hasImage).toBe(false);
  });

  it("sees the image block on a scanned page with no text", async () => {
    const probe = await probePDFPages(scanPDF());
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value[0]).toMatchObject({ page: 1, chars: 0, hasImage: true });
  });

  it("classifies a mixed document as text, blank, scan: a partial text layer", async () => {
    const probe = await probePDFPages(mixedPDF());
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.map(classifyPage)).toEqual(["text", "blank", "scan"]);
    expect(probe.value.map((page) => page.page)).toEqual([1, 2, 3]);
  });

  it("returns an error for bytes mupdf cannot open", async () => {
    const probe = await probePDFPages(corruptPDF());
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.error).toBeTruthy();
  });
});

describe("renderPDFPages", () => {
  it("renders every page to a PNG, 1-based, capped on the longest side", async () => {
    const rendered = await renderPDFPages(mixedPDF(), RENDER);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.map((page) => page.page)).toEqual([1, 2, 3]);

    for (const page of rendered.value) {
      expect(page.mime).toBe("image/png");
      expect(page.bytes[0]).toBe(0x89);
      expect(page.bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
      // A 612x792pt page: the 1800px cap binds before 200dpi does.
      expect(pngSize(page.bytes)).toEqual({ width: 1391, height: 1800 });
    }
  });

  it("scales by dpi when the page is small enough to stay under the cap", async () => {
    const rendered = await renderPDFPages(textPDF(), { dpi: 72, maxLongestDimPx: 1800 });
    expect(rendered.ok).toBe(true);
    if (rendered.ok) expect(pngSize(rendered.value[0].bytes)).toEqual({ width: 612, height: 792 });
  });

  it("returns an error for bytes mupdf cannot open", async () => {
    const rendered = await renderPDFPages(corruptPDF(), RENDER);
    expect(rendered.ok).toBe(false);
  });
});

describe("isEncryptedPDF / unlockPDF", () => {
  it("passes an unencrypted document through untouched", async () => {
    const bytes = textPDF();
    expect(await isEncryptedPDF(bytes)).toBe(false);
    const result = await unlockPDF(bytes, "");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decrypted).toBe(bytes);
  });

  it("decrypts with the right password, and the result reads as a normal PDF", async () => {
    const bytes = await encryptedPDF("secret");
    expect(await isEncryptedPDF(bytes)).toBe(true);

    const result = await unlockPDF(bytes, "secret");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await isEncryptedPDF(result.decrypted)).toBe(false);
    const probe = await probePDFPages(result.decrypted);
    expect(probe.ok && probe.value[0].chars).toBeGreaterThan(400);
  });

  it("reports a wrong password without throwing", async () => {
    const result = await unlockPDF(await encryptedPDF("secret"), "nope");
    expect(result).toEqual({ ok: false, reason: "wrong_password" });
  });
});
