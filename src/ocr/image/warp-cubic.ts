/** Reproduces cv2's INTER_CUBIC warp kernel on 8-bit images as line_engine.py (Apache-2.0) calls it. */

import { fma32 } from "../geometry/fma.js";
import { f32 } from "../numeric.js";
import type { Raster } from "../raster.js";

/** Which genericWarp coordinate formula runs: a 2x3 matrix is affine, a 3x3 one perspective. */
type Projection = "affine" | "perspective";

const BLOCK = 128;
const BATCH = 8;

const HALF_MIN_NORMAL = 2 ** -14;
const HALF_SPLITTER = 2 ** 42 + 1;
const HALF_SUBNORMAL_SHIFT = 1.5 * 2 ** 28;
const ROUND_HALF_EVEN = 1.5 * 2 ** 52;

/**
 * Rounds to the nearest float16, ties to even, when x is a multiple of 2^-24 (float16 values times integers and
 * their sums): Veltkamp's split keeps 11 significant bits, and such x below the normal range already fit.
 */
function f16Grid(x: number): number {
  const t = x * HALF_SPLITTER;
  return t - (t - x);
}

/** Rounds to the nearest float16, ties to even: one NEON float16 operation with the default FPCR. Values here stay far below 65504. */
function f16(x: number): number {
  if (x > -HALF_MIN_NORMAL && x < HALF_MIN_NORMAL) return x + HALF_SUBNORMAL_SHIFT - HALF_SUBNORMAL_SHIFT;
  return f16Grid(x);
}

