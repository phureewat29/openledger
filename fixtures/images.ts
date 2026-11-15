import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Read from disk (unlike pdf.ts's code-built fixtures) so image-input paths are exercised against a real file. 16x16 RGB, 112 bytes. */
export function samplePNG(): Buffer {
  return readFileSync(fileURLToPath(new URL("sample.png", import.meta.url)));
}

/** PNG magic bytes over a body no decoder accepts: it passes the sniff and fails the decode. */
export function corruptPNG(): Buffer {
  return Buffer.concat([samplePNG().subarray(0, 8), Buffer.from("not a png body", "latin1")]);
}

/** Pixels as premultiplied RGBA, the order mupdf holds them in. */
type RGBA = [number, number, number, number];

/** One row of pixels, encoded by mupdf (the writer, as in pdf.ts's `encryptedPDF`). */
export async function pngOf(pixels: RGBA[]): Promise<Buffer> {
  const mupdf = await import("mupdf");
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, pixels.length, 1], true);
  try {
    pixmap.getPixels().set(pixels.flat());
    return Buffer.from(pixmap.asPNG());
  } finally {
    pixmap.destroy();
  }
}

/** A flat-colour RGB JPEG, which survives lossy encoding to within a step or two. */
export async function jpegOf(width: number, height: number, gray: number): Promise<Buffer> {
  const mupdf = await import("mupdf");
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  try {
    pixmap.clear(gray);
    return Buffer.from(pixmap.asJPEG(95));
  } finally {
    pixmap.destroy();
  }
}
