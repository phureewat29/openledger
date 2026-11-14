/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

export const f32 = Math.fround;

/** Python's round(): halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** np.linalg.norm of a float32 2-vector: every step rounds to float32. */
export const norm32 = (dx: number, dy: number): number => f32(Math.sqrt(f32(f32(dx * dx) + f32(dy * dy))));

/** numpy's pairwise summation, which np.mean and np.sum use on float64. */
function pairwiseSum(values: readonly number[], start: number, n: number): number {
  if (n < 8) {
    let sum = -0;
    for (let i = start; i < start + n; i++) sum += values[i];
    return sum;
  }
  if (n <= 128) {
    const r = values.slice(start, start + 8);
    let i = 8;
    for (; i < n - (n % 8); i += 8) {
      for (let j = 0; j < 8; j++) r[j] += values[start + i + j];
    }
    let sum = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
    for (; i < n; i++) sum += values[start + i];
    return sum;
  }
  const half = Math.floor(n / 2);
  const n2 = half - (half % 8);
  return pairwiseSum(values, start, n2) + pairwiseSum(values, start + n2, n - n2);
}

/** np.mean on a list of Python floats. */
export const mean = (values: readonly number[]): number => (0 + pairwiseSum(values, 0, values.length)) / values.length;

/** np.median on a list of Python floats. */
export function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Index of the first smallest value, as np.argmin. */
export function argmin(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] < values[best]) best = i;
  return best;
}

/** Python's sorted(range(n), key=...): stable, ascending. */
export const sortedIndices = (n: number, key: (i: number) => number): number[] =>
  Array.from({ length: n }, (_, i) => i).sort((a, b) => key(a) - key(b));

/** Python's len(): code points, not UTF-16 units. */
export const codePointLength = (text: string): number => Array.from(text).length;
