/** Reproduces np.rot90 as line_engine.py (Apache-2.0) calls it. */

import type { Raster } from "../raster.js";

/** A quarter turn as np.rot90 counts it: 1 counter-clockwise, -1 clockwise, 2 half. */
type Turn = 1 | -1 | 2;

type SourceIndex = (x: number, y: number, width: number, height: number) => number;

/** Source pixel for output (x, y), given the source width and height. */
const SOURCE: Record<Turn, SourceIndex> = {
  1: (x, y, width) => x * width + (width - 1 - y),
  [-1]: (x, y, width, height) => (height - 1 - x) * width + y,
  2: (x, y, width, height) => (height - 1 - y) * width + (width - 1 - x),
};

export function rot90(src: Raster, turn: Turn): Raster {
  const { width, height, channels } = src;
  const [outW, outH] = turn === 2 ? [width, height] : [height, width];
  const data = new Uint8Array(src.data.length);
  const source = SOURCE[turn];
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const from = source(x, y, width, height) * channels;
      const to = (y * outW + x) * channels;
      for (let c = 0; c < channels; c++) data[to + c] = src.data[from + c];
    }
  }
  return { width: outW, height: outH, channels, data };
}
