/** Ported from line_engine.py (Apache-2.0). */

import { chunk } from "es-toolkit";
import { resizeLinear } from "../image/resize.js";
import type { Tensor } from "../models.js";
import { f32, sortedIndices } from "../numeric.js";
import type { Raster } from "../raster.js";
import { REC } from "../settings.js";
import { prepareCrop } from "./flatten.js";

/** A crop's width once scaled to the recognizer's height. */
export const recognizerWidth = (width: number, height: number): number =>
  Math.max(1, Math.ceil((REC.height * width) / Math.max(height, 1)));

/** Scaled to the recognizer's height first: flattening is cheaper there. */
export const toRecognizerHeight = (crop: Raster): Raster =>
  prepareCrop(resizeLinear(crop, recognizerWidth(crop.width, crop.height), REC.height));

interface BatchPlan {
  indices: number[];
  width: number;
}

export const aspectRatio = (crop: Raster): number => crop.width / Math.max(crop.height, 1);

/** One line's width inside a batch `batchWidth` wide. */
export const lineWidth = (ratio: number, batchWidth: number): number =>
  Math.min(batchWidth, Math.max(1, Math.ceil(REC.height * ratio)));

/** Batches by aspect ratio, as the vendor batches: zero padding changes what the network reads, so membership must match. */
export function planBatches(ratios: readonly number[]): BatchPlan[] {
  return chunk(sortedIndices(ratios.length, (i) => ratios[i]), REC.batch).map((indices) => ({
    indices,
    width: Math.min(REC.maxWidth, Math.max(16, Math.ceil(REC.height * Math.max(...indices.map((i) => ratios[i]))))),
  }));
}

/** uint8 to [-1, 1] in float32 steps, as numpy computes (x / 255 - 0.5) / 0.5. */
export const LINE_NORMALIZE = Float32Array.from({ length: 256 }, (_, v) => f32(f32(f32(v / 255) - 0.5) / 0.5));

/** N x 3 x 48 x W; columns past each line's width stay 0, mid-grey after normalising. */
export function batchTensor(crops: readonly Raster[], plan: BatchPlan): Tensor {
  const { height } = REC;
  const { width, indices } = plan;
  const plane = height * width;
  const data = new Float32Array(indices.length * 3 * plane);
  indices.forEach((index, n) => {
    const crop = crops[index];
    const w = lineWidth(aspectRatio(crop), width);
    const line = w === crop.width ? crop : resizeLinear(crop, w, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < w; x++) {
        const from = (y * w + x) * 3;
        const to = n * 3 * plane + y * width + x;
        for (let c = 0; c < 3; c++) data[to + c * plane] = LINE_NORMALIZE[line.data[from + c]];
      }
    }
  });
  return { data, dims: [indices.length, 3, height, width] };
}
