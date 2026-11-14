import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boxPoints, minAreaRect } from "./min-area-rect.js";
import { orderPoints, type RotatedRect } from "./quad.js";

interface Case {
  name: string;
  contour: number[][];
  dtype: "int32" | "float32";
  rect: { center: [number, number]; size: [number, number]; angle: number };
  box_points: number[][];
  mini_box: number[][];
  side: number;
}

const CASES = (
  JSON.parse(readFileSync(new URL("../../../fixtures/ocr/primitives.json", import.meta.url), "utf8")) as {
    min_area_rect_box_points_order_points: Case[];
  }
).min_area_rect_box_points_order_points;

const points = (c: Case) => (c.dtype === "int32" ? Int32Array : Float32Array).from(c.contour.flat());
const tuple = (r: RotatedRect) => [r.cx, r.cy, r.width, r.height, r.angle];

describe("minAreaRect and boxPoints", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("match cv2 5.0 bit for bit on %s", (_, c) => {
    const rect = minAreaRect(points(c));
    expect(tuple(rect)).toEqual([...c.rect.center, ...c.rect.size, c.rect.angle]);
    expect(Math.min(rect.width, rect.height)).toBe(c.side);
    expect(Array.from(boxPoints(rect))).toEqual(c.box_points.flat());
    expect(Array.from(orderPoints(boxPoints(rect)))).toEqual(c.mini_box.flat());
  });

  it("follows cv2 5.0's [-90, 0) angle range for two-point sets of every slope", () => {
    const rectOf = (...xy: number[]) => tuple(minAreaRect(Int32Array.from(xy)));
    expect(rectOf(1, 1, 7, 4)).toEqual([4, 2.5, 0, Math.fround(6.7082037925720215), Math.fround(-63.4349479675293)]);
    expect(rectOf(1, 4, 7, 1)).toEqual([4, 2.5, Math.fround(6.7082037925720215), 0, Math.fround(-26.565052032470703)]);
    expect(rectOf(3, 1, 3, 6)).toEqual([3, 3.5, 5, 0, -90]);
    expect(rectOf(1, 3, 6, 3)).toEqual([3.5, 3, 0, 5, -90]);
    expect(rectOf(2, 7)).toEqual([2, 7, 0, 0, -90]);
  });

  it("keeps cv2's float32 rounding on a rotated square", () => {
    const rect = minAreaRect(Int32Array.of(3, 1, 1, 3, 3, 5, 5, 3));
    expect(tuple(rect)).toEqual([3.000000476837158, 2.999999761581421, 2.8284268379211426, 2.8284268379211426, -45]);
    expect(Array.from(boxPoints(rect))).toEqual([
      3.000000476837158, 4.999999523162842, 1.0000005960464478, 2.999999761581421, 3.000000476837158, 1,
      5.000000476837158, 2.999999523162842,
    ]);
  });
});