/** A float16 total as vcvtnq_s16_f16 then vqmovun store it: half to even, saturated to a byte. */
function toByte(x: number): number {
  const r = x + ROUND_HALF_EVEN - ROUND_HALF_EVEN;
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

const HALF_ONE_BITS = 0x3c00;

/** Bicubic weights (A = -0.75) for every float16 fraction in [0, 1], keyed by its bit pattern, in cv2's float16 operation order. */
const WEIGHTS = (() => {
  const table = new Float64Array((HALF_ONE_BITS + 1) * 4);
  for (let bits = 0; bits <= HALF_ONE_BITS; bits++) {
    const exponent = bits >> 10;
    const mantissa = bits & 0x3ff;
    const a = exponent === 0 ? mantissa * 2 ** -24 : (1024 + mantissa) * 2 ** (exponent - 25);
    const a2 = f16(a * a);
    const b = f16(1 - a);
    const w0 = f16(-0.75 * f16(a * f16(b * b)));
    const w3 = f16(-0.75 * f16(a2 * b));
    const w1 = f16(a2 * f16(1.25 * a - 2.25) + 1);
    table.set([w0, w1, f16(f16(f16(1 - w0) - w1) - w3), w3], bits * 4);
  }
  return table;
})();

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const HALF_SUBNORMAL_BITS = 0x38800000;

/** Offset into WEIGHTS for a float32 fraction in [0, 1], rounded to float16 as NEON's float32-to-float16 convert does. */
function weightOffset(fraction: number): number {
  F32[0] = fraction;
  const bits = U32[0];
  if (bits < HALF_SUBNORMAL_BITS) return ((fraction * 2 ** 24 + ROUND_HALF_EVEN - ROUND_HALF_EVEN) * 4) | 0;
  return ((((bits + 0xfff + ((bits >>> 13) & 1)) >>> 13) - 0x1c000) * 4) | 0;
}

/**
 * One channel from the 4x4 taps at `o`, `step` bytes apart: a single-channel image, or any channel of a gray BGR one.
 * cv2's float16 arithmetic step for step: per tap row, the x-weighted taps fused left to right into a row sum, then
 * the row sum times the row's y weight fused into the running total.
 */
function cubicMono(src: Uint8Array, o: number, stride: number, step: number, ax: number, ay: number): number {
  const x0 = WEIGHTS[ax];
  const x1 = WEIGHTS[ax + 1];
  const x2 = WEIGHTS[ax + 2];
  const x3 = WEIGHTS[ax + 3];
  let acc = 0;
  for (let r = 0; r < 4; r++, o += stride) {
    let s = f16Grid(src[o] * x0);
    s = f16Grid(src[o + step] * x1 + s);
    s = f16Grid(src[o + 2 * step] * x2 + s);
    s = f16Grid(src[o + 3 * step] * x3 + s);
    acc = f16(s * WEIGHTS[ay + r] + acc);
  }
  return toByte(acc);
}

/** The byte all 48 BGR taps at `o` hold, or -1: three 32-bit words per tap row. */
function flatTap(view: DataView, o: number, stride: number): number {
  const word = view.getUint32(o, true);
  if (word !== (word & 0xff) * 0x01010101) return -1;
  for (let r = 0; r < 4; r++, o += stride) {
    if (view.getUint32(o, true) !== word || view.getUint32(o + 4, true) !== word || view.getUint32(o + 8, true) !== word) return -1;
  }
  return word & 0xff;
}

/** cubicMono's arithmetic on a neighbourhood of one repeated byte, where every row sum is the same. */
function cubicFlat(v: number, ax: number, ay: number): number {
  let s = f16Grid(v * WEIGHTS[ax]);
  s = f16Grid(v * WEIGHTS[ax + 1] + s);
  s = f16Grid(v * WEIGHTS[ax + 2] + s);
  s = f16Grid(v * WEIGHTS[ax + 3] + s);
  let acc = f16(s * WEIGHTS[ay]);
  acc = f16(s * WEIGHTS[ay + 1] + acc);
  acc = f16(s * WEIGHTS[ay + 2] + acc);
  return toByte(f16(s * WEIGHTS[ay + 3] + acc));
}

/** cubicMono's arithmetic on all three BGR channels, their chains interleaved so they overlap. */
function cubicBGR(src: Uint8Array, o: number, stride: number, ax: number, ay: number, dst: Uint8Array, out: number): void {
  const x0 = WEIGHTS[ax];
  const x1 = WEIGHTS[ax + 1];
  const x2 = WEIGHTS[ax + 2];
  const x3 = WEIGHTS[ax + 3];
  let accB = 0;
  let accG = 0;
  let accR = 0;
  for (let row = 0; row < 4; row++, o += stride) {
    let b = f16Grid(src[o] * x0);
    let g = f16Grid(src[o + 1] * x0);
    let r = f16Grid(src[o + 2] * x0);
    b = f16Grid(src[o + 3] * x1 + b);
    g = f16Grid(src[o + 4] * x1 + g);
    r = f16Grid(src[o + 5] * x1 + r);
    b = f16Grid(src[o + 6] * x2 + b);
    g = f16Grid(src[o + 7] * x2 + g);
    r = f16Grid(src[o + 8] * x2 + r);
    b = f16Grid(src[o + 9] * x3 + b);
    g = f16Grid(src[o + 10] * x3 + g);
    r = f16Grid(src[o + 11] * x3 + r);
    const wy = WEIGHTS[ay + row];
    accB = f16(b * wy + accB);
    accG = f16(g * wy + accG);
    accR = f16(r * wy + accR);
  }
  dst[out] = toByte(accB);
  dst[out + 1] = toByte(accG);
  dst[out + 2] = toByte(accR);
}

type CoordFill = (m: Float32Array, y: number, x0: number, len: number, xs: Float32Array, ys: Float32Array) => void;

/** genericWarp's source coordinates for one block: float32 fused rows for affine, a double division for perspective. */
const COORDS: Record<Projection, CoordFill> = {
  affine: (m, y, x0, len, xs, ys) => {
    const mx = fma32(y, m[1], m[2]);
    const my = fma32(y, m[4], m[5]);
    for (let i = 0; i < len; i++) {
      xs[i] = fma32(x0 + i, m[0], mx);
      ys[i] = fma32(x0 + i, m[3], my);
    }
  },
  perspective: (m, y, x0, len, xs, ys) => {
    const mx = fma32(y, m[1], m[2]);
    const my = fma32(y, m[4], m[5]);
    const mz = fma32(y, m[7], m[8]);
    for (let i = 0; i < len; i++) {
      const invz = 1 / (mz + m[6] * (x0 + i));
      xs[i] = (mx + m[0] * (x0 + i)) * invz;
      ys[i] = (my + m[3] * (x0 + i)) * invz;
    }
  },
};

/** The source box [x0, y0, x1, y1] the taps can reach: the destination corners mapped back, widened past the 4x4 taps. */
function tapBounds(m: Float32Array, width: number, height: number, sw: number, sh: number): number[] {
  const whole = [0, 0, sw - 1, sh - 1];
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const [x, y] of [[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]]) {
    const z = m[6] * x + m[7] * y + m[8];
    xs.push((m[0] * x + m[1] * y + m[2]) / z);
    ys.push((m[3] * x + m[4] * y + m[5]) / z);
    zs.push(z);
  }
  if (!zs.every((z) => z > 0) && !zs.every((z) => z < 0)) return whole;
  const box = [Math.floor(Math.min(...xs)) - 2, Math.floor(Math.min(...ys)) - 2, Math.floor(Math.max(...xs)) + 3, Math.floor(Math.max(...ys)) + 3];
  if (!box.every(Number.isFinite)) return whole;
  return box.map((v, i) => Math.min(Math.max(v, 0), whole[i % 2 === 0 ? 2 : 3]));
}

