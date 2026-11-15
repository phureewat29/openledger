import { describe, it, expect } from "vitest";
import type { Raster } from "../ocr/raster.js";
import { decodeImage, renderPDFPage } from "./render.js";
import { LETTER, corruptPDF, pdfOf, scanPDF } from "../../fixtures/pdf.js";
import { corruptPNG, jpegOf, pngOf, samplePNG } from "../../fixtures/images.js";

function pixel(raster: Raster, x: number, y: number): number[] {
  const at = (y * raster.width + x) * raster.channels;
  return [...raster.data.subarray(at, at + raster.channels)];
}

describe("renderPDFPage", () => {
  it("draws a Letter page at 300 dpi as unpadded BGR rows, top row first", async () => {
    const rendered = await renderPDFPage(scanPDF(), 1);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const raster = rendered.value;
    expect(raster).toMatchObject({ width: 2550, height: 3300, channels: 3 });
    expect(raster.data).toHaveLength(2550 * 3300 * 3);
    expect(pixel(raster, 0, 0)).toEqual([0, 0, 255]);
    expect(pixel(raster, raster.width - 1, 0)).toEqual([0, 255, 0]);
    expect(pixel(raster, 0, raster.height - 1)).toEqual([255, 0, 0]);
  });

  it("caps the longest side at 3600 px when 300 dpi would overshoot it", async () => {
    const legal = { width: LETTER.width, height: 1008 };
    const rendered = await renderPDFPage(pdfOf(["text", "image"], legal), 2);
    expect(rendered.ok && rendered.value.height).toBe(3600);
    expect(rendered.ok && rendered.value.width).toBeCloseTo((legal.width * 3600) / legal.height, 0);
  });

  it("returns an error for bytes mupdf cannot open", async () => {
    expect(await renderPDFPage(corruptPDF(), 1)).toMatchObject({ ok: false });
  });
});

describe("decodeImage", () => {
  it("decodes a PNG and a JPEG at their own size as 3-channel BGR", async () => {
    const png = await decodeImage(samplePNG());
    expect(png.ok && png.value).toMatchObject({ width: 16, height: 16, channels: 3 });
    expect(png.ok && png.value.data).toHaveLength(16 * 16 * 3);

    const jpeg = await decodeImage(await jpegOf(8, 4, 200));
    expect(jpeg.ok && jpeg.value).toMatchObject({ width: 8, height: 4, channels: 3 });
    if (jpeg.ok) for (const value of jpeg.value.data) expect(Math.abs(value - 200)).toBeLessThanOrEqual(2);
  });

  it("drops alpha by laying the image on white, as paper", async () => {
    const opaqueRed: [number, number, number, number] = [255, 0, 0, 255];
    const halfRed: [number, number, number, number] = [128, 0, 0, 128];
    const clear: [number, number, number, number] = [0, 0, 0, 0];
    const decoded = await decodeImage(await pngOf([opaqueRed, halfRed, clear]));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toMatchObject({ width: 3, height: 1, channels: 3 });
    expect([...decoded.value.data]).toEqual([0, 0, 255, 127, 127, 255, 255, 255, 255]);
  });

  it("returns an error for an image body no decoder accepts", async () => {
    expect(await decodeImage(corruptPNG())).toMatchObject({ ok: false });
  });
});
