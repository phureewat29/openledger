/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

import { median, sum } from "es-toolkit";
import { cropLine } from "./crop.js";
import { orientation, quadHeight, quadWidth, type Quad } from "./geometry/quad.js";
import { rot90 } from "./image/rotate.js";
import { rotationMatrix, warpAffineCubic } from "./image/warp.js";
import type { Models } from "./models.js";
import { codePointLength, mean, roundHalfEven } from "./numeric.js";
import type { PageLines } from "./page-lines.js";
import type { Raster } from "./raster.js";
import { recognize } from "./recognize/recognize.js";
import { ORI } from "./settings.js";

/**
 * The np.rot90 turn that makes a sideways page upright, 0 if it is not sideways: most lines run vertically,
 * and the direction is whichever way the longest vertical lines read with more confidence.
 */
export async function sidewaysTurn(page: Raster, boxes: readonly Quad[], models: Models): Promise<0 | 1 | -1> {
  const votes = boxes.map((box) => orientation(box, 2));
  const vertical = boxes.filter((_, i) => votes[i] === 1);
  if (vertical.length < 3 || vertical.length <= votes.filter((v) => v === -1).length) return 0;
  const crops = vertical
    .toSorted((a, b) => quadHeight(b) - quadHeight(a))
    .slice(0, ORI.sample)
    .map((box) => cropLine(page, box));
  const read = await recognize([...crops.map((c) => rot90(c, 1)), ...crops.map((c) => rot90(c, -1))], models);
  const confidence = (from: number) => sum(read.slice(from, from + crops.length).map((r) => r.confidence));
  return confidence(0) > confidence(crops.length) ? 1 : -1;
}

/** Only for a page that reads badly: do its longest lines read better turned 180 degrees? */
export async function upsideDown(page: Raster, lines: PageLines, models: Models): Promise<boolean> {
  const { boxes, readings } = lines;
  const confidences = readings.filter((r) => codePointLength(r.text) >= 2).map((r) => r.confidence);
  if (confidences.length < 3 || median(confidences) >= ORI.flipBelow) return false;
  const longest = readings
    .map((_, i) => i)
    .filter((i) => orientation(boxes[i], 2) === -1)
    .toSorted((a, b) => quadWidth(boxes[b]) - quadWidth(boxes[a]))
    .slice(0, ORI.sample);
  if (longest.length < 3) return false;
  const upright = mean(longest.map((i) => readings[i].confidence));
  const flipped = await recognize(
    longest.map((i) => rot90(cropLine(page, boxes[i]), 2)),
    models,
  );
  return mean(flipped.map((r) => r.confidence)) > upright + ORI.flipMargin;
}

/** Per channel, np.median of the four border rows and columns, truncated as int() does. */
function edgeFill(page: Raster): number[] {
  const { width, height, channels, data } = page;
  const hist = Array.from({ length: channels }, () => new Int32Array(256));
  const add = (x: number, y: number) => {
    for (let c = 0; c < channels; c++) hist[c][data[(y * width + x) * channels + c]]++;
  };
  for (let x = 0; x < width; x++) {
    add(x, 0);
    add(x, height - 1);
  }
  for (let y = 0; y < height; y++) {
    add(0, y);
    add(width - 1, y);
  }
  const n = 2 * (width + height);
  const nth = (counts: Int32Array, k: number) => {
    let seen = 0;
    let v = 0;
    while (seen + counts[v] <= k) seen += counts[v++];
    return v;
  };
  return hist.map((counts) => Math.trunc((nth(counts, n / 2 - 1) + nth(counts, n / 2)) / 2));
}

/** Rotated so lines leaning by `angle` degrees run level; the canvas grows to fit and fills with the page's own border colour. */
export function deskew(page: Raster, angle: number): Raster {
  const { width, height } = page;
  const m = rotationMatrix(width / 2, height / 2, angle);
  const cos = Math.abs(m[0]);
  const sin = Math.abs(m[1]);
  const newWidth = roundHalfEven(height * sin + width * cos);
  const newHeight = roundHalfEven(height * cos + width * sin);
  m[2] += newWidth / 2 - width / 2;
  m[5] += newHeight / 2 - height / 2;
  return warpAffineCubic(page, m, newWidth, newHeight, edgeFill(page));
}