/** True when every BGR pixel inside the inclusive box has B = G = R. */
function isGrayBox({ data, width }: Raster, [x0, y0, x1, y1]: number[]): boolean {
  for (let y = y0; y <= y1; y++) {
    const end = (y * width + x1) * 3;
    for (let k = (y * width + x0) * 3; k <= end; k += 3) if (data[k] !== data[k + 1] || data[k] !== data[k + 2]) return false;
  }
  return true;
}

/** One warp call's fixed inputs and scratch, shared by the per-row and per-tap helpers. */
interface Warp {
  data: Uint8Array;
  view: DataView;
  sw: number;
  sh: number;
  cn: number;
  m: Float32Array;
  fillCoords: CoordFill;
  border: Uint8ClampedArray | null;
  mono: boolean;
  dst: Uint8Array;
  width: number;
  xs: Float32Array;
  ys: Float32Array;
  patch: Uint8Array;
  patchView: DataView;
}

/**
 * A batch of eight lanes takes the border value outright when every lane's taps miss the image, as cv2 tests it
 * on the clamped, floored coordinates; anything less runs the arithmetic on border taps.
 */
function batchMisses(w: Warp, i: number): boolean {
  const { xs, ys, sw, sh } = w;
  const bigW = Math.max(sw, 16);
  const bigH = Math.max(sh, 16);
  for (let k = i; k < i + BATCH; k++) {
    const ix = Math.floor(Math.min(Math.max(xs[k], -bigW), 2 * bigW)) - 1;
    const iy = Math.floor(Math.min(Math.max(ys[k], -bigH), 2 * bigH)) - 1;
    if ((ix + 4) >>> 0 < sw + 4 && (iy + 4) >>> 0 < sh + 4) return false;
  }
  return true;
}

/** Copies the 4x4 taps at (ix, iy) into the scratch patch, clamped to the edge or taking the border value. */
function gatherTaps(w: Warp, ix: number, iy: number): void {
  const { data, sw, sh, cn, border, patch } = w;
  for (let r = 0; r < 4; r++) {
    const ty = iy + r;
    const rowInside = ty >= 0 && ty < sh;
    const row = Math.min(Math.max(ty, 0), sh - 1) * sw * cn;
    for (let k = 0; k < 4; k++) {
      const tx = ix + k;
      const inside = rowInside && tx >= 0 && tx < sw;
      const at = row + Math.min(Math.max(tx, 0), sw - 1) * cn;
      for (let c = 0; c < cn; c++) patch[(r * 4 + k) * cn + c] = border && !inside ? border[c] : data[at + c];
    }
  }
}

