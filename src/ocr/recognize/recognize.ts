/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

import type { Models } from "../models.js";
import type { Raster } from "../raster.js";
import { aspectRatio, batchTensor, planBatches, toRecognizerHeight } from "./batch.js";
import { decodeCTC, type Reading } from "./ctc.js";

/** Text and confidence per crop, in input order. */
export async function recognize(crops: readonly Raster[], models: Models): Promise<Reading[]> {
  const prepared = crops.map(toRecognizerHeight);
  const readings: Reading[] = Array.from({ length: crops.length }, () => ({ text: "", confidence: 0 }));
  for (const plan of planBatches(prepared.map(aspectRatio))) {
    const probs = await models.recognize(batchTensor(prepared, plan));
    const [, steps, classes] = probs.dims;
    plan.indices.forEach((index, n) => {
      readings[index] = decodeCTC(probs.data, n * steps * classes, steps, classes, models.charset);
    });
  }
  return readings;
}
