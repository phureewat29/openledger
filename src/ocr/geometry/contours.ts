/** Reproduces cv2.findContours(RETR_LIST, CHAIN_APPROX_SIMPLE) as line_engine.py (Apache-2.0) calls it. */

/** Marks in cv2's signed 8-bit scan image: a traced border pixel, and one whose right side lies outside its region. */
const NEW = 2;
const RIGHT = -126;

/** Chain codes 0..7 turn counter-clockwise from +x in image coordinates, y pointing down. */
const STEP_X = [1, 1, 0, -1, -1, -1, 0, 1];
const STEP_Y = [0, -1, -1, -1, 0, 1, 1, 1];

/**
 * cv2's icvFetchContourEx on the padded scan image: follows one border from start, marks it, and keeps the points
 * where the chain code turns. (x, y) is start's position in the caller's image.
 */
function trace(image: Int8Array, offset: Int32Array, start: number, x: number, y: number, isHole: boolean): Int32Array {
  const points: number[] = [];
  const end = isHole ? 0 : 4;
  let s = end;
  let i1 = start;
  do {
    s = (s - 1) & 7;
    i1 = start + offset[s];
  } while (image[i1] === 0 && s !== end);
  if (s === end) {
    image[start] = RIGHT;
    return Int32Array.of(x, y);
  }

  let i3 = start;
  let i4 = start;
  let prev = s ^ 4;
  for (;;) {
    const from = s;
    while (s < 15) {
      s++;
      i4 = i3 + offset[s & 7];
      if (image[i4] !== 0) break;
    }
    s &= 7;
    if (s >= 1 && s - 1 < from) image[i3] = RIGHT;
    else if (image[i3] === 1) image[i3] = NEW;
    if (s !== prev) points.push(x, y);
    prev = s;
    x += STEP_X[s];
    y += STEP_Y[s];
    if (i4 === start && i3 === i1) break;
    i3 = i4;
    s = (s + 4) & 7;
  }
  return Int32Array.from(points);
}

/**
 * cv2.findContours(bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)[0] for a 0/1 bitmap: outer borders and holes, as
 * x,y pairs, in cv2's order (the reverse of the raster order in which their first pixels are met).
 */
export function findContours(bitmap: Uint8Array, width: number, height: number): Int32Array[] {
  const stride = width + 2;
  const image = new Int8Array(stride * (height + 2));
  for (let y = 0; y < height; y++) {
    const row = (y + 1) * stride + 1;
    for (let x = 0; x < width; x++) image[row + x] = bitmap[y * width + x] ? 1 : 0;
  }
  const offset = Int32Array.from(STEP_X, (dx, s) => dx + STEP_Y[s] * stride);
  const found: Int32Array[] = [];
  for (let y = 1; y <= height; y++) {
    let prev = 0;
    for (let i = y * stride + 1, end = y * stride + width + 1; i < end; i++) {
      const p = image[i];
      if (p === prev) continue;
      const outer = prev === 0 && p === 1;
      if (!outer && !(p === 0 && prev >= 1)) {
        prev = p;
        continue;
      }
      const start = outer ? i : i - 1;
      found.push(trace(image, offset, start, (start % stride) - 1, y - 1, !outer));
      prev = image[i];
    }
  }
  return found.reverse();
}
