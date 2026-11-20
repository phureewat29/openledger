/** Reproduces cv2.copyMakeBorder BORDER_CONSTANT as line_engine.py (Apache-2.0) calls it. */

import type { Raster } from "../raster.js";

/** The same pad on every side, filled with white. */
export function padWhite(src: Raster, pad: number): Raster {
  const width = src.width + 2 * pad;
  const height = src.height + 2 * pad;
  const { channels } = src;
  const data = new Uint8Array(width * height * channels).fill(255);
  const rowBytes = src.width * channels;
  for (let y = 0; y < src.height; y++) {
    data.set(src.data.subarray(y * rowBytes, (y + 1) * rowBytes), ((y + pad) * width + pad) * channels);
  }
  return { width, height, channels, data };
}
