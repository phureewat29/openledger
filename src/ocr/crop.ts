/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

import { span, type Quad } from "./geometry/quad.js";
import { perspectiveTransform, warpPerspectiveCubic } from "./image/warp.js";
import type { Raster } from "./raster.js";

/** One quad rectified into an upright line image, its size from the longer of each pair of opposite edges. */
export function cropLine(page: Raster, box: Quad): Raster {
  const width = Math.max(Math.trunc(Math.max(span(box, 0, 1), span(box, 2, 3))), 1);
  const height = Math.max(Math.trunc(Math.max(span(box, 0, 3), span(box, 1, 2))), 1);
  const target = Float32Array.of(0, 0, width, 0, width, height, 0, height);
  return warpPerspectiveCubic(page, perspectiveTransform(box, target), width, height);
}
