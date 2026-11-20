/** Ported from line_engine.py (Apache-2.0). */

import { median } from "es-toolkit";
import { f32, norm32 } from "../numeric.js";

/** Four corners as float32 values, x0 y0 x1 y1 x2 y2 x3 y3; ordered quads run top-left, top-right, bottom-right, bottom-left. */
export type Quad = Float32Array;

/** cv2.RotatedRect: every field holds a float32 value. */
export interface RotatedRect {
  cx: number;
  cy: number;
  width: number;
  height: number;
  angle: number;
}

const byKey = (key: (i: number) => number) => (a: number, b: number) => key(a) - key(b);

/** Corners as top-left, top-right, bottom-right, bottom-left; ties keep input order, as np.argsort does on four elements. */
export function orderPoints(box: Quad): Quad {
  const x = (i: number) => box[i * 2];
  const y = (i: number) => box[i * 2 + 1];
  const byX = [0, 1, 2, 3].sort(byKey(x));
  const [l0, l1] = byX.slice(0, 2).sort(byKey(y));
  const [r0, r1] = byX.slice(2).sort(byKey(y));
  return Float32Array.of(x(l0), y(l0), x(r0), y(r0), x(r1), y(r1), x(l1), y(l1));
}

/** Corner i to corner j, as np.linalg.norm on a float32 difference. */
export const span = (box: Quad, i: number, j: number): number =>
  norm32(f32(box[i * 2] - box[j * 2]), f32(box[i * 2 + 1] - box[j * 2 + 1]));

/** Top edge length. */
export const quadWidth = (box: Quad): number => span(box, 0, 1);

/** Left edge length. */
export const quadHeight = (box: Quad): number => span(box, 0, 3);

/** Python's float(max(norm, 1.0)). */
export const atLeastOne = (value: number): number => Math.max(value, 1);

/**
 * Typical text-line height: the median over line-shaped boxes (at least twice as wide as tall), so the
 * fragments bold text sheds don't set it; the median over all boxes when fewer than three are line-shaped.
 */
export function lineHeight(boxes: readonly Quad[]): number {
  if (boxes.length === 0) return 1;
  const heights = boxes.map((box) => atLeastOne(quadHeight(box)));
  const lines = heights.filter((h, i) => quadWidth(boxes[i]) >= 2 * h);
  return median(lines.length >= 3 ? lines : heights);
}

/** Each box's height over the page's line height. */
export function heightRatios(boxes: readonly Quad[]): number[] {
  const hmed = lineHeight(boxes);
  return boxes.map((box) => quadHeight(box) / hmed);
}

export type Orientation = 1 | -1 | 0;

/** 1 for a box `ratio` times taller than wide, -1 for one that much wider than tall, 0 otherwise. */
export function orientation(box: Quad, ratio: number): Orientation {
  const w = quadWidth(box);
  const h = quadHeight(box);
  if (h >= f32(ratio * atLeastOne(w))) return 1;
  if (w >= f32(ratio * atLeastOne(h))) return -1;
  return 0;
}

/** x min, x max, y min, y max over the corners, as float32 values. */
export function extent(box: Quad): [number, number, number, number] {
  const xs = [box[0], box[2], box[4], box[6]];
  const ys = [box[1], box[3], box[5], box[7]];
  return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
}
