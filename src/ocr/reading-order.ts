/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

import { maxBy, median } from "es-toolkit";
import { atLeastOne, lineHeight, quadHeight, type Quad } from "./geometry/quad.js";
import { argmin, f32, mean, sortedIndices } from "./numeric.js";
import { pageSkew } from "./skew.js";
import { PY_SPACE } from "./thai-norm.js";

/** x min, x max, y min, y max of a box in deskewed coordinates. */
type Extent = readonly [number, number, number, number];
type Interval = readonly [number, number];

const DIGITS = new Set("0123456789๐๑๒๓๔๕๖๗๘๙");
const SPACE_CLASS = `[${PY_SPACE}]`;
const SPACE = new RegExp(SPACE_CLASS, "u");
const ENUM = new RegExp(`^${SPACE_CLASS}*\\(?([0-9\\u0E50-\\u0E59]{1,4})${SPACE_CLASS}*[.)]`, "u");

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

interface Layout {
  ext: readonly Extent[];
  hmed: number;
  texts: readonly string[];
}

const xIntervals = (idx: readonly number[], ext: readonly Extent[]): Interval[] => idx.map((i) => [ext[i][0], ext[i][1]]);

/** The column of one side that touches the gutter; a side can hold several. */
function nextToGutter(side: number[], layout: Layout, gutterOnRight: boolean): number[] {
  if (side.length === 0) return side;
  const g = gaps(xIntervals(side, layout.ext), 0.8 * layout.hmed);
  if (g.length === 0) return side;
  return gutterOnRight ? side.filter((i) => layout.ext[i][0] >= g[g.length - 1][1]) : side.filter((i) => layout.ext[i][1] <= g[0][0]);
}

const enumNumber = (text: string): number | undefined => {
  const m = text.match(ENUM);
  return m ? Number(Array.from(m[1], (d) => (d >= "๐" ? String(d.charCodeAt(0) - 0x0e50) : d)).join("")) : undefined;
};

/** A column of prose: enough long lines, most filling the column width, few digits. */
function isProse(col: readonly number[], { ext, hmed, texts }: Layout): boolean {
  if (col.length < 12) return false;
  const widths = col.map((i) => ext[i][1] - ext[i][0]);
  const span = Math.max(...col.map((i) => ext[i][1])) - Math.min(...col.map((i) => ext[i][0]));
  if (median(widths) < 7 * hmed) return false;
  if (widths.filter((w) => w >= 0.75 * span).length / widths.length < 0.5) return false;
  const chars = col.flatMap((i) => Array.from(texts[i])).filter((ch) => !SPACE.test(ch));
  return !(chars.length > 0 && chars.filter((ch) => DIGITS.has(ch)).length > 0.3 * chars.length);
}

/** Most facing lines numbered n on the left and n+1 on the right: a list that reads across. */
function numberedAcross(lcol: readonly number[], rcol: readonly number[], { ext, hmed, texts }: Layout): boolean {
  const middle = (i: number) => (ext[i][2] + ext[i][3]) / 2;
  const pairs = lcol.filter((i) => {
    const n = enumNumber(texts[i]);
    if (n === undefined) return false;
    return rcol.some((j) => enumNumber(texts[j]) === n + 1 && Math.abs(middle(j) - middle(i)) <= 0.5 * hmed);
  }).length;
  return pairs >= 0.5 * Math.min(lcol.length, rcol.length);
}

/** Recursive XY-cut: a vertical cut only between two prose columns, else the widest horizontal gap. */
function blocks(idx: number[], layout: Layout, depth: number): number[][] {
  if (idx.length < 6 || depth > 12) return [idx];
  const { ext, hmed } = layout;
  const cuts = gaps(xIntervals(idx, ext), 0.8 * hmed).flatMap(([g0, g1]) => {
    const left = idx.filter((i) => ext[i][1] <= g0);
    const right = idx.filter((i) => ext[i][0] >= g1);
    const lcol = nextToGutter(left, layout, true);
    const rcol = nextToGutter(right, layout, false);
    const prose = isProse(lcol, layout) && isProse(rcol, layout) && !numberedAcross(lcol, rcol, layout);
    return prose ? [{ width: g1 - g0, left, right }] : [];
  });
  if (cuts.length > 0) {
    const { left, right } = maxBy(cuts, (c) => c.width)!;
    return [...blocks(left, layout, depth + 1), ...blocks(right, layout, depth + 1)];
  }
  const horizontal = gaps(
    idx.map((i): Interval => [ext[i][2], ext[i][3]]),
    0.8 * hmed,
  );
  if (horizontal.length === 0) return [idx];
  const [g0, g1] = maxBy(horizontal, ([lo, hi]) => hi - lo)!;
  const top = idx.filter((i) => ext[i][3] <= g0);
  const bottom = idx.filter((i) => ext[i][2] >= g1);
  return [...blocks(top, layout, depth + 1), ...blocks(bottom, layout, depth + 1)];
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
 * the other. `texts` (the raw line readings) lets the column test reject number columns.
 */
export function readingOrder(boxes: readonly Quad[], texts: readonly string[], angle = pageSkew(boxes)): number[][] {
  if (boxes.length === 0) return [];
  const ext = deskewedExtents(boxes, angle);
  const hmed = lineHeight(boxes);
  const layout: Layout = { ext, hmed, texts };
  const cy = ext.map((e) => (e[2] + e[3]) / 2);
  const rx = ext.map((e) => (e[0] + e[1]) / 2);
  const hs = boxes.map((box) => atLeastOne(quadHeight(box)));
  const all = boxes.map((_, i) => i);
  return blocks(all, layout, 0).flatMap((blk) => blockRows(blk, cy, rx, hs, hmed));
}
