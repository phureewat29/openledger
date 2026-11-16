import type { Pixmap, Rect } from "mupdf";
import { tryExecute } from "../lib/result.js";
import type { Raster } from "../ocr/raster.js";
import { exifOrientation, type Orientation } from "./exif.js";
import { PDF_MIME, destroyAfter, loadMupdf } from "./pdf.js";

/** Thai tone marks and vowels stay legible at 300 dpi; the cap bounds the raster of an oversized page. */
const RENDER_DPI = 300;
const MAX_LONGEST_SIDE_PX = 3600;
const POINTS_PER_INCH = 72;

/** A decoded image is not capped by resolution like a PDF page, so its pixel count is what bounds memory. */
export const MAX_IMAGE_PIXELS = 50_000_000;

const BGR_CHANNELS = 3;
const OPAQUE = 255;

function withoutPadding(samples: Uint8ClampedArray, stride: number, width: number, height: number): Uint8Array {
  const row = width * BGR_CHANNELS;
  const data = new Uint8Array(row * height);
  for (let y = 0; y < height; y++) data.set(samples.subarray(y * stride, y * stride + row), y * row);
  return data;
}

/** mupdf's samples are premultiplied, so over white each channel gains whatever its alpha leaves uncovered. */
function onWhite(samples: Uint8ClampedArray, stride: number, width: number, height: number): Uint8Array {
  const data = new Uint8Array(width * height * BGR_CHANNELS);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const from = y * stride + x * (BGR_CHANNELS + 1);
      const to = (y * width + x) * BGR_CHANNELS;
      const uncovered = OPAQUE - samples[from + BGR_CHANNELS];
      data[to] = samples[from] + uncovered;
      data[to + 1] = samples[from + 1] + uncovered;
      data[to + 2] = samples[from + 2] + uncovered;
    }
  }
  return data;
}

/** Copies a BGR pixmap out of WASM memory row by row, since mupdf may pad a row; statements assume paper, so alpha lands on white. */
function rasterOf(pixmap: Pixmap): Raster {
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const stride = pixmap.getStride();
  const flatten = pixmap.getAlpha() > 0 ? onWhite : withoutPadding;
  return { width, height, channels: BGR_CHANNELS, data: flatten(pixmap.getPixels(), stride, width, height) };
}

export type RenderFailure = { ok: false; reason: "too_large" | "unreadable"; message: string };
export type RenderOutcome = { ok: true; value: Raster } | RenderFailure;

const unreadable = (message: string): RenderFailure => ({ ok: false, reason: "unreadable", message });

interface Layout {
  width: number;
  height: number;
  /** Where an output pixel reads from in the stored image. */
  source: (x: number, y: number) => [number, number];
}

/** What the EXIF tag asks a viewer to do to the stored pixels, as output coordinates to stored coordinates. */
const ORIENT: Record<Orientation, (w: number, h: number) => Layout> = {
  1: (w, h) => ({ width: w, height: h, source: (x, y) => [x, y] }),
  2: (w, h) => ({ width: w, height: h, source: (x, y) => [w - 1 - x, y] }),
  3: (w, h) => ({ width: w, height: h, source: (x, y) => [w - 1 - x, h - 1 - y] }),
  4: (w, h) => ({ width: w, height: h, source: (x, y) => [x, h - 1 - y] }),
  5: (w, h) => ({ width: h, height: w, source: (x, y) => [y, x] }),
  6: (w, h) => ({ width: h, height: w, source: (x, y) => [y, h - 1 - x] }),
  7: (w, h) => ({ width: h, height: w, source: (x, y) => [w - 1 - y, h - 1 - x] }),
  8: (w, h) => ({ width: h, height: w, source: (x, y) => [w - 1 - y, x] }),
};

/** mupdf ignores the EXIF tag; cv2, which the OCR was validated against, applies it. */
export function orient(raster: Raster, orientation: Orientation): Raster {
  if (orientation === 1) return raster;
  const { width, height, source } = ORIENT[orientation](raster.width, raster.height);
  const data = new Uint8Array(width * height * BGR_CHANNELS);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [sx, sy] = source(x, y);
      const from = (sy * raster.width + sx) * BGR_CHANNELS;
      data.set(raster.data.subarray(from, from + BGR_CHANNELS), (y * width + x) * BGR_CHANNELS);
    }
  }
  return { width, height, channels: BGR_CHANNELS, data };
}

function scaleFor([x0, y0, x1, y1]: Rect): number {
  return Math.min(RENDER_DPI / POINTS_PER_INCH, MAX_LONGEST_SIDE_PX / Math.max(x1 - x0, y1 - y0));
}

/** One 1-based page. The document reopens per call, so a caller reads each page before the next is drawn. */
export async function renderPDFPage(bytes: Buffer, page: number): Promise<RenderOutcome> {
  const mupdf = await loadMupdf();
  const rendered = tryExecute(() =>
    destroyAfter(mupdf.Document.openDocument(bytes, PDF_MIME), (doc) =>
      destroyAfter(doc.loadPage(page - 1), (loaded) => {
        const scale = scaleFor(loaded.getBounds());
        const matrix = mupdf.Matrix.scale(scale, scale);
        return destroyAfter(loaded.toPixmap(matrix, mupdf.ColorSpace.DeviceBGR, false), rasterOf);
      }),
    ),
  );
  return rendered.ok ? rendered : unreadable(rendered.error);
}

/** A PNG or JPEG at its own resolution, JPEG turned upright. mupdf converts any colorspace to BGR, but refuses to drop alpha itself. */
export async function decodeImage(bytes: Buffer): Promise<RenderOutcome> {
  const mupdf = await loadMupdf();
  const decoded = tryExecute(() =>
    destroyAfter(new mupdf.Image(bytes), (image): RenderOutcome => {
      const pixels = image.getWidth() * image.getHeight();
      if (pixels > MAX_IMAGE_PIXELS) {
        const size = `${image.getWidth()}x${image.getHeight()}`;
        const message = `image is ${size} px (${pixels.toLocaleString("en-US")} pixels), over the ${MAX_IMAGE_PIXELS.toLocaleString("en-US")} pixel limit`;
        return { ok: false, reason: "too_large", message };
      }
      return destroyAfter(image.toPixmap(), (native) =>
        destroyAfter(native.convertToColorSpace(mupdf.ColorSpace.DeviceBGR, native.getAlpha() > 0), (pixmap) => ({
          ok: true,
          value: orient(rasterOf(pixmap), exifOrientation(bytes)),
        })),
      );
    }),
  );
  return decoded.ok ? decoded.value : unreadable(decoded.error);
}
