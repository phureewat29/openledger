import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findContours } from "./contours.js";

interface Case {
  name: string;
  mask: { shape: [number, number]; data: number[] };
  contours: number[][][];
}

const CASES = (
  JSON.parse(readFileSync(new URL("../../../fixtures/ocr/primitives.json", import.meta.url), "utf8")) as {
    find_contours_list_simple: Case[];
  }
).find_contours_list_simple;

const contoursOf = (rows: string[]): number[][] =>
  findContours(Uint8Array.from(rows.join(""), Number), rows[0].length, rows.length).map((c) => Array.from(c));

describe("findContours", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("matches cv2 RETR_LIST + CHAIN_APPROX_SIMPLE on %s", (_, c) => {
    const [height, width] = c.mask.shape;
    const got = findContours(Uint8Array.from(c.mask.data), width, height).map((points) => Array.from(points));
    expect(got).toEqual(c.contours.map((points) => points.flat()));
  });

  it("lists a pixel-wide hole before its ring, tracing it over the ring's own pixels", () => {
    expect(contoursOf(["01110", "01010", "01110"])).toEqual([
      [1, 1, 2, 0, 3, 1, 2, 2],
      [1, 0, 1, 2, 3, 2, 3, 0],
    ]);
  });

  it("traces regions on a one-row image and a fully set image along the image edge", () => {
    expect(contoursOf(["1101"])).toEqual([[3, 0], [0, 0, 1, 0]]);
    expect(contoursOf(["1", "0", "1"])).toEqual([[0, 2], [0, 0]]);
    expect(contoursOf(["1111", "1111", "1111"])).toEqual([[0, 0, 0, 2, 3, 2, 3, 0]]);
  });
});
