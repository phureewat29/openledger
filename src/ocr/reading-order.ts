/** Ported from line_engine.py (Apache-2.0). */

import { maxBy, range } from "es-toolkit";
import { shouldCutBetween, type Extent, type Layout } from "./columns.js";
import { atLeastOne, extent, lineHeight, quadHeight, type Quad } from "./geometry/quad.js";
import { argmin, f32, mean, sortedIndices } from "./numeric.js";
import { pageSkew } from "./skew.js";

type Interval = readonly [number, number];

/** Box corners turned by -angle, through a float32 matrix as numpy's 4x2 @ 2x2 does it (fused second product). */
function deskewedExtents(boxes: readonly Quad[], angle: number): Extent[] {
  const a = -angle * (Math.PI / 180);
  const [c, s] = [f32(Math.cos(a)), f32(Math.sin(a))];
  const rot = [c, f32(-Math.sin(a)), s, c];
  return boxes.map((box) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < 8; i += 2) {
      xs.push(f32(f32(box[i] * rot[0]) + box[i + 1] * rot[1]));
      ys.push(f32(f32(box[i] * rot[2]) + box[i + 1] * rot[3]));
    }
    return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  });
}

/** Empty bands between intervals at least `minGap` wide. */
function gaps(intervals: readonly Interval[], minGap: number): Interval[] {
  const sorted = intervals.toSorted((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out: Interval[] = [];
  let reach = sorted[0][1];
  for (const [lo, hi] of sorted.slice(1)) {
    if (lo - reach >= minGap) out.push([reach, lo]);
    reach = Math.max(reach, hi);
  }
  return out;
}

const xIntervals = (idx: readonly number[], ext: readonly Extent[]): Interval[] => idx.map((i) => [ext[i][0], ext[i][1]]);

/** The column of one side that touches the gutter; a side can hold several. */
function nextToGutter(side: number[], layout: Layout, gutterOnRight: boolean): number[] {
  if (side.length === 0) return side;
  const g = gaps(xIntervals(side, layout.ext), 0.8 * layout.hmed);
  if (g.length === 0) return side;
  return gutterOnRight ? side.filter((i) => layout.ext[i][0] >= g[g.length - 1][1]) : side.filter((i) => layout.ext[i][1] <= g[0][0]);
}

/** Recursive XY-cut: a vertical cut only between two prose columns, else the widest horizontal gap, else banded columns. */
function blocks(idx: number[], layout: Layout, depth: number): number[][] {
  if (idx.length < 6 || depth > 12) return [idx];
  const { ext, hmed } = layout;
  const cuts = gaps(xIntervals(idx, ext), 0.8 * hmed).flatMap(([g0, g1]) => {
    const left = idx.filter((i) => ext[i][1] <= g0);
    const right = idx.filter((i) => ext[i][0] >= g1);
    const cut = shouldCutBetween(nextToGutter(left, layout, true), nextToGutter(right, layout, false), layout);
    return cut ? [{ width: g1 - g0, left, right }] : [];
  });
  if (cuts.length > 0) {
    const { left, right } = maxBy(cuts, (c) => c.width)!;
    return [...blocks(left, layout, depth + 1), ...blocks(right, layout, depth + 1)];
  }
  const horizontal = gaps(
    idx.map((i): Interval => [ext[i][2], ext[i][3]]),
    0.8 * hmed,
  );
  if (horizontal.length === 0) return bandedColumns(idx, layout, depth) ?? [idx];
  const [g0, g1] = maxBy(horizontal, ([lo, hi]) => hi - lo)!;
  const top = idx.filter((i) => ext[i][3] <= g0);
  const bottom = idx.filter((i) => ext[i][2] >= g1);
  return [...blocks(top, layout, depth + 1), ...blocks(bottom, layout, depth + 1)];
}

/** Integer x bands in the middle 70 % of the block, at least 0.4 line heights wide, that at most 3 % of `rest` (or one line) crosses. */
function gutterRuns(rest: readonly number[], { ext, hmed }: Layout, x0: number, x1: number): Interval[] {
  const lo = Math.trunc(x0 + 0.15 * (x1 - x0));
  const n = Math.trunc(0.7 * (x1 - x0)) + 1;
  const cover = new Int32Array(n);
  for (const i of rest) {
    const end = Math.min(n, Math.ceil(ext[i][1]) - lo);
    for (let x = Math.max(0, Math.trunc(ext[i][0]) - lo); x < end; x++) cover[x]++;
  }
  const limit = Math.max(1, Math.trunc(0.03 * rest.length));
  const runs: Interval[] = [];
  let start: number | undefined;
  for (let x = 0; x <= n; x++) {
    if (x < n && cover[x] <= limit) {
      start ??= x;
      continue;
    }
    if (start === undefined) continue;
    if (x - start >= 0.4 * hmed) runs.push([lo + start, lo + x]);
    start = undefined;
  }
  return runs;
}

/**
 * Prose columns that a few full-width lines cross (a title over both, a footer, a caption between sections), where
 * neither cut applies. The wide lines and those crossing the whole gutter cut the block into bands; each band is read
 * left of the gutter, then right of it, then the crossing line under it. Undefined when the block has no such gutter.
 */
export function bandedColumns(idx: readonly number[], layout: Layout, depth: number): number[][] | undefined {
  const { ext } = layout;
  const x0 = Math.min(...idx.map((i) => ext[i][0]));
  const x1 = Math.max(...idx.map((i) => ext[i][1]));
  const wide = idx.filter((i) => ext[i][1] - ext[i][0] >= 0.55 * (x1 - x0));
  if (wide.length > 0.15 * idx.length) return undefined;
  const wideSet = new Set(wide);
  const rest = idx.filter((i) => !wideSet.has(i));
  if (rest.length < 24) return undefined;
  const runs = gutterRuns(rest, layout, x0, x1);
  const columnGutters = runs.filter(([g0, g1], k) => {
    const lcol = rest.filter((i) => ext[i][1] <= g0 && (k === 0 || ext[i][0] >= runs[k - 1][1]));
    const rcol = rest.filter((i) => ext[i][0] >= g1 && (k === runs.length - 1 || ext[i][1] <= runs[k + 1][0]));
    return shouldCutBetween(lcol, rcol, layout);
  });
  const gutter = maxBy(columnGutters, ([g0, g1]) => g1 - g0);
  if (!gutter) return undefined;
  const [g0, g1] = gutter;
  const centreX = (g0 + g1) / 2;
  const cy = (i: number) => (ext[i][2] + ext[i][3]) / 2;
  const cx = (i: number) => (ext[i][0] + ext[i][1]) / 2;
  const crossing = rest.filter((i) => ext[i][0] < g0 && ext[i][1] > g1);
  const crossingSet = new Set(crossing);
  const seps = [...wide, ...crossing].toSorted((p, q) => cy(p) - cy(q));
  return range(seps.length + 1).flatMap((b) => {
    const lo = b > 0 ? cy(seps[b - 1]) : -Infinity;
    const hi = b < seps.length ? cy(seps[b]) : Infinity;
    const band = rest.filter((i) => !crossingSet.has(i) && lo < cy(i) && cy(i) <= hi);
    const sides = [band.filter((i) => cx(i) < centreX), band.filter((i) => cx(i) >= centreX)];
    const read = sides.filter((side) => side.length > 0).flatMap((side) => blocks(side, layout, depth + 1));
    return b < seps.length ? [...read, [seps[b]]] : read;
  });
}

/** Rows of one block: full-height lines group by their row's running centre; small boxes then join the nearest row. */
function blockRows(blk: readonly number[], cy: readonly number[], rx: readonly number[], hs: readonly number[], hmed: number): number[][] {
  const tol = 0.5 * hmed;
  const tall = blk.filter((i) => hs[i] >= 0.6 * hmed);
  const full = tall.length > 0 ? tall : [...blk];
  const fullSet = new Set(full);
  const rows: number[][] = [];
  for (const i of full.toSorted((p, q) => cy[p] - cy[q])) {
    const last = rows.at(-1);
    if (last && Math.abs(cy[i] - mean(last.map((j) => cy[j]))) <= tol) last.push(i);
    else rows.push([i]);
  }
  const centre = rows.map((r) => mean(r.map((j) => cy[j])));
  for (const i of blk.filter((k) => !fullSet.has(k))) {
    const d = centre.map((c) => Math.abs(cy[i] - c));
    if (d.length > 0 && Math.min(...d) <= tol + 0.5 * hs[i]) {
      rows[argmin(d)].push(i);
      continue;
    }
    rows.push([i]);
    centre.push(cy[i]);
  }
  return sortedIndices(rows.length, (r) => centre[r]).map((r) => rows[r].toSorted((p, q) => rx[p] - rx[q]));
}

/**
 * Rows top to bottom, each left to right, in deskewed coordinates, block by block so text columns read one after
 * the other. `texts` (the raw line readings) lets the column test reject number columns and lists. On a tilted page
 * the blocks come from the unrotated boxes instead when those find more: a skew estimate a degree or two off lets
 * line ends cover a narrow gutter. Rows always group in the deskewed frame.
 */
export function readingOrder(boxes: readonly Quad[], texts?: readonly string[], angle = pageSkew(boxes)): number[][] {
  if (boxes.length === 0) return [];
  const ext = deskewedExtents(boxes, angle);
  const hmed = lineHeight(boxes);
  const all = boxes.map((_, i) => i);
  const deskewed = blocks(all, { ext, hmed, texts }, 0);
  const unrotated = angle !== 0 ? blocks(all, { ext: boxes.map(extent), hmed, texts }, 0) : [];
  const cy = ext.map((e) => (e[2] + e[3]) / 2);
  const rx = ext.map((e) => (e[0] + e[1]) / 2);
  const hs = boxes.map((box) => atLeastOne(quadHeight(box)));
  return (unrotated.length > deskewed.length ? unrotated : deskewed).flatMap((blk) => blockRows(blk, cy, rx, hs, hmed));
}
