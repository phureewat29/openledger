/** Ported from line_engine.py (Apache-2.0). */

import { clamp } from "es-toolkit";
import { boxScore } from "./geometry/box-score.js";
import { boxPoints, minAreaRect } from "./geometry/min-area-rect.js";
import { findContours } from "./geometry/contours.js";
import { orderPoints, type Quad, type RotatedRect } from "./geometry/quad.js";
import { unclip } from "./geometry/unclip.js";
import { padWhite } from "./image/border.js";
import { resizeLinear } from "./image/resize.js";
import type { Models, Tensor } from "./models.js";
import { f32, roundHalfEven } from "./numeric.js";
import type { Raster } from "./raster.js";
import { DET, DET_MEAN, DET_STD } from "./settings.js";

/** Where the detector's map sits on the page: the white pad added around it and the page size. */
interface DetectionFrame {
  pad: number;
  paddedWidth: number;
  paddedHeight: number;
  pageWidth: number;
  pageHeight: number;
}

/** Per channel, uint8 to the detector's normalised float32, step by step as numpy does it. */
const DET_NORMALIZE = DET_MEAN.map((mean, c) =>
  Float32Array.from({ length: 256 }, (_, v) => f32(f32(f32(v / 255) - f32(mean)) / f32(DET_STD[c]))),
);

const multipleOf32 = (side: number, scale: number): number => Math.max(32, roundHalfEven((side * scale) / 32) * 32);

/** White pad and detector input size for a page: the long side to the working size, both sides multiples of 32. */
export function detectorGeometry(pageWidth: number, pageHeight: number): DetectionFrame & { width: number; height: number } {
  const pad = Math.max(8, Math.trunc(0.05 * Math.min(pageHeight, pageWidth)));
  const paddedWidth = pageWidth + 2 * pad;
  const paddedHeight = pageHeight + 2 * pad;
  const scale = Math.min(DET.limit / Math.max(paddedHeight, paddedWidth), 4);
  return {
    pad,
    paddedWidth,
    paddedHeight,
    pageWidth,
    pageHeight,
    width: multipleOf32(paddedWidth, scale),
    height: multipleOf32(paddedHeight, scale),
  };
}

/**
 * The page padded white so text touching an edge still closes a region, then its long side scaled to the
 * detector's working size in both directions, as a 1x3xHxW tensor.
 */
function detectorInput(page: Raster): { input: Tensor; frame: DetectionFrame } {
  const { width, height, ...frame } = detectorGeometry(page.width, page.height);
  const resized = resizeLinear(padWhite(page, frame.pad), width, height);
  const plane = resized.width * resized.height;
  const data = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) data[c * plane + i] = DET_NORMALIZE[c][resized.data[i * 3 + c]];
  }
  return { input: { data, dims: [1, 3, height, width] }, frame };
}

const shortSide = (rect: RotatedRect): number => Math.min(rect.width, rect.height);

/** Map-space box to page space, in float32 as numpy computes it; sx and sy are already float32. */
export function toPage(box: Quad, frame: DetectionFrame, sx: number, sy: number): Quad {
  const out = new Float32Array(8);
  for (let i = 0; i < 8; i += 2) {
    out[i] = clamp(f32(f32(box[i] * sx) - frame.pad), 0, frame.pageWidth - 1);
    out[i + 1] = clamp(f32(f32(box[i + 1] * sy) - frame.pad), 0, frame.pageHeight - 1);
  }
  return out;
}

const spread = (box: Quad, axis: 0 | 1): number => {
  const values = [box[axis], box[axis + 2], box[axis + 4], box[axis + 6]];
  return f32(Math.max(...values) - Math.min(...values));
};

/** DB postprocessing: threshold the probability map, box each region, keep confident ones, grow them back to full lines. */
function boxesFromMap(prob: Tensor, frame: DetectionFrame): Quad[] {
  const [height, width] = prob.dims.slice(-2);
  const threshold = f32(DET.thresh);
  const bitmap = new Uint8Array(prob.data.length);
  for (let i = 0; i < bitmap.length; i++) bitmap[i] = prob.data[i] > threshold ? 1 : 0;
  const sx = f32(frame.paddedWidth / width);
  const sy = f32(frame.paddedHeight / height);
  const boxes: Quad[] = [];
  for (const contour of findContours(bitmap, width, height).slice(0, DET.maxCandidates)) {
    const rect = minAreaRect(contour);
    if (shortSide(rect) < DET.minSize) continue;
    const box = orderPoints(boxPoints(rect));
    if (boxScore(prob.data, width, height, box) < DET.boxThresh) continue;
    const grown = unclip(box, DET.unclip);
    if (!grown) continue;
    const grownRect = minAreaRect(grown);
    if (shortSide(grownRect) < DET.minSize + 2) continue;
    const onPage = toPage(orderPoints(boxPoints(grownRect)), frame, sx, sy);
    if (spread(onPage, 0) >= 2 && spread(onPage, 1) >= 2) boxes.push(onPage);
  }
  return boxes;
}

/** Line boxes on the page, in page coordinates. */
export async function detectBoxes(page: Raster, models: Models): Promise<Quad[]> {
  const { input, frame } = detectorInput(page);
  return boxesFromMap(await models.detect(input), frame);
}
