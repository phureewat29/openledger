/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

import { atLeastOne, quadHeight, type Quad } from "./geometry/quad.js";
import { f32, median } from "./numeric.js";

/** Median text-line angle in degrees, from boxes at least three times wider than tall. */
export function pageSkew(boxes: readonly Quad[]): number {
  const angles = boxes.flatMap((box) => {
    const dx = f32(box[2] - box[0]);
    const dy = f32(box[3] - box[1]);
    const long = f32(Math.hypot(dx, dy)) >= f32(3 * atLeastOne(quadHeight(box)));
    return long ? [Math.atan2(dy, dx) * (180 / Math.PI)] : [];
  });
  return angles.length > 0 ? median(angles) : 0;
}