/** One destination row, in cv2's blocks of 128 and batches of eight, the last batch moved back to end flush. */
function warpRow(w: Warp, y: number): void {
  const { data, view, sw, sh, cn, m, fillCoords, border, mono, dst, width, xs, ys, patch, patchView } = w;
  const stride = sw * cn;
  const bigW = Math.max(sw, 16);
  const bigH = Math.max(sh, 16);
  for (let x0 = 0; x0 < width; x0 += BLOCK) {
    const len = Math.min(BLOCK, width - x0);
    fillCoords(m, y, x0, len, xs, ys);
    const rowOut = (y * width + x0) * cn;
    for (let i = 0; i < len; i += BATCH) {
      if (i + BATCH > len && i > 0) i = len - BATCH;
      const end = Math.min(i + BATCH, len);
      if (border && end - i === BATCH && batchMisses(w, i)) {
        for (let k = i; k < end; k++) dst.set(border, rowOut + k * cn);
        continue;
      }
      for (let k = i; k < end; k++) {
        const out = rowOut + k * cn;
        const vx = Math.min(Math.max(xs[k], -bigW), 2 * bigW);
        const vy = Math.min(Math.max(ys[k], -bigH), 2 * bigH);
        const fx = Math.floor(vx);
        const fy = Math.floor(vy);
        const ax = weightOffset(f32(vx - fx));
        const ay = weightOffset(f32(vy - fy));
        const inside = fx >= 1 && fx + 2 < sw && fy >= 1 && fy + 2 < sh;
        if (!inside) gatherTaps(w, fx - 1, fy - 1);
        const taps = inside ? data : patch;
        const o = inside ? (fy - 1) * stride + (fx - 1) * cn : 0;
        const tapStride = inside ? stride : 4 * cn;
        if (mono) {
          const v = cubicMono(taps, o, tapStride, cn, ax, ay);
          for (let c = 0; c < cn; c++) dst[out + c] = v;
          continue;
        }
        const flat = flatTap(inside ? view : patchView, o, tapStride);
        if (flat < 0) {
          cubicBGR(taps, o, tapStride, ax, ay, dst, out);
          continue;
        }
        const v = cubicFlat(flat, ax, ay);
        dst[out] = v;
        dst[out + 1] = v;
        dst[out + 2] = v;
      }
    }
  }
}

/**
 * cv2.warpAffine / cv2.warpPerspective with INTER_CUBIC on uint8, given the inverse (destination-to-source)
 * matrix already rounded to float32. `fill` null replicates the edge; otherwise it is the BORDER_CONSTANT value.
 * cv2 5.0 on arm64 runs these through genericWarp and its float16 NEON bicubic kernel, not through any HAL.
 */
export function warpCubic(
  src: Raster,
  m: Float32Array,
  projection: Projection,
  width: number,
  height: number,
  fill: readonly number[] | null,
): Raster {
  const { channels: cn, width: sw, height: sh, data } = src;
  const border = fill && Uint8ClampedArray.from({ length: cn }, (_, c) => fill[c] ?? 0);
  const grayBorder = !border || border.every((v) => v === border[0]);
  const patch = new Uint8Array(16 * cn);
  const w: Warp = {
    data,
    view: new DataView(data.buffer, data.byteOffset, data.byteLength),
    sw,
    sh,
    cn,
    m,
    fillCoords: COORDS[projection],
    border,
    mono: cn === 1 || (grayBorder && isGrayBox(src, tapBounds(m, width, height, sw, sh))),
    dst: new Uint8Array(width * height * cn),
    width,
    xs: new Float32Array(BLOCK),
    ys: new Float32Array(BLOCK),
    patch,
    patchView: new DataView(patch.buffer),
  };
  for (let y = 0; y < height; y++) warpRow(w, y);
  return { width, height, channels: cn, data: w.dst };
}
