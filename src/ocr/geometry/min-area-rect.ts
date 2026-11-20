/** Reproduces cv2.minAreaRect and cv2.boxPoints as line_engine.py (Apache-2.0) calls them. */

import { fma32 } from "./fma.js";
import { convexHull } from "./hull.js";
import type { Quad, RotatedRect } from "./quad.js";

const f32 = Math.fround;

const FLT_MAX = 3.4028234663852886e38;

/** cv2 5.0 reports an unrotated box, a lone point and an empty set at -90 degrees, its angle range being [-90, 0). */
const UPRIGHT = f32(((-Math.PI / 2) * 180) / Math.PI);

/** The caliper base after the side main lines up with an edge whose unit vector is (x, y). */
const BASE: Record<number, (x: number, y: number) => [number, number]> = {
  0: (x, y) => [x, y],
  1: (x, y) => [y, -x],
  2: (x, y) => [-x, -y],
  3: (x, y) => [-y, x],
};

/** True when v1 turns clockwise onto v2: rotate v1 by 90 degrees clockwise and test the dot product's sign. */
const firstIsRight = (x1: number, y1: number, x2: number, y2: number): boolean => fma32(y1, x2, f32(-x1 * y2)) < 0;

/** A corner of the rectangle and its two side vectors. */
interface Frame {
  px: number;
  py: number;
  v1: [number, number];
  v2: [number, number];
}

/** cv2's rotatingCalipers on a counter-clockwise hull, with every float32 step and fused multiply-add cv2 runs. */
function calipers(hx: Float32Array, hy: Float32Array): Frame {
  const n = hx.length;
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const inv = new Float32Array(n);
  let left = 0;
  let bottom = 0;
  let right = 0;
  let top = 0;
  let leftX = hx[0];
  let rightX = hx[0];
  let topY = hy[0];
  let bottomY = hy[0];
  for (let i = 0; i < n; i++) {
    if (hx[i] < leftX) [leftX, left] = [hx[i], i];
    if (hx[i] > rightX) [rightX, right] = [hx[i], i];
    if (hy[i] > topY) [topY, top] = [hy[i], i];
    if (hy[i] < bottomY) [bottomY, bottom] = [hy[i], i];
    const j = i + 1 < n ? i + 1 : 0;
    const dx = f32(hx[j] - hx[i]);
    const dy = f32(hy[j] - hy[i]);
    vx[i] = dx;
    vy[i] = dy;
    inv[i] = 1 / Math.sqrt(dx * dx + dy * dy);
  }

  const seq = [bottom, right, top, left];
  let minArea = FLT_MAX;
  let best = { left: 0, bottom: 0, a: 0, b: 0, width: 0, height: 0 };
  for (let k = 0; k < n; k++) {
    const rx = [vx[seq[0]], vy[seq[1]], -vx[seq[2]], -vy[seq[3]]];
    const ry = [vy[seq[0]], -vx[seq[1]], -vy[seq[2]], vx[seq[3]]];
    let main = 0;
    for (let i = 1; i < 4; i++) if (firstIsRight(rx[i], ry[i], rx[main], ry[main])) main = i;
    const edge = seq[main];
    const [a, b] = BASE[main](f32(vx[edge] * inv[edge]), f32(vy[edge] * inv[edge]));
    seq[main] = edge + 1 === n ? 0 : edge + 1;

    const width = fma32(f32(hx[seq[1]] - hx[seq[3]]), a, f32(f32(hy[seq[1]] - hy[seq[3]]) * b));
    const height = fma32(-f32(hx[seq[2]] - hx[seq[0]]), b, f32(f32(hy[seq[2]] - hy[seq[0]]) * a));
    const area = f32(width * height);
    if (area <= minArea) {
      minArea = area;
      best = { left: seq[3], bottom: seq[0], a, b, width, height };
    }
  }

  const { a, b } = best;
  const c1 = fma32(a, hx[best.left], f32(hy[best.left] * b));
  const c2 = fma32(-b, hx[best.bottom], f32(hy[best.bottom] * a));
  const idet = f32(1 / fma32(a, a, f32(b * b)));
  return {
    px: f32(idet * fma32(c1, a, -f32(b * c2))),
    py: f32(idet * fma32(a, c2, f32(b * c1))),
    v1: [f32(a * best.width), f32(b * best.width)],
    v2: [f32(-b * best.height), f32(a * best.height)],
  };
}

const length32 = (x: number, y: number): number => f32(Math.sqrt(x * x + y * y));

/**
 * cv2.minAreaRect over x,y pairs with integer values. An Int32Array takes cv2's CV_32S hull path, as findContours
 * output does; anything else takes its CV_32F path, as the float32 polygon from unclip does, whose turn tests run on
 * vectors normalised to float32.
 */
export function minAreaRect(points: ArrayLike<number>): RotatedRect {
  const hull = convexHull(points, !(points instanceof Int32Array));
  const n = hull.length;
  const hx = Float32Array.from(hull, (i) => points[2 * i]);
  const hy = Float32Array.from(hull, (i) => points[2 * i + 1]);
  if (n > 2) {
    const { px, py, v1, v2 } = calipers(hx, hy);
    const rect = {
      cx: f32(px + f32(v1[0] + v2[0]) * 0.5),
      cy: f32(py + f32(v1[1] + v2[1]) * 0.5),
      width: length32(v2[0], v2[1]),
      height: length32(v1[0], v1[1]),
      angle: UPRIGHT,
    };
    if (v1[0] === 0 && v1[1] > 0) return { ...rect, width: rect.height, height: rect.width };
    return { ...rect, angle: f32((-Math.atan2(v1[0], v1[1]) * 180) / Math.PI) };
  }
  if (n === 2) {
    const center = { cx: f32(f32(hx[0] + hx[1]) * 0.5), cy: f32(f32(hy[0] + hy[1]) * 0.5) };
    const dx = f32(hx[0] - hx[1]);
    const dy = f32(hy[0] - hy[1]);
    const span = length32(dx, dy);
    if (dx === 0) return { ...center, width: span, height: 0, angle: UPRIGHT };
    if (dy < 0) return { ...center, width: span, height: 0, angle: f32((Math.atan2(dy, dx) * 180) / Math.PI) };
    if (dy > 0) return { ...center, width: 0, height: span, angle: f32((-Math.atan2(dx, dy) * 180) / Math.PI) };
    return { ...center, width: 0, height: span, angle: UPRIGHT };
  }
  return { cx: n === 1 ? hx[0] : 0, cy: n === 1 ? hy[0] : 0, width: 0, height: 0, angle: UPRIGHT };
}

/** cv2.boxPoints: the four corners in RotatedRect::points order, each step rounded to float32 as cv2 computes it. */
export function boxPoints(rect: RotatedRect): Quad {
  const angle = (rect.angle * Math.PI) / 180;
  const b = f32(f32(Math.cos(angle)) * 0.5);
  const a = f32(f32(Math.sin(angle)) * 0.5);
  const ah = f32(a * rect.height);
  const aw = f32(a * rect.width);
  const bh = f32(b * rect.height);
  const bw = f32(b * rect.width);
  const { cx, cy } = rect;
  return Float32Array.of(
    f32(f32(cx - ah) - bw),
    f32(f32(cy + bh) - aw),
    f32(f32(cx + ah) - bw),
    f32(f32(cy - bh) - aw),
    f32(f32(cx + ah) + bw),
    f32(f32(cy - bh) + aw),
    f32(f32(cx - ah) + bw),
    f32(f32(cy + bh) + aw),
  );
}
