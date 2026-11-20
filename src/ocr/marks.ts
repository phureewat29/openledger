/** Ported from line_engine.py (Apache-2.0). */

import { clamp, median } from "es-toolkit";
import { cropLine } from "./crop.js";
import { heightRatios, lineHeight, type Quad } from "./geometry/quad.js";
import { dropReason } from "./line-filter.js";
import type { Models } from "./models.js";
import { readBoxes, type PageLines } from "./page-lines.js";
import type { Raster } from "./raster.js";
import type { Reading } from "./recognize/ctc.js";
import { MARKS } from "./settings.js";
import { baseLetters, digitsOf } from "./text-classes.js";
import { normalizeReading } from "./thai-norm.js";

type Vector = readonly [number, number];
/** 0 above the line, 1 below it. */
type Side = 0 | 1;

/** A kept line in float64, as numpy promotes its box: origin at the top-left corner, unit vectors along and across. */
interface LineFrame {
  line: number;
  origin: Vector;
  along: Vector;
  across: Vector;
  width: number;
  height: number;
}

interface Mark {
  /** Position of the owning line in the frame list. */
  owner: number;
  side: Side;
  gap: number;
  reach: number;
}

export interface MarkPlan {
  /** Each absorbed mark box and the line it belongs to. */
  owner: ReadonlyMap<number, number>;
  /** Enough lines had marks on one side that the typeface floats its marks. */
  floating: boolean;
  /** The lines to read again, each with its box grown over its marks. */
  grown: { line: number; box: Quad }[];
}

/** np.linalg.norm of a float64 2-vector: a plain dot product, not fused. */
const norm64 = (x: number, y: number): number => Math.sqrt(x * x + y * y);

function lineFrame(box: Quad, line: number): LineFrame {
  const [x0, y0, x1, y1, , , x3, y3] = box;
  const width = norm64(x1 - x0, y1 - y0);
  const height = norm64(x3 - x0, y3 - y0);
  const along: Vector = [(x1 - x0) / width, (y1 - y0) / width];
  const across: Vector = [(x3 - x0) / height, (y3 - y0) / height];
  return { line, origin: [x0, y0], along, across, width, height };
}

/** A box's span along and across a line's frame: s min, s max, t min, t max. */
function project({ origin, along, across }: LineFrame, box: Quad): [number, number, number, number] {
  const s: number[] = [];
  const t: number[] = [];
  for (let k = 0; k < 8; k += 2) {
    const [px, py] = [box[k] - origin[0], box[k + 1] - origin[1]];
    s.push(px * along[0] + py * along[1]);
    t.push(px * across[0] + py * across[1]);
  }
  return [Math.min(...s), Math.max(...s), Math.min(...t), Math.max(...t)];
}

/** Where a box sits as a mark of one line: overlapping it along its length, no taller than it, not across its middle. */
function markOf(frame: LineFrame, box: Quad): Omit<Mark, "owner"> | undefined {
  const [s0, s1, t0, t1] = project(frame, box);
  const { width, height } = frame;
  if (t1 - t0 > MARKS.maxHeight * height || Math.min(s1, width) - Math.max(s0, 0) < 0.5 * (s1 - s0)) return undefined;
  if (t1 > 0.5 * height && t0 < 0.5 * height) return undefined;
  const mark: Omit<Mark, "owner"> =
    t1 <= 0.5 * height ? { side: 0, gap: Math.max(0, -t1), reach: -t0 } : { side: 1, gap: Math.max(0, t0 - height), reach: t1 - height };
  return mark.gap > MARKS.maxGap * height || mark.reach > MARKS.maxExt * height ? undefined : mark;
}

/** The nearest line a box is a mark of; a tie goes to the line below the mark, as upper marks outnumber lower ones. */
function nearestOwner(box: Quad, frames: readonly LineFrame[]): Mark | undefined {
  let best: Mark | undefined;
  for (const [owner, frame] of frames.entries()) {
    const mark = markOf(frame, box);
    if (!mark) continue;
    if (!best || mark.gap < best.gap || (mark.gap === best.gap && mark.side < best.side)) best = { ...mark, owner };
  }
  return best;
}

/** How far a line with no detected marks grows on a side of a page that floats them: the typical reach, short of its neighbour's core. */
function room(frame: LineFrame, side: Side, typical: number, frames: readonly LineFrame[], boxes: readonly Quad[]): number {
  const { height } = frame;
  return frames.reduce((limit, other) => {
    if (other.line === frame.line) return limit;
    const [s0, s1, t0, t1] = project(frame, boxes[other.line]);
    if (Math.min(s1, frame.width) - Math.max(s0, 0) <= 0) return limit;
    if (side === 0 && t1 <= 0.5 * height) return Math.min(limit, Math.max(0, -t1 * 0.9));
    if (side === 1 && t0 >= 0.5 * height) return Math.min(limit, Math.max(0, (t0 - height) * 0.9));
    return limit;
  }, typical * height);
}

