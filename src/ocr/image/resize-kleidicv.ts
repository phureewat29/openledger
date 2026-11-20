/** Reproduces cv2.resize INTER_LINEAR through KleidiCV's NEON generic u8 kernel as line_engine.py (Apache-2.0) calls it. */

import type { Raster } from "../raster.js";

const CN = 3;
const FIXP = 65536;
const FIXP_HALF = 32768;
const STEP = 16;
const HALF_STEP = 8;

/** One NEON store: the lanes it writes and the source bytes its table lookups can reach. */
interface Vector {
  dst: number;
  base: number;
  window: number;
  idx: Uint8Array;
  xfrac: Uint8Array;
  fixLast: boolean;
}

/** Per destination element of a row: where its left and right neighbours sit in a source row, and the right one's 8-bit weight. */
interface Taps {
  left: Int32Array;
  right: Int32Array;
  weight: Uint8Array;
}

/** resize_linear_u8_is_implemented for three channels; the adapter's FLT_EPSILON scale check always passes below 2^23 pixels. */
export function isKleidiCVResize(srcWidth: number, srcHeight: number, dstWidth: number, dstHeight: number): boolean {
  const downscale = dstWidth * 3 >= srcWidth && dstWidth < srcWidth && dstHeight < srcHeight;
  return downscale && dstWidth * CN >= 8 && srcWidth * CN >= 32;
}

const roundingDiv = (num: number, den: number): number => Math.floor((num + Math.floor(den / 2)) / den);

/** Destination to 16.16 source coordinate, centre-aligned, plus 1/512 so taking the top 8 fraction bits rounds. */
const alignedScale = (x: number, src: number, dst: number): number => roundingDiv((x * FIXP + FIXP_HALF) * src, dst) - FIXP_HALF + 128;

/** RowInterpolationConstantsGenerator<ratio, 3> in store order: full vectors left to right, then the pulled-back half vectors. */
function planVectors(srcWidth: number, dstWidth: number, ratio: 2 | 3, fixLast: boolean): Vector[] {
  const rowBytes = srcWidth * CN;
  const twoX = rowBytes >= STEP * ratio ? Math.floor((dstWidth * CN) / (2 * STEP)) : 0;
  const halves = Math.ceil((dstWidth * CN - twoX * 2 * STEP) / HALF_STEP);
  const fulls = twoX * 2;
  const onePixel = roundingDiv(srcWidth * FIXP, dstWidth);
  const toSrcX = (dx: number) => alignedScale(dx, srcWidth, dstWidth);
  const scaleX = (dx: number) => roundingDiv(dx * srcWidth * FIXP, dstWidth);

  /** fill_idx_xfrac: the first pixel from an exact coordinate, the rest by adding one pixel's step. */
  const scalarVector = (dst: number, lanes: number, window: number, maxBase: number, fix: boolean): Vector => {
    const inPixel = dst % CN;
    let sx = toSrcX(Math.floor(dst / CN));
    const first = Math.floor(sx / FIXP) * CN + inPixel;
    const base = Math.min(maxBase, first);
    const idx = new Uint8Array(lanes);
    const xfrac = new Uint8Array(lanes);
    let j = 0;
    for (; j < CN - inPixel; j++) {
      idx[j] = first - base + j;
      xfrac[j] = (sx % FIXP) >> 8;
    }
    while (j < lanes) {
      sx += onePixel;
      const at = Math.floor(sx / FIXP) * CN - base;
      for (let k = 0; j < lanes && k < CN; j++, k++) {
        idx[j] = at + k;
        xfrac[j] = (sx % FIXP) >> 8;
      }
    }
    return { dst, base, window, idx, xfrac, fixLast: fix };
  };

  /** fill_full_constants_vectorially: every lane offsets the vector's running coordinate by scale_x of its pixel. */
  const laneVector = (dst: number, sx: number, inPixel: number): Vector => {
    const frac = sx % FIXP;
    const idx = new Uint8Array(STEP);
    const xfrac = new Uint8Array(STEP);
    for (let lane = 0; lane < STEP; lane++) {
      const pixel = Math.floor((inPixel + lane) / CN);
      const channel = (inPixel + lane) % CN;
      const at = scaleX(pixel) + frac;
      // vqsubq_u8: the in-pixel shift saturates at 0 for the lanes of the vector's first pixel
      const pixelStart = Math.max(0, ((Math.floor(at / FIXP) & 0xff) * CN & 0xff) - inPixel);
      idx[lane] = pixelStart + (pixel === 0 ? channel - inPixel : channel);
      xfrac[lane] = Math.floor(at / 256) & 0xff;
    }
    return { dst, base: Math.floor(sx / FIXP) * CN + inPixel, window: STEP * ratio, idx, xfrac, fixLast };
  };

  const needsPullback = (dst: number) => Math.floor(toSrcX(Math.floor(dst / CN)) / FIXP) * CN + (dst % CN) + STEP * ratio > rowBytes;
  let clean = fulls;
  while (clean > 0 && needsPullback((clean - 1) * STEP)) clean--;

  const vectors: Vector[] = [];
  let dst = 0;
  if (fulls > 3) {
    const five = roundingDiv(srcWidth * 5 * FIXP, dstWidth);
    const six = roundingDiv(srcWidth * 6 * FIXP, dstWidth);
    let sx = toSrcX(0);
    let sinceRecalibration = 0;
    for (let triplet = 0; triplet < Math.floor(clean / 3); triplet++) {
      if (sinceRecalibration === 170) {
        sx = toSrcX(dst / CN);
        sinceRecalibration = 0;
      } else {
        sinceRecalibration++;
      }
      vectors.push(laneVector(dst, sx, 0), laneVector(dst + STEP, sx + five, 1), laneVector(dst + 2 * STEP, sx + 2 * five, 2));
      sx += 2 * five + six;
      dst += 3 * STEP;
    }
  }
  for (let i = vectors.length; i < fulls; i++, dst += STEP) {
    vectors.push(scalarVector(dst, STEP, STEP * ratio, rowBytes - STEP * ratio, fixLast));
  }
  const halfMaxBase = Math.max(0, rowBytes - 2 * STEP);
  const halfMaxDst = dstWidth * CN - HALF_STEP;
  for (let i = 0; i < halves; i++, dst += HALF_STEP) {
    dst = Math.min(dst, halfMaxDst);
    vectors.push(scalarVector(dst, HALF_STEP, 2 * STEP, halfMaxBase, false));
  }
  return vectors;
}

