/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

import { mean } from "../numeric.js";

export interface Reading {
  text: string;
  confidence: number;
}

/** Greedy CTC over one line's T x C probabilities: first-max argmax, runs collapsed, blanks dropped; confidence is the mean of each emitted run's first frame. */
export function decodeCTC(
  probs: Float32Array,
  offset: number,
  steps: number,
  classes: number,
  charset: readonly string[],
): Reading {
  const chars: string[] = [];
  const confidences: number[] = [];
  let previous = -1;
  for (let t = 0; t < steps; t++) {
    const row = offset + t * classes;
    let best = 0;
    for (let c = 1; c < classes; c++) if (probs[row + c] > probs[row + best]) best = c;
    if (best !== previous && best !== 0) {
      chars.push(charset[best] ?? "");
      confidences.push(probs[row + best]);
    }
    previous = best;
  }
  return { text: chars.join(""), confidence: confidences.length ? mean(confidences) : 0 };
}
