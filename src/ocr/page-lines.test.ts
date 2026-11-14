import { describe, expect, it } from "vitest";
import type { Models, Tensor } from "./models.js";
import { readLines } from "./page-lines.js";
import type { Raster } from "./raster.js";

/** A white page with two ink blocks on one line, far enough apart for the gutter split. */
function twoBlockPage(): Raster {
  const width = 400;
  const height = 60;
  const data = new Uint8Array(width * height * 3).fill(255);
  for (let y = 20; y < 40; y++) {
    for (const [x0, x1] of [[20, 120], [280, 380]]) data.fill(0, (y * width + x0) * 3, (y * width + x1) * 3);
  }
  return { width, height, channels: 3, data };
}

const BOX = Float32Array.of(10, 15, 390, 15, 390, 45, 10, 45);
const CHARSET = ["", "a", "b", " "];

/** Reads each batch line by its inked width: narrow lines (the pieces) as `piece`, wide ones (the whole line) as `whole`. */
function stubModels(piece: { text: string; confidence: number }, whole: { text: string; confidence: number }): Models {
  const recognize = async (input: Tensor): Promise<Tensor> => {
    const [count, , height, width] = input.dims;
    const steps = 8;
    const data = new Float32Array(count * steps * CHARSET.length);
    for (let n = 0; n < count; n++) {
      let used = 0;
      for (let x = 0; x < width; x++) {
        for (let y = 0; y < height; y++) if (input.data[n * 3 * height * width + y * width + x] !== 0) used = x + 1;
      }
      const reading = used < 200 ? piece : whole;
      Array.from(reading.text).forEach((ch, t) => {
        data[(n * steps + 2 * t) * CHARSET.length + CHARSET.indexOf(ch)] = reading.confidence;
      });
    }
    return { data, dims: [count, steps, CHARSET.length] };
  };
  return { detect: () => Promise.reject(new Error("unused")), recognize, charset: CHARSET };
}

describe("readLines gutter split", () => {
  it("keeps confident pieces that read most of the line", async () => {
    const lines = await readLines(twoBlockPage(), [BOX], stubModels({ text: "ab", confidence: 0.95 }, { text: "abab", confidence: 0.9 }));
    expect(lines.boxes).toHaveLength(2);
    expect(lines.readings.map((r) => r.text)).toEqual(["ab", "ab"]);
  });

  it("reverts to the whole line when a piece reads under the drop threshold or the pieces lose characters", async () => {
    const page = twoBlockPage();
    for (const piece of [{ text: "ab", confidence: 0.5 }, { text: "a", confidence: 0.95 }]) {
      const lines = await readLines(page, [BOX], stubModels(piece, { text: "abab", confidence: 0.9 }));
      expect(lines.boxes).toEqual([BOX]);
      expect(lines.readings.map((r) => r.text)).toEqual(["abab"]);
    }
  });
});
