/** Reproduces cv2.resize INTER_LINEAR on OpenCV's own uint8 code as line_engine.py (Apache-2.0) calls it; see THIRD_PARTY_NOTICES.md. */

import { f32, roundHalfEven } from "../numeric.js";
import type { Raster } from "../raster.js";

const CN = 3;
const COEF_SCALE = 2048;

/** Source index and 11-bit weights per destination coordinate, as hal::resize tabulates them in float32. */
interface Axis {
  index: Int32Array;
  w0: Int32Array;
  w1: Int32Array;
}

/** No clamping: the vertical pass clips rows itself and keeps the weights of a coordinate outside the image. */
function axisTaps(srcSize: number, dstSize: number, clamp: boolean): Axis {
  const scale = 1 / (dstSize / srcSize);
  const axis: Axis = { index: new Int32Array(dstSize), w0: new Int32Array(dstSize), w1: new Int32Array(dstSize) };
  for (let d = 0; d < dstSize; d++) {
    const f = f32((d + 0.5) * scale - 0.5);
    const s = Math.floor(f);
    const edge = clamp && (s < 0 || s >= srcSize - 1);
    const frac = edge ? 0 : f32(f - s);
    axis.index[d] = edge ? Math.min(Math.max(s, 0), srcSize - 1) : s;
    axis.w0[d] = roundHalfEven(f32(1 - frac) * COEF_SCALE);
    axis.w1[d] = roundHalfEven(frac * COEF_SCALE);
  }
  return axis;
}

/** HResizeLinear: one source row to 32-bit sums of two weighted neighbours. */
function horizontal(pixels: Uint8Array, rowStart: number, x: Axis, out: Int32Array): void {
  for (let dx = 0; dx < x.index.length; dx++) {
    const at = rowStart + x.index[dx] * CN;
    const w0 = x.w0[dx];
    const w1 = x.w1[dx];
    for (let c = 0; c < CN; c++) {
      out[dx * CN + c] = w1 === 0 ? pixels[at + c] * w0 : pixels[at + c] * w0 + pixels[at + CN + c] * w1;
    }
  }
}

/** resizeGeneric_ with VResizeLinear<uchar>, whose vector and scalar tails share one rounding since OpenCV 5. */
export function resizeLinearOpenCV(src: Raster, width: number, height: number): Raster {
  const x = axisTaps(src.width, width, true);
  const y = axisTaps(src.height, height, false);
  const n = width * CN;
  const rowBytes = src.width * CN;
  const data = new Uint8Array(n * height);
  let upper = new Int32Array(n);
  let lower = new Int32Array(n);
  let upperRow = -1;
  let lowerRow = -1;
  for (let dy = 0; dy < height; dy++) {
    const r0 = Math.min(Math.max(y.index[dy], 0), src.height - 1);
    const r1 = Math.min(Math.max(y.index[dy] + 1, 0), src.height - 1);
    if (upperRow !== r0 && lowerRow === r0) {
      [upper, lower] = [lower, upper];
      [upperRow, lowerRow] = [lowerRow, upperRow];
    }
    if (upperRow !== r0) {
      horizontal(src.data, r0 * rowBytes, x, upper);
      upperRow = r0;
    }
    if (lowerRow !== r1) {
      horizontal(src.data, r1 * rowBytes, x, lower);
      lowerRow = r1;
    }
    const b0 = y.w0[dy];
    const b1 = y.w1[dy];
    const out = dy * n;
    for (let e = 0; e < n; e++) {
      data[out + e] = (((b0 * (upper[e] >> 4)) >> 16) + ((b1 * (lower[e] >> 4)) >> 16) + 2) >> 2;
    }
  }
  return { width, height, channels: CN, data };
}
