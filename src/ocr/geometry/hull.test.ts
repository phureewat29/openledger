import { describe, expect, it } from "vitest";
import { convexHull } from "./hull.js";

/** Inputs with the indices cv2.convexHull(points, clockwise=False) returns on both CV_32S and CV_32F input. */
const CASES: [string, number[], number[]][] = [
  ["a rectangle in order", [0, 0, 4, 0, 4, 3, 0, 3], [0, 1, 2, 3]],
  ["a rectangle starting elsewhere", [4, 3, 0, 3, 0, 0, 4, 0], [0, 1, 2, 3]],
  ["collinear and interior points", [0, 0, 2, 0, 4, 0, 4, 3, 2, 3, 0, 3, 2, 1], [0, 2, 3, 5]],
  ["one repeated point", [5, 5, 5, 5, 5, 5], [0]],
  ["two points", [1, 1, 7, 4], [1, 0]],
  ["a line of points", [0, 0, 1, 1, 2, 2, 3, 3], [3, 0]],
  ["a diamond listed the other way round", [3, 1, 1, 3, 3, 5, 5, 3, 3, 3], [3, 2, 1, 0]],
];

describe("convexHull", () => {
  it.each(CASES)("orders %s as cv2 does", (_, points, indices) => {
    expect(Array.from(convexHull(Int32Array.from(points), false))).toEqual(indices);
    expect(Array.from(convexHull(Float32Array.from(points), true))).toEqual(indices);
  });

  it("returns nothing for no points", () => {
    expect(convexHull(new Int32Array(0), false)).toHaveLength(0);
  });
});
