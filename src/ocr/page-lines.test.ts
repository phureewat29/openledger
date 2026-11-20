import { describe, expect, it } from "vitest";
import type { Models, Tensor } from "./models.js";
import { readBoxes, readLines } from "./page-lines.js";
import type { Raster } from "./raster.js";
import type { Reading } from "./recognize/ctc.js";

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
const CHARSET = ["", "a", "b", " ", "ก", "บ", "U", "S"];
const STEPS = 8;
const unused = () => Promise.reject(new Error("unused"));

/** Class probabilities that decode to each line's reading, every character on its own frame between blanks. */
function probabilities(reads: readonly Reading[]): Tensor {
  const data = new Float32Array(reads.length * STEPS * CHARSET.length);
  reads.forEach((read, n) => {
    Array.from(read.text).forEach((ch, t) => {
      data[(n * STEPS + 2 * t) * CHARSET.length + CHARSET.indexOf(ch)] = read.confidence;
    });
  });
  return { data, dims: [reads.length, STEPS, CHARSET.length] };
}

/** Each batch line's width before the zero padding that fills the batch. */
function lineWidths(input: Tensor): number[] {
  const [count, , height, width] = input.dims;
  return Array.from({ length: count }, (_, n) => {
    let used = 0;
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) if (input.data[n * 3 * height * width + y * width + x] !== 0) used = x + 1;
    }
    return used;
  });
}

/** Reads narrow lines (the pieces) as `piece`, wide ones (the whole line) as `whole`. */
function splitModels(piece: Reading, whole: Reading): Models {
  const recognize = async (input: Tensor) => probabilities(lineWidths(input).map((used) => (used < 200 ? piece : whole)));
  return { detect: unused, recognize, recognizeLoopless: unused, charset: CHARSET };
}

/** Every line reads `first`, and `loopless` from the second recognizer, which counts its calls; lines under 100 wide read at 0.5, or the wide ones when `narrowWins`. */
function rereadModels(first: string, loopless: string, calls: number[], narrowWins = false): Models {
  const reading = (text: string) => async (input: Tensor) =>
    probabilities(lineWidths(input).map((used) => ({ text, confidence: used < 100 !== narrowWins ? 0.5 : 0.95 })));
  const second = reading(loopless);
  const recognizeLoopless = (input: Tensor) => {
    calls.push(input.dims[0]);
    return second(input);
  };
  return { detect: unused, recognize: reading(first), recognizeLoopless, charset: CHARSET };
}

describe("readLines gutter split", () => {
  it("keeps confident pieces that read most of the line", async () => {
    const lines = await readLines(twoBlockPage(), [BOX], splitModels({ text: "ab", confidence: 0.95 }, { text: "abab", confidence: 0.9 }));
    expect(lines.boxes).toHaveLength(2);
    expect(lines.readings.map((r) => r.text)).toEqual(["ab", "ab"]);
  });

  it("reverts to the whole line when a piece reads under the drop threshold or the pieces lose characters", async () => {
    const page = twoBlockPage();
    for (const piece of [{ text: "ab", confidence: 0.5 }, { text: "a", confidence: 0.95 }]) {
      const lines = await readLines(page, [BOX], splitModels(piece, { text: "abab", confidence: 0.9 }));
      expect(lines.boxes).toEqual([BOX]);
      expect(lines.readings.map((r) => r.text)).toEqual(["abab"]);
    }
  });
});

describe("readBoxes loopless re-read", () => {
  const raster = (width: number, height: number): Raster => ({ width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(255) });

  it("takes the second recognizer's reading only when it has fewer Latin letters inside Thai words, never for a turned crop", async () => {
    const read = async (first: string, loopless: string, crop = raster(380, 30), narrowWins = false) => {
      const calls: number[] = [];
      const [reading] = await readBoxes([BOX], () => crop, rereadModels(first, loopless, calls, narrowWins));
      return [reading.text, calls.length];
    };
    expect(await read("Uก", "บก")).toEqual(["บก", 1]);
    expect(await read("Uก", "UUก")).toEqual(["Uก", 1]);
    expect(await read("Uก", "Sก")).toEqual(["Uก", 1]);
    expect(await read("U ก", "บก")).toEqual(["U ก", 0]);
    expect(await read("Uก", "บก", raster(30, 380))).toEqual(["Uก", 0]);
    expect(await read("Uก", "บก", raster(30, 380), true)).toEqual(["บก", 1]);
  });
});
