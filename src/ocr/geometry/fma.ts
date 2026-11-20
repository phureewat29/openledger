/** Reproduces the fused multiply-adds cv2 and pyclipper compile to on arm64, as line_engine.py (Apache-2.0) calls them. */

/**
 * Float32 a*b + c with one rounding, as arm64's fmadd on single precision. a, b and c must hold float32 values,
 * so a*b is exact in a double and only a float32 tie in the double sum can round the wrong way.
 */
export function fma32(a: number, b: number, c: number): number {
  const product = a * b;
  const sum = product + c;
  const rounded = Math.fround(sum);
  const off = sum - rounded;
  if (off === 0) return rounded;
  const other = rounded + 2 * off;
  if (Math.fround(other) !== other) return rounded;
  const back = sum - product;
  const lost = product - (sum - back) + (c - back);
  if (lost === 0) return rounded;
  return lost > 0 === off > 0 ? other : rounded;
}

const SPLIT = 134217729;

/** Double a*b + c with one rounding, as arm64's fmadd on double precision; exact except at double-rounding ties. */
export function fma64(a: number, b: number, c: number): number {
  const product = a * b;
  const sa = SPLIT * a;
  const aHigh = sa - (sa - a);
  const aLow = a - aHigh;
  const sb = SPLIT * b;
  const bHigh = sb - (sb - b);
  const bLow = b - bHigh;
  const productError = aHigh * bHigh - product + aHigh * bLow + aLow * bHigh + aLow * bLow;
  const sum = product + c;
  const back = sum - product;
  const sumError = product - (sum - back) + (c - back);
  return sum + (sumError + productError);
}
