import type { Pixmap, Rect } from "mupdf";
import { tryExecute, type Result } from "../lib/result.js";
import type { Raster } from "../ocr/raster.js";
import { PDF_MIME, destroyAfter, loadMupdf } from "./pdf.js";

/** Thai tone marks and vowels stay legible at 300 dpi; the cap bounds the raster of an oversized page. */
const RENDER_DPI = 300;
const MAX_LONGEST_SIDE_PX = 3600;
const POINTS_PER_INCH = 72;

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

function scaleFor([x0, y0, x1, y1]: Rect): number {
  return Math.min(RENDER_DPI / POINTS_PER_INCH, MAX_LONGEST_SIDE_PX / Math.max(x1 - x0, y1 - y0));
}

/** One 1-based page. The document reopens per call, so a caller reads each page before the next is drawn. */
export async function renderPDFPage(bytes: Buffer, page: number): Promise<Result<Raster>> {
  const mupdf = await loadMupdf();
  return tryExecute(() =>
    destroyAfter(mupdf.Document.openDocument(bytes, PDF_MIME), (doc) =>
      destroyAfter(doc.loadPage(page - 1), (loaded) => {
        const scale = scaleFor(loaded.getBounds());
        const matrix = mupdf.Matrix.scale(scale, scale);
        return destroyAfter(loaded.toPixmap(matrix, mupdf.ColorSpace.DeviceBGR, false), rasterOf);
      }),
    ),
  );
}

/** A PNG or JPEG at its own resolution. mupdf converts any colorspace to BGR, but refuses to drop alpha itself. */
export async function decodeImage(bytes: Buffer): Promise<Result<Raster>> {
  const mupdf = await loadMupdf();
  return tryExecute(() =>
    destroyAfter(new mupdf.Image(bytes), (image) =>
      destroyAfter(image.toPixmap(), (native) =>
        destroyAfter(native.convertToColorSpace(mupdf.ColorSpace.DeviceBGR, native.getAlpha() > 0), rasterOf),
      ),
    ),
  );
}