/**
 * Flattens the vectors into per-element taps; a later store overwrites an earlier one, as the pulled-back half vectors do.
 * A right neighbour with weight 0 cannot change the result, so it reuses the left offset; every other tap must land in the row.
 */
function toTaps(vectors: readonly Vector[], dstWidth: number, rowBytes: number): Taps {
  const n = dstWidth * CN;
  const taps: Taps = { left: new Int32Array(n), right: new Int32Array(n), weight: new Uint8Array(n) };
  for (const v of vectors) {
    for (let lane = 0; lane < v.idx.length; lane++) {
      const e = v.dst + lane;
      const a = v.idx[lane];
      const b = (a + CN) & 0xff;
      const right = v.fixLast && lane === STEP - 1 ? v.base + a + CN : b < v.window ? v.base + b : -1;
      const weight = v.xfrac[lane];
      const left = a < v.window ? v.base + a : -1;
      if (left < 0 || left >= rowBytes || (weight !== 0 && (right < 0 || right >= rowBytes))) {
        throw new Error(`KleidiCV resize tap outside the row: element ${e}, row ${rowBytes} bytes`);
      }
      taps.left[e] = left;
      taps.right[e] = weight === 0 ? left : right;
      taps.weight[e] = weight;
    }
  }
  return taps;
}

/** kleidicv_resize_generic_stripe_u8: r2 below a 1.8 ratio, r3 above it, r3 with its last lane read directly from 2.8. */
export function resizeKleidiCV(src: Raster, width: number, height: number): Raster {
  const inverseScale = src.width / width;
  const ratio = inverseScale < 1.8 ? 2 : 3;
  const rowBytes = src.width * CN;
  const taps = toTaps(planVectors(src.width, width, ratio, inverseScale >= 2.8), width, rowBytes);
  const n = width * CN;
  const data = new Uint8Array(n * height);
  const pixels = src.data;
  for (let dy = 0; dy < height; dy++) {
    const sy = alignedScale(dy, src.height, height);
    const row = Math.floor(sy / FIXP);
    const yf = (sy % FIXP) >> 8;
    const top = row * rowBytes;
    const bottom = yf === 0 ? top : top + rowBytes;
    const out = dy * n;
    for (let e = 0; e < n; e++) {
      const l = taps.left[e];
      const r = taps.right[e];
      const a = pixels[top + l];
      const b = pixels[top + r];
      const left = (a * 256 + (pixels[bottom + l] - a) * yf + 128) >> 8;
      const right = (b * 256 + (pixels[bottom + r] - b) * yf + 128) >> 8;
      data[out + e] = (left * 256 + (right - left) * taps.weight[e] + 128) >> 8;
    }
  }
  return { width, height, channels: CN, data };
}
