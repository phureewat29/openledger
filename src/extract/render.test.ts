import { describe, it, expect } from "vitest";
import type { Raster } from "../ocr/raster.js";
import { MAX_IMAGE_PIXELS, decodeImage, orient, renderPDFPage } from "./render.js";
import type { Orientation } from "./exif.js";
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

describe("orient", () => {
  /** 3 wide, 2 tall; each pixel's blue channel is its own index, so a move is visible. Row 0: 0 1 2, row 1: 3 4 5. */
  const source: Raster = {
    width: 3,
    height: 2,
    channels: 3,
    data: Uint8Array.from([0, 1, 2, 3, 4, 5].flatMap((n) => [n, 0, 0])),
  };
  const indexes = (raster: Raster): number[] => Array.from({ length: raster.width * raster.height }, (_, i) => raster.data[i * 3]);

  const EXPECTED: Record<Orientation, { width: number; height: number; indexes: number[] }> = {
    1: { width: 3, height: 2, indexes: [0, 1, 2, 3, 4, 5] },
    2: { width: 3, height: 2, indexes: [2, 1, 0, 5, 4, 3] },
    3: { width: 3, height: 2, indexes: [5, 4, 3, 2, 1, 0] },
    4: { width: 3, height: 2, indexes: [3, 4, 5, 0, 1, 2] },
    5: { width: 2, height: 3, indexes: [0, 3, 1, 4, 2, 5] },
    6: { width: 2, height: 3, indexes: [3, 0, 4, 1, 5, 2] },
    7: { width: 2, height: 3, indexes: [5, 2, 4, 1, 3, 0] },
    8: { width: 2, height: 3, indexes: [2, 5, 1, 4, 0, 3] },
  };

  it.each(Object.entries(EXPECTED))("orientation %s", (tag, want) => {
    const turned = orient(source, Number(tag) as Orientation);
    expect({ width: turned.width, height: turned.height, indexes: indexes(turned) }).toEqual(want);
  });
});

describe("decodeImage limits and orientation", () => {
  it("refuses an image over the pixel cap, naming its size and the limit", async () => {
    const mupdf = await import("mupdf");
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, 8000, 6300], false);
    const png = Buffer.from(pixmap.asPNG());
    pixmap.destroy();
    const decoded = await decodeImage(png);
    expect(decoded).toMatchObject({ ok: false, reason: "too_large" });
    expect(!decoded.ok && decoded.message).toContain("8000x6300");
    expect(!decoded.ok && decoded.message).toContain(MAX_IMAGE_PIXELS.toLocaleString("en-US"));
  });

  it("turns a JPEG tagged orientation 6 upright", async () => {
    const plain = await jpegOf(8, 4, 200);
    const app1 = Buffer.from([0xff, 0xe1, 0, 0x22, ...Buffer.from("Exif\0\0"), 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 1, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
    const tagged = Buffer.concat([plain.subarray(0, 2), app1, plain.subarray(2)]);
    const decoded = await decodeImage(tagged);
    expect(decoded.ok && decoded.value).toMatchObject({ width: 4, height: 8 });
  });
});
