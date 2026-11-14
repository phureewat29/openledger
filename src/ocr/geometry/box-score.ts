/** Reproduces _box_score's cv2.fillPoly and cv2.mean as line_engine.py (Apache-2.0) calls them; see THIRD_PARTY_NOTICES.md. */

import type { Quad } from "./quad.js";

const SHIFT = 65536;

interface Mask {
  data: Uint8Array;
  cols: number;
  rows: number;
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Edge {
  y0: number;
  y1: number;
  x: number;
  dx: number;
  next: Edge | null;
}

/** cv2.clipLine on 64-bit points: false when the segment misses the image; the segment is clipped in place. */
function clipLine(cols: number, rows: number, seg: Segment): boolean {
  const right = cols - 1;
  const bottom = rows - 1;
  if (cols <= 0 || rows <= 0) return false;
  const code = (x: number, y: number): number =>
    (x < 0 ? 1 : 0) + (x > right ? 2 : 0) + (y < 0 ? 4 : 0) + (y > bottom ? 8 : 0);
  let c1 = code(seg.x1, seg.y1);
  let c2 = code(seg.x2, seg.y2);
  if ((c1 & c2) !== 0 || (c1 | c2) === 0) return (c1 | c2) === 0;
  if (c1 & 12) {
    const a = c1 < 8 ? 0 : bottom;
    seg.x1 += Math.trunc(((a - seg.y1) * (seg.x2 - seg.x1)) / (seg.y2 - seg.y1));
    seg.y1 = a;
    c1 = code(seg.x1, 0) & 3;
  }
  if (c2 & 12) {
    const a = c2 < 8 ? 0 : bottom;
    seg.x2 += Math.trunc(((a - seg.y2) * (seg.x2 - seg.x1)) / (seg.y2 - seg.y1));
    seg.y2 = a;
    c2 = code(seg.x2, 0) & 3;
  }
  if ((c1 & c2) === 0 && (c1 | c2) !== 0) {
    if (c1) {
      const a = c1 === 1 ? 0 : right;
      seg.y1 += Math.trunc(((a - seg.x1) * (seg.y2 - seg.y1)) / (seg.x2 - seg.x1));
      seg.x1 = a;
      c1 = 0;
    }
    if (c2) {
      const a = c2 === 1 ? 0 : right;
      seg.y2 += Math.trunc(((a - seg.x2) * (seg.y2 - seg.y1)) / (seg.x2 - seg.x1));
      seg.x2 = a;
      c2 = 0;
    }
  }
  return (c1 | c2) === 0;
}

const outside = (mask: Mask, seg: Segment): boolean =>
  seg.x1 >>> 0 >= mask.cols || seg.x2 >>> 0 >= mask.cols || seg.y1 >>> 0 >= mask.rows || seg.y2 >>> 0 >= mask.rows;

/** cv2's 8-connected Line through LineIterator(leftToRight=true), clipped to the mask. */
function drawLine(mask: Mask, x1: number, y1: number, x2: number, y2: number): void {
  const seg = { x1, y1, x2, y2 };
  if (outside(mask, seg) && !clipLine(mask.cols, mask.rows, seg)) return;
  let dx = seg.x2 - seg.x1;
  let dy = seg.y2 - seg.y1;
  let at = seg.y1 * mask.cols + seg.x1;
  if (dx < 0) {
    dx = -dx;
    dy = -dy;
    at = seg.y2 * mask.cols + seg.x2;
  }
  let stepY = mask.cols;
  if (dy < 0) {
    dy = -dy;
    stepY = -stepY;
  }
  const vertical = dy > dx;
  const [major, minor] = vertical ? [dy, dx] : [dx, dy];
  const straight = vertical ? stepY : 1;
  const diagonal = 1 + stepY;
  let err = major - 2 * minor;
  for (let i = 0; i <= major; i++) {
    mask.data[at] = 1;
    if (err < 0) {
      err += 2 * major - 2 * minor;
      at += diagonal;
    } else {
      err -= 2 * minor;
      at += straight;
    }
  }
}

/** cv2's CollectPolyEdges for shift 0: draws every side, keeps the non-horizontal ones as 16.16 fixed-point edges. */
function collectEdges(mask: Mask, xs: number[], ys: number[]): Edge[] {
  const edges: Edge[] = [];
  const n = xs.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const seg = { x1: xs[j], y1: ys[j], x2: xs[i], y2: ys[i] };
    drawLine(mask, seg.x1, seg.y1, seg.x2, seg.y2);
    let y0c = ys[j];
    let y1c = ys[i];
    if (outside(mask, seg)) {
      clipLine(mask.cols, mask.rows, seg);
      if (seg.y1 !== seg.y2) [y0c, y1c] = [seg.y1, seg.y2];
    }
    if (ys[j] === ys[i]) continue;
    const x0c = seg.x1 * SHIFT;
    const x1c = seg.x2 * SHIFT;
    const dx = Math.trunc((x1c - x0c) / (y1c - y0c));
    edges.push(
      ys[j] < ys[i]
        ? { y0: ys[j], y1: ys[i], x: x0c + (ys[j] - y0c) * dx, dx, next: null }
        : { y0: ys[i], y1: ys[j], x: x1c + (ys[i] - y1c) * dx, dx, next: null },
    );
  }
  return edges;
}

