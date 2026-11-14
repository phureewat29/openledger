/** Reproduces cv2.cvtColor BGR2GRAY and GRAY2BGR as line_engine.py (Apache-2.0) calls them; see THIRD_PARTY_NOTICES.md. */

import type { Raster } from "../raster.js";

/** 15-bit BT.601 weights with rounding: carotene's arm64 kernel, which cv2 takes for 8-bit BGR. */
export function bgrToGray(src: Raster): Uint8Array {
  const n = src.width * src.height;
  const gray = new Uint8Array(n);
  const data = src.data;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    gray[i] = (data[j + 2] * 9798 + data[j + 1] * 19235 + data[j] * 3735 + 16384) >>> 15;
  }
  return gray;
}

export function grayToBGR(gray: Uint8Array, width: number, height: number): Raster {
  const data = new Uint8Array(gray.length * 3);
  for (let i = 0, j = 0; i < gray.length; i++, j += 3) {
    data[j] = data[j + 1] = data[j + 2] = gray[i];
  }
  return { width, height, channels: 3, data };
}

/** Pages arrive as BGR or grey; every stage works on BGR. */
export const toBGR = (page: Raster): Raster => (page.channels === 3 ? page : grayToBGR(page.data, page.width, page.height));