/** The box moved out across the line by `up` and `down`, clipped to the page, back in float32. */
function grow(box: Quad, [vx, vy]: Vector, [up, down]: readonly number[], page: Pick<Raster, "width" | "height">): Quad {
  const out = Array.from(box);
  for (const k of up > 0 ? [0, 2] : []) {
    out[k] -= vx * up;
    out[k + 1] -= vy * up;
  }
  for (const k of down > 0 ? [4, 6] : []) {
    out[k] += vx * down;
    out[k + 1] += vy * down;
  }
  return Float32Array.from(out, (v, i) => clamp(v, 0, (i % 2 === 0 ? page.width : page.height) - 1));
}

/**
 * Floating Thai marks (old letterpress type) that the detector boxed apart from their line: each candidate box within
 * `maxGap` line heights above or below a kept line it overlaps joins the nearest one, whose box grows over it. When
 * `pageShare` of the lines (and `pageMin`) have marks on a side, the type floats them, and every other line grows by
 * the typical reach on that side too. `candidates` flags the boxes from `markCandidates`.
 */
export function planMarks(boxes: readonly Quad[], candidates: readonly boolean[], page: Pick<Raster, "width" | "height">): MarkPlan | undefined {
  if (!candidates.includes(true) || !candidates.includes(false)) return undefined;
  const hmed = lineHeight(boxes.filter((_, i) => !candidates[i]));
  const frames = boxes
    .flatMap((box, line) => (candidates[line] ? [] : [lineFrame(box, line)]))
    .filter((f) => f.width >= 1 && f.height >= 0.5 * hmed);
  if (frames.length === 0) return undefined;
  const owner = new Map<number, number>();
  const reach = frames.map(() => [0, 0]);
  boxes.forEach((box, j) => {
    const mark = candidates[j] ? nearestOwner(box, frames) : undefined;
    if (!mark) return;
    owner.set(j, frames[mark.owner].line);
    reach[mark.owner][mark.side] = Math.max(reach[mark.owner][mark.side], mark.reach);
  });
  if (owner.size === 0) return undefined;
  const typical = ([0, 1] as const).map((side) => {
    const lifted = frames.flatMap((frame, k) => (reach[k][side] > 0 ? [reach[k][side] / frame.height] : []));
    return lifted.length >= Math.max(MARKS.pageMin, MARKS.pageShare * frames.length) ? median(lifted) : undefined;
  });
  const grown = frames.flatMap((frame, k) => {
    const sides = ([0, 1] as const).map((side) => {
      const share = typical[side];
      return reach[k][side] > 0 || !share ? reach[k][side] : room(frame, side, share, frames, boxes);
    });
    return sides.some((r) => r > 0) ? [{ line: frame.line, box: grow(boxes[frame.line], frame.across, sides, page) }] : [];
  });
  return { owner, floating: typical.some((t) => t !== undefined), grown };
}

/** A re-read must pass the filter and change no letter but marks or, where the type floats its marks, no digit. */
function shouldReplace(old: Reading, next: Reading, floating: boolean): boolean {
  const after = normalizeReading(next.text);
  if (dropReason(after, next.confidence)) return false;
  const before = normalizeReading(old.text);
  return floating ? digitsOf(after) === digitsOf(before) : baseLetters(after) === baseLetters(before);
}

/** The boxes the line filter would drop anyway, `skip` (the fragments) included: the only candidates for marks. */
export function markCandidates({ boxes, readings }: PageLines, skip: ReadonlySet<number>): boolean[] {
  const ratios = heightRatios(boxes);
  return readings.map((r, i) => skip.has(i) || dropReason(normalizeReading(r.text), r.confidence, ratios[i]) !== undefined);
}

/** Each grown line's re-read, in plan order, replaces its reading and box when it should; `absorbed` holds the marks of replaced lines. */
export function applyMarks(lines: PageLines, plan: MarkPlan, reread: readonly Reading[]): { lines: PageLines; absorbed: Set<number> } {
  const { boxes, readings } = lines;
  const replaced = new Map<number, { box: Quad; reading: Reading }>();
  plan.grown.forEach(({ line, box }, k) => {
    if (shouldReplace(readings[line], reread[k], plan.floating)) replaced.set(line, { box, reading: reread[k] });
  });
  return {
    lines: {
      ...lines,
      boxes: boxes.map((box, i) => replaced.get(i)?.box ?? box),
      readings: readings.map((r, i) => replaced.get(i)?.reading ?? r),
    },
    absorbed: new Set([...plan.owner].flatMap(([mark, line]) => (replaced.has(line) ? [mark] : []))),
  };
}

/** Lines read again with their floating marks; a page whose marks are not detected apart reads exactly as before. */
export async function attachMarks(
  page: Raster,
  lines: PageLines,
  skip: ReadonlySet<number>,
  models: Models,
): Promise<{ lines: PageLines; absorbed: Set<number> }> {
  const plan = planMarks(lines.boxes, markCandidates(lines, skip), page);
  if (!plan) return { lines, absorbed: new Set() };
  const reread = await readBoxes(plan.grown.map((g) => g.box), (box) => cropLine(page, box), models);
  return applyMarks(lines, plan, reread);
}