function fillRow(mask: Mask, y: number, a: Edge, b: Edge): void {
  const [left, right] = a.x > b.x ? [b, a] : [a, b];
  const x1 = Math.max(Math.floor((left.x + SHIFT - 1) / SHIFT), 0);
  const x2 = Math.min(Math.floor(right.x / SHIFT), mask.cols - 1);
  if (x1 >= mask.cols || x2 < 0) return;
  mask.data.fill(1, y * mask.cols + x1, y * mask.cols + x2 + 1);
}

/** cv2's FillEdgeCollection: a scanline fill over an active edge list kept in x order by bubble sort. */
function fillEdges(mask: Mask, edges: Edge[]): void {
  const total = edges.length;
  if (total < 2) return;
  let yMin = Infinity;
  let yMax = -Infinity;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const e of edges) {
    const xEnd = e.x + (e.y1 - e.y0) * e.dx;
    yMin = Math.min(yMin, e.y0);
    yMax = Math.max(yMax, e.y1);
    xMin = Math.min(xMin, e.x, xEnd);
    xMax = Math.max(xMax, e.x, xEnd);
  }
  if (yMax < 0 || yMin >= mask.rows || xMax < 0 || xMin >= mask.cols * SHIFT) return;
  edges.sort((a, b) => a.y0 - b.y0 || a.x - b.x || a.dx - b.dx);
  const sentinel: Edge = { y0: Infinity, y1: 0, x: 0, dx: 0, next: null };
  const head: Edge = { y0: Infinity, y1: 0, x: 0, dx: 0, next: null };
  let i = 0;
  let e = edges[0];
  yMax = Math.min(yMax, mask.rows);
  for (let y = e.y0; y < yMax; y++) {
    let draw = false;
    let prelast = head;
    let last = head.next;
    while (last || e.y0 === y) {
      if (last && last.y1 === y) {
        prelast.next = last.next;
        last = last.next;
        continue;
      }
      const keep = prelast;
      if (last && (e.y0 > y || last.x < e.x)) {
        prelast = last;
        last = last.next;
      } else if (i < total) {
        prelast.next = e;
        e.next = last;
        prelast = e;
        e = ++i < total ? edges[i] : sentinel;
      } else break;
      if (draw) {
        if (y >= 0) fillRow(mask, y, keep, prelast);
        keep.x += keep.dx;
        prelast.x += prelast.dx;
      }
      draw = !draw;
    }
    bubbleSort(head);
  }
}

function bubbleSort(head: Edge): void {
  let stop: Edge | null = null;
  for (;;) {
    let prelast = head;
    let last = head.next;
    let exchanged: Edge | null = null;
    while (last && last !== stop && last.next) {
      const te: Edge = last.next;
      if (last.x > te.x) {
        prelast.next = te;
        last.next = te.next;
        te.next = last;
        prelast = te;
        exchanged = prelast;
      } else {
        prelast = last;
        last = te;
      }
    }
    if (!exchanged) return;
    stop = exchanged;
    if (stop === head.next || stop === head) return;
  }
}

const clip = (value: number, high: number): number => Math.min(Math.max(value, 0), high);

/**
 * _box_score: the mean of prob over cv2.fillPoly of the box inside its clipped bounding rectangle, summed in double
 * in raster order and scaled by 1/count as cv2.mean does.
 */
export function boxScore(prob: Float32Array, width: number, height: number, box: Quad): number {
  const xs = [box[0], box[2], box[4], box[6]];
  const ys = [box[1], box[3], box[5], box[7]];
  const x0 = clip(Math.floor(Math.min(...xs)), width - 1);
  const x1 = clip(Math.ceil(Math.max(...xs)), width - 1);
  const y0 = clip(Math.floor(Math.min(...ys)), height - 1);
  const y1 = clip(Math.ceil(Math.max(...ys)), height - 1);
  const mask: Mask = { cols: x1 - x0 + 1, rows: y1 - y0 + 1, data: new Uint8Array((x1 - x0 + 1) * (y1 - y0 + 1)) };
  fillEdges(mask, collectEdges(mask, xs.map((x) => Math.trunc(x - x0)), ys.map((y) => Math.trunc(y - y0))));
  let sum = 0;
  let count = 0;
  for (let y = 0; y < mask.rows; y++) {
    for (let x = 0; x < mask.cols; x++) {
      if (!mask.data[y * mask.cols + x]) continue;
      sum += prob[(y0 + y) * width + x0 + x];
      count++;
    }
  }
  return count ? sum * (1 / count) : 0;
}
