import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boxScore } from "./box-score.js";

interface Golden {
  prob: { shape: [number, number]; data: number[] };
  cases: { box: number[][]; score: number }[];
}

const GOLDEN = (
  JSON.parse(readFileSync(new URL("../../../fixtures/ocr/primitives.json", import.meta.url), "utf8")) as {
    box_score: Golden;
  }
).box_score;

const [HEIGHT, WIDTH] = GOLDEN.prob.shape;
const PROB = Float32Array.from(GOLDEN.prob.data);

describe("boxScore", () => {
  it.each(GOLDEN.cases.map((c, i) => [i, c] as const))("matches cv2.fillPoly + cv2.mean exactly on case %i", (_, c) => {
    expect(boxScore(PROB, WIDTH, HEIGHT, Float32Array.from(c.box.flat()))).toBe(c.score);
  });

  it("scores a point-sized box by its one pixel", () => {
    const box = Float32Array.of(2.5, 1.5, 2.5, 1.5, 2.5, 1.5, 2.5, 1.5);
    expect(boxScore(PROB, WIDTH, HEIGHT, box)).toBe(PROB[WIDTH + 2]);
  });
});
