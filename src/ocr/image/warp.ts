/** Reproduces cv2.getPerspectiveTransform, getRotationMatrix2D, warpPerspective and warpAffine as line_engine.py (Apache-2.0) calls them. */

import { fma64 } from "../geometry/fma.js";
import type { Quad } from "../geometry/quad.js";
import { f32 } from "../numeric.js";
import type { Raster } from "../raster.js";
import { warpCubic } from "./warp-cubic.js";

/** a*b - c*d as clang contracts it on arm64: the first product fused, the second rounded. */
const minor = (a: number, b: number, c: number, d: number): number => fma64(a, b, -(c * d));

const LU_EPS = 100 * Number.EPSILON;

/** hal::LUImpl with one right-hand side, every `x += alpha*y` fused, solved in place into `b`; false on a pivot under its epsilon. */
function solveLU(a: Float64Array, b: Float64Array, n: number): boolean {
  for (let i = 0; i < n; i++) {
    let p = i;
    for (let j = i + 1; j < n; j++) if (Math.abs(a[j * n + i]) > Math.abs(a[p * n + i])) p = j;
    if (Math.abs(a[p * n + i]) < LU_EPS) return false;
    if (p !== i) {
      for (let j = i; j < n; j++) [a[i * n + j], a[p * n + j]] = [a[p * n + j], a[i * n + j]];
      [b[i], b[p]] = [b[p], b[i]];
    }
    const d = -1 / a[i * n + i];
    for (let j = i + 1; j < n; j++) {
      const alpha = a[j * n + i] * d;
      for (let k = i + 1; k < n; k++) a[j * n + k] = fma64(alpha, a[i * n + k], a[j * n + k]);
      b[j] = fma64(alpha, b[i], b[j]);
    }
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = b[i];
    for (let k = i + 1; k < n; k++) s = fma64(-a[i * n + k], b[k], s);
    b[i] = s / a[i * n + i];
  }
  return true;
}

/**
 * cv2.getPerspectiveTransform on float32 corners: 3x3 row-major, its last entry 1. cv2 switches to an SVD solution
 * only for a singular system, which a quad with area never gives, so that case throws.
 */
export function perspectiveTransform(src: Quad, dst: Quad): Float64Array {
  const a = new Float64Array(64);
  const b = new Float64Array(8);
  for (let i = 0; i < 4; i++) {
    const [x, y, u, v] = [src[2 * i], src[2 * i + 1], dst[2 * i], dst[2 * i + 1]];
    a.set([x, y, 1, 0, 0, 0, f32(-x * u), f32(-y * u)], i * 8);
    a.set([0, 0, 0, x, y, 1, f32(-x * v), f32(-y * v)], (i + 4) * 8);
    b[i] = u;
    b[i + 4] = v;
  }
  if (!solveLU(a, b, 8)) throw new Error("perspectiveTransform: degenerate quad");
  return Float64Array.of(...b, 1);
}

/**
 * cv2.getRotationMatrix2D at scale 1: 2x3 row-major; the centre goes through float32 as cv::Point2f.
 * V8's cos and sin differ from macOS libm's sincos in the last bit for about one angle in twenty; the float32
 * rounding of the matrix inside the warp absorbs that.
 */
export function rotationMatrix(cx: number, cy: number, angleDeg: number): Float64Array {
  const angle = angleDeg * (Math.PI / 180);
  const alpha = Math.cos(angle);
  const beta = Math.sin(angle);
  const [x, y] = [f32(cx), f32(cy)];
  return Float64Array.of(alpha, beta, fma64(1 - alpha, x, -(beta * y)), -beta, alpha, fma64(beta, x, (1 - alpha) * y));
}

/** cv::invert DECOMP_LU on a 3x3 double matrix: the closed-form adjugate over the determinant, zeros when singular. */
function invert3x3(m: Float64Array): Float64Array {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const det = fma64(m02, minor(m10, m21, m11, m20), fma64(m00, minor(m11, m22, m12, m21), -(m01 * minor(m10, m22, m12, m20))));
  if (det === 0) return new Float64Array(9);
  const d = 1 / det;
  return Float64Array.of(
    minor(m11, m22, m12, m21) * d,
    minor(m02, m21, m01, m22) * d,
    minor(m01, m12, m02, m11) * d,
    minor(m12, m20, m10, m22) * d,
    minor(m00, m22, m02, m20) * d,
    minor(m02, m10, m00, m12) * d,
    minor(m10, m21, m11, m20) * d,
    minor(m01, m20, m00, m21) * d,
    minor(m00, m11, m01, m10) * d,
  );
}

/** The inverse cv::warpAffine computes in double before warping, extended with cv2's implicit [0, 0, 1] row. */
function invertAffine(m: Float64Array): Float64Array {
  const [m0, m1, m2, m3, m4, m5] = m;
  const det = minor(m0, m4, m1, m3);
  const d = det !== 0 ? 1 / det : 0;
  const [a11, a12, a21, a22] = [m4 * d, m1 * -d, m3 * -d, m0 * d];
  return Float64Array.of(a11, a12, fma64(-a11, m2, -(a12 * m5)), a21, a22, fma64(-a21, m2, -(a22 * m5)), 0, 0, 1);
}

/** cv2.warpPerspective(src, m, (width, height), flags=INTER_CUBIC, borderMode=BORDER_REPLICATE); `m` maps source to destination. */
export function warpPerspectiveCubic(src: Raster, m: Float64Array, width: number, height: number): Raster {
  return warpCubic(src, Float32Array.from(invert3x3(m)), "perspective", width, height, null);
}

/** cv2.warpAffine(src, m, (width, height), flags=INTER_CUBIC, borderMode=BORDER_CONSTANT, borderValue=fill); `m` maps source to destination. */
export function warpAffineCubic(src: Raster, m: Float64Array, width: number, height: number, fill: readonly number[]): Raster {
  return warpCubic(src, Float32Array.from(invertAffine(m)), "affine", width, height, fill);
}
