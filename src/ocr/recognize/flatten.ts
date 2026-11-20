/** Ported from line_engine.py (Apache-2.0). */

import { bgrToGray, grayToBGR } from "../image/color.js";
import { f32 } from "../numeric.js";
import type { Raster } from "../raster.js";

/** Per column, the median of the top and bottom margin rows; np.median's two middle values average, then truncate to uint8. */
function marginMedians(gray: Uint8Array, width: number, height: number): Uint8Array {
  const k = Math.min(Math.max(2, Math.floor(height / 6)), height);
  const values = new Uint8Array(2 * k);
  const out = new Uint8Array(width);
  for (let x = 0; x < width; x++) {
    for (let i = 0; i < k; i++) {
      values[i] = gray[i * width + x];
      values[k + i] = gray[(height - k + i) * width + x];
    }
    values.sort();
    out[x] = (values[k - 1] + values[k]) >> 1;
  }
  return out;
}

/** cv2.medianBlur over a row repeated three times: a 1-D median of `window` values with replicated edges. */
export function medianRow(row: Uint8Array, window: number): Uint8Array {
  const radius = window >> 1;
  const last = row.length - 1;
  const at = (x: number) => row[Math.min(Math.max(x, 0), last)];
  const hist = new Int32Array(256);
  for (let x = -radius; x <= radius; x++) hist[at(x)]++;
  const out = new Uint8Array(row.length);
  for (let x = 0; x <= last; x++) {
    let seen = 0;
    let v = 0;
    while (seen + hist[v] <= radius) seen += hist[v++];
    out[x] = v;
    hist[at(x - radius)]--;
    hist[at(x + radius + 1)]++;
  }
  return out;
}

/** Dark text on white from any line crop: subtract each column's own background, light or dark, and stretch the difference. */
export function flatten(gray: Uint8Array, width: number, height: number): Uint8Array {
  const window = Math.max(3, Math.min(height | 1, 255));
  const background = medianRow(marginMedians(gray, width, height), window);
  const diff = new Uint8Array(gray.length);
  const cumulative = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) {
    diff[i] = Math.abs(gray[i] - background[i % width]);
    cumulative[diff[i]]++;
  }
  for (let v = 1; v < 256; v++) cumulative[v] += cumulative[v - 1];
  const target = 0.98 * cumulative[255];
  let level = 0;
  while (cumulative[level] < target) level++;
  const scale = f32(255 / Math.max(level, 24));
  const lut = new Uint8Array(256);
  for (let d = 0; d < 256; d++) lut[d] = Math.trunc(f32(255 - Math.min(f32(d * scale), 255)));
  return diff.map((d) => lut[d]);
}

/** A crop as the recognizer was trained to see it: grey, flattened, back to three channels. */
export function prepareCrop(crop: Raster): Raster {
  return grayToBGR(flatten(bgrToGray(crop), crop.width, crop.height), crop.width, crop.height);
}
