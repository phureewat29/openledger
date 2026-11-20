/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

import { memoize, range, sum } from "es-toolkit";
import { cropLine } from "./crop.js";
import type { Quad } from "./geometry/quad.js";
import { splitLine } from "./gutter-split.js";
import { rot90 } from "./image/rotate.js";
import { nonSpaceLength } from "./line-filter.js";
import type { Models } from "./models.js";
import type { Raster } from "./raster.js";
import { readingOrder } from "./reading-order.js";
import type { Reading } from "./recognize/ctc.js";
import { recognize } from "./recognize/recognize.js";
import { DET, REC, REC2 } from "./settings.js";
import { pageSkew } from "./skew.js";
import { mixedLatin } from "./text-classes.js";

/** A page's line boxes, their raw readings by index, and rows of indices in reading order. */
export interface PageLines {
  boxes: Quad[];
  readings: Reading[];
  rows: number[][];
}

/**
 * Readings with Latin letters inside Thai words, from a loopless face, read again by the recognizer trained on such
 * fonts; its reading replaces one with more of them. `upright` lists the readings not taken from a turned crop.
 */
async function rereadLoopless(readings: Reading[], crops: readonly Raster[], upright: readonly number[], models: Models): Promise<Reading[]> {
  const suspect = upright.filter((n) => mixedLatin(readings[n].text) >= REC2.minMixed);
  const again = await recognize(suspect.map((n) => crops[n]), models, models.recognizeLoopless);
  const out = [...readings];
  suspect.forEach((n, k) => {
    if (mixedLatin(again[k].text) < mixedLatin(out[n].text)) out[n] = again[k];
  });
  return out;
}

/**
 * Every box read; a box taller than wide is a vertical run of text or one tall character, so it is also read
 * turned both ways and the most confident reading kept.
 */
export async function readBoxes(boxes: readonly Quad[], crop: (box: Quad) => Raster, models: Models): Promise<Reading[]> {
  const crops = boxes.map(crop);
  const tall = crops.flatMap((crop, n) => (crop.height >= 1.5 * crop.width ? [n] : []));
  const turned = ([1, -1] as const).flatMap((turn) => tall.map((n) => rot90(crops[n], turn)));
  const all = await recognize([...crops, ...turned], models);
  const out = all.slice(0, crops.length);
  const readTurned = new Set<number>();
  tall.forEach((n, j) => {
    for (const alt of [all[crops.length + j], all[crops.length + tall.length + j]]) {
      if (alt.confidence <= out[n].confidence) continue;
      out[n] = alt;
      readTurned.add(n);
    }
  });
  const upright = range(out.length).filter((n) => !readTurned.has(n));
  return rereadLoopless(out, crops, upright, models);
}

/** Split pieces replace their line only if each reads well enough to survive the filter and together they keep 90 % of its characters. */
const keepPieces = (pieces: readonly Reading[], whole: Reading): boolean =>
  Math.min(...pieces.map((r) => r.confidence)) >= REC.dropBelow &&
  sum(pieces.map((r) => nonSpaceLength(r.text))) >= 0.9 * nonSpaceLength(whole.text);

/** Recognition, then reading order; the column test looks at the text. */
export async function readLines(page: Raster, boxes: readonly Quad[], models: Models): Promise<PageLines> {
  const crop = memoize((box: Quad) => cropLine(page, box));
  const groups = boxes.map((box) => splitLine(box, crop(box), DET.splitGap));
  const changed = groups.map((group, i) => group.length > 1 || group[0] !== boxes[i]);
  const pieces = groups.flat();
  const all = await readBoxes([...pieces, ...boxes.filter((_, i) => changed[i])], crop, models);
  const finalBoxes: Quad[] = [];
  const readings: Reading[] = [];
  let next = 0;
  let nextWhole = pieces.length;
  groups.forEach((group, i) => {
    const read = all.slice(next, next + group.length);
    next += group.length;
    if (changed[i]) {
      const whole = all[nextWhole++];
      if (!keepPieces(read, whole)) {
        finalBoxes.push(boxes[i]);
        readings.push(whole);
        return;
      }
    }
    finalBoxes.push(...group);
    readings.push(...read);
  });
  const rows = readingOrder(
    finalBoxes,
    readings.map((r) => r.text),
    pageSkew(finalBoxes),
  );
  return { boxes: finalBoxes, readings, rows };
}
