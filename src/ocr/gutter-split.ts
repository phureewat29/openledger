/** Ported from line_engine.py (Apache-2.0). */

import type { Quad } from "./geometry/quad.js";
import { bgrToGray } from "./image/color.js";
import { f32 } from "./numeric.js";
import type { Raster } from "./raster.js";
import { flatten } from "./recognize/flatten.js";

type Segment = [start: number, end: number];

function inkColumns(crop: Raster): boolean[] {
  const flat = flatten(bgrToGray(crop), crop.width, crop.height);
  return Array.from({ length: crop.width }, (_, x) => {
    for (let y = 0; y < crop.height; y++) if (flat[y * crop.width + x] < 128) return true;
    return false;
  });
}

/** Inked runs, cut wherever a blank stretch reaches `gap` pixels. */
function segments(ink: readonly boolean[], gap: number): Segment[] {
  const out: Segment[] = [];
  let start: number | undefined;
  let blank = 0;
  ink.forEach((on, x) => {
    if (!on) {
      if (start !== undefined) blank += 1;
      return;
    }
    if (start === undefined) start = x;
    else if (blank >= gap) {
      out.push([start, x - blank]);
      start = x;
    }
    blank = 0;
  });
  if (start !== undefined) out.push([start, ink.length - blank]);
  return out;
}

/** Corner + t * edge in float32, t first cast to float32 as numpy casts a Python scalar. */
const along = (box: Quad, corner: number, edge: readonly [number, number], t: number): [number, number] => [
  f32(box[corner * 2] + f32(f32(t) * edge[0])),
  f32(box[corner * 2 + 1] + f32(f32(t) * edge[1])),
];

/**
 * A line box, given its crop, cut at blank stretches at least `ratio` line heights wide, with such a stretch
 * trimmed off either end: the detector can run a box across an empty gutter. Returns `[box]` itself when nothing changes.
 */
export function splitLine(box: Quad, crop: Raster, ratio: number): readonly Quad[] {
  if (!ratio) return [box];
  const { width: w, height: h } = crop;
  if (w < 4 * h || h < 4) return [box];
  const gap = ratio * h;
  const runs = segments(inkColumns(crop), gap);
  if (runs.length === 0) return [box];
  if (runs.length === 1 && runs[0][0] < gap && w - runs[0][1] < gap) return [box];
  const top = [f32(box[2] - box[0]), f32(box[3] - box[1])] as const;
  const bottom = [f32(box[4] - box[6]), f32(box[5] - box[7])] as const;
  const pad = 0.15 * h;
  return runs.map(([x0, x1]) => {
    const t0 = Math.max(0, (x0 - pad) / w);
    const t1 = Math.min(1, (x1 + pad) / w);
    return Float32Array.of(...along(box, 0, top, t0), ...along(box, 0, top, t1), ...along(box, 3, bottom, t1), ...along(box, 3, bottom, t0));
  });
}
