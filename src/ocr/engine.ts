/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

import { detectBoxes } from "./detect.js";
import type { Quad } from "./geometry/quad.js";
import { toBGR } from "./image/color.js";
import { rot90 } from "./image/rotate.js";
import { dropReason, fragments, type DropReason } from "./line-filter.js";
import type { Models } from "./models.js";
import { deskew, sidewaysTurn, upsideDown } from "./orientation.js";
import { readLines, type PageLines } from "./page-lines.js";
import type { Raster } from "./raster.js";
import { ORI } from "./settings.js";
import { pageSkew } from "./skew.js";
import { canonical, fixScripts } from "./thai-norm.js";

type Rotation = 0 | 90 | 180 | 270;

export interface Line {
  text: string;
  confidence: number;
}

interface DroppedLine extends Line {
  reason: DropReason;
}

interface PageText {
  text: string;
  lines: Line[];
  dropped: DroppedLine[];
  /** Clockwise degrees the page was turned to read it. */
  rotation: Rotation;
}

interface Upright {
  page: Raster;
  boxes: Quad[];
  rotation: Rotation;
}

const ROTATION_OF_TURN: Record<0 | 1 | -1, Rotation> = { 0: 0, 1: 270, [-1]: 90 };

/** A line needs two pixel rows: a one-row box is a degenerate quad the perspective solve cannot invert. */
const MIN_LINE_HEIGHT = 2;

/** Nothing found in a small, line-shaped image: it is one line or field crop, so read it whole. */
function withSingleLineFallback(page: Raster, boxes: Quad[]): Quad[] {
  const { width: w, height: h } = page;
  if (boxes.length > 0 || h < MIN_LINE_HEIGHT || h > 200 || w < 1.5 * h) return boxes;
  return [Float32Array.of(0, 0, w - 1, 0, w - 1, h - 1, 0, h - 1)];
}

/** Turned upright from the text itself, then straightened when its lines lean past the deskew threshold. */
async function upright(start: Raster, models: Models): Promise<Upright> {
  const found = withSingleLineFallback(start, await detectBoxes(start, models));
  const turn = await sidewaysTurn(start, found, models);
  const page = turn ? rot90(start, turn) : start;
  const boxes = turn ? await detectBoxes(page, models) : found;
  const skew = pageSkew(boxes);
  const rotation = ROTATION_OF_TURN[turn];
  if (Math.abs(skew) < ORI.deskewAbove) return { page, boxes, rotation };
  const level = deskew(page, skew);
  return { page: level, boxes: await detectBoxes(level, models), rotation };
}

/** Canonical text per kept line, rows joined by spaces and newlines; fragments of marks vanish, junk is dropped with a reason. */
function filterLines({ boxes, readings, rows }: PageLines): Pick<PageText, "text" | "lines" | "dropped"> {
  const marks = fragments(
    boxes,
    readings.map((r) => r.text),
  );
  const lines: Line[] = [];
  const dropped: DroppedLine[] = [];
  const rowTexts = rows.flatMap((row) => {
    const kept = row.flatMap((i) => {
      if (marks.has(i)) return [];
      const line = { text: fixScripts(canonical(readings[i].text)), confidence: readings[i].confidence };
      const reason = dropReason(line.text, line.confidence);
      if (reason) {
        dropped.push({ ...line, reason });
        return [];
      }
      lines.push(line);
      return [line.text];
    });
    return kept.length > 0 ? [kept.join(" ")] : [];
  });
  return { text: rowTexts.join("\n"), lines, dropped };
}

/** The page's text, lines in reading order, plus what the filter dropped and how the page was turned. */
export async function readPageText(input: Raster, models: Models): Promise<PageText> {
  const { page, boxes, rotation } = await upright(toBGR(input), models);
  const first = await readLines(page, boxes, models);
  const flip = rotation === 0 && (await upsideDown(page, first, models));
  const flipped = flip ? rot90(page, 2) : page;
  const lines = flip ? await readLines(flipped, await detectBoxes(flipped, models), models) : first;
  return { ...filterLines(lines), rotation: flip ? 180 : rotation };
}
