/** Reproduces cv2.convexHull as cv2.minAreaRect calls it from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

const f32 = Math.fround;

const sign = (v: number): number => (v > 0 ? 1 : 0) - (v < 0 ? 1 : 0);

/** Points sorted by x, then y, then input index, as cv2 sorts its point pointers. */
interface Sorted {
  x: Float64Array;
  y: Float64Array;
  isFloat: boolean;
}

/**
 * The turn sign at pcur and whether the incoming vector is zero. cv2 5.0 normalises both vectors in double and
 * rounds them to float32 before the cross product on CV_32F input, and multiplies exact integers on CV_32S.
 */
function turn(pts: Sorted, pprev: number, pcur: number, pnext: number): number {
  const { x, y } = pts;
  const ax = x[pcur] - x[pprev];
  const ay = y[pcur] - y[pprev];
  const bx = x[pnext] - x[pcur];
  const by = y[pnext] - y[pcur];
  if (!pts.isFloat) return ax === 0 && ay === 0 ? NaN : sign(ay * bx - ax * by);
  const fax = f32(ax);
  const fay = f32(ay);
  const fbx = f32(bx);
  const fby = f32(by);
  const na = Math.sqrt(fax * fax + fay * fay);
  const nb = Math.sqrt(fbx * fbx + fby * fby);
  const ux = f32((na ? 1 / na : 0) * fax);
  const uy = f32((na ? 1 / na : 0) * fay);
  const vx = f32((nb ? 1 / nb : 0) * fbx);
  const vy = f32((nb ? 1 / nb : 0) * fby);
  return ux === 0 && uy === 0 ? NaN : sign(uy * vx - ux * vy);
}

/** One quarter of the hull between two sorted positions, as cv2's Sklansky_ walks it, without the lookahead entry. */
function sklansky(pts: Sorted, start: number, end: number, nsign: number, sign2: number): Int32Array {
  if (start === end || (pts.x[start] === pts.x[end] && pts.y[start] === pts.y[end])) return Int32Array.of(start);
  const incr = end > start ? 1 : -1;
  const stack = new Int32Array(Math.abs(end - start) + 3);
  let pprev = start;
  let pcur = pprev + incr;
  let pnext = pcur + incr;
  let size = 3;
  stack[0] = pprev;
  stack[1] = pcur;
  stack[2] = pnext;
  const stop = end + incr;
  while (pnext !== stop) {
    const by = pts.isFloat ? f32(pts.y[pnext] - pts.y[pcur]) : pts.y[pnext] - pts.y[pcur];
    if (sign(by) === nsign) {
      pnext += incr;
      stack[size - 1] = pnext;
    } else if (turn(pts, pprev, pcur, pnext) === sign2) {
      pprev = pcur;
      pcur = pnext;
      pnext += incr;
      stack[size++] = pnext;
    } else if (pprev === start) {
      pcur = pnext;
      stack[1] = pcur;
      pnext += incr;
      stack[2] = pnext;
    } else {
      stack[size - 2] = pnext;
      pcur = pprev;
      pprev = stack[size - 4];
      size--;
    }
  }
  return stack.subarray(0, size - 1);
}

/** Rotates the hull so its input indices ascend or descend from the smallest, as cv2 does when they allow it. */
function cyclicShift(hull: Int32Array): Int32Array {
  const n = hull.length;
  let minIdx = 0;
  let maxIdx = 0;
  let lt = 0;
  for (let i = 1; i < n; i++) {
    const idx = hull[i];
    lt += hull[i - 1] < idx ? 1 : 0;
    if (lt > 1 && lt <= i - 2) break;
    if (idx < hull[minIdx]) minIdx = i;
    if (idx > hull[maxIdx]) maxIdx = i;
  }
  const mmdist = Math.abs(maxIdx - minIdx);
  if (!((mmdist === 1 || mmdist === n - 1) && (lt <= 1 || lt >= n - 2))) return hull;
  const ascending = (maxIdx + 1) % n === minIdx;
  const i0 = ascending ? minIdx : maxIdx;
  if (i0 === 0) return hull;
  const shifted = new Int32Array(n);
  for (let i = 0, j = i0; i < n; i++) {
    shifted[i] = hull[j];
    const next = j + 1 < n ? j + 1 : 0;
    if (i < n - 1 && ascending !== shifted[i] < hull[next]) return hull;
    j = next;
  }
  return shifted;
}

/**
 * cv2.convexHull(points, clockwise=False, returnPoints=True) as input indices, in cv2's order. points holds x,y pairs;
 * isFloat picks cv2's CV_32F path over its CV_32S one.
 */
export function convexHull(points: ArrayLike<number>, isFloat: boolean): Int32Array {
  const total = points.length >> 1;
  if (total === 0) return new Int32Array(0);
  const order = new Int32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  order.sort((a, b) => points[2 * a] - points[2 * b] || points[2 * a + 1] - points[2 * b + 1] || a - b);
  const pts: Sorted = { x: new Float64Array(total), y: new Float64Array(total), isFloat };
  for (let k = 0; k < total; k++) {
    pts.x[k] = points[2 * order[k]];
    pts.y[k] = points[2 * order[k] + 1];
  }
  if (pts.x[0] === pts.x[total - 1] && pts.y[0] === pts.y[total - 1]) return Int32Array.of(order[0]);
  let minY = 0;
  let maxY = 0;
  for (let k = 1; k < total; k++) {
    if (pts.y[minY] > pts.y[k]) minY = k;
    if (pts.y[maxY] < pts.y[k]) maxY = k;
  }

  const out: number[] = [];
  const tr = sklansky(pts, total - 1, maxY, -1, -1);
  const tl = sklansky(pts, 0, maxY, -1, 1);
  for (let i = 0; i < tr.length - 1; i++) out.push(tr[i]);
  for (let i = tl.length - 1; i > 0; i--) out.push(tl[i]);
  const stopIdx = tl.length > 2 ? tl[1] : tr.length > 2 ? tr[tr.length - 2] : -1;

  let bl = sklansky(pts, 0, minY, 1, -1);
  let br = sklansky(pts, total - 1, minY, 1, 1);
  if (stopIdx >= 0) {
    const checkIdx = bl.length > 2 ? bl[1] : bl.length + br.length > 2 ? br[2 - bl.length] : -1;
    const same = checkIdx >= 0 && pts.x[checkIdx] === pts.x[stopIdx] && pts.y[checkIdx] === pts.y[stopIdx];
    if (checkIdx === stopIdx || same) {
      bl = bl.subarray(0, 2);
      br = br.subarray(0, 2);
    }
  }
  for (let i = 0; i < bl.length - 1; i++) out.push(bl[i]);
  for (let i = br.length - 1; i > 0; i--) out.push(br[i]);

  const hull = Int32Array.from(out, (k) => order[k]);
  return hull.length >= 3 ? cyclicShift(hull) : hull;
}
