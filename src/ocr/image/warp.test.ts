import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { roundHalfEven } from "../numeric.js";
import type { Raster } from "../raster.js";
import { perspectiveTransform, rotationMatrix, warpAffineCubic, warpPerspectiveCubic } from "./warp.js";

interface NDArray {
  shape: number[];
  data: number[];
}

interface Primitives {
  warp_perspective_cubic_replicate: { src: NDArray; box: number[][]; size_wh: [number, number]; matrix: NDArray; out: NDArray }[];
  rotation_matrix_deskew_canvas: { size_wh: [number, number]; angle: number; matrix: NDArray }[];
  warp_affine_cubic_constant: { src: NDArray; angle: number; border_value: number[] | number; raw_warp_out: NDArray }[];
}

const CASES = JSON.parse(readFileSync(new URL("../../../fixtures/ocr/primitives.json", import.meta.url), "utf8")) as Primitives;

const raster = (a: NDArray): Raster => ({
  height: a.shape[0],
  width: a.shape[1],
  channels: a.shape.length === 3 ? 3 : 1,
  data: Uint8Array.from(a.data),
});

/** _deskew's canvas: the rotation grown to fit, its translation moved to the new centre. */
function deskewMatrix(src: Raster, angle: number): { m: Float64Array; width: number; height: number } {
  const m = rotationMatrix(src.width / 2, src.height / 2, angle);
  const [c, s] = [Math.abs(m[0]), Math.abs(m[1])];
  const width = roundHalfEven(src.height * s + src.width * c);
  const height = roundHalfEven(src.height * c + src.width * s);
  m[2] += width / 2 - src.width / 2;
  m[5] += height / 2 - src.height / 2;
  return { m, width, height };
}

describe("perspectiveTransform and warpPerspectiveCubic", () => {
  it.each(CASES.warp_perspective_cubic_replicate.map((c, i) => [i, c] as const))("match cv2 on primitives case %i", (_, c) => {
    const [w, h] = c.size_wh;
    const m = perspectiveTransform(Float32Array.from(c.box.flat()), Float32Array.of(0, 0, w, 0, w, h, 0, h));
    expect(m).toEqual(Float64Array.from(c.matrix.data));
    expect(warpPerspectiveCubic(raster(c.src), m, w, h).data).toEqual(Uint8Array.from(c.out.data));
  });

  it("throws on a quad without area", () => {
    expect(() => perspectiveTransform(Float32Array.of(0, 0, 4, 0, 8, 0, 2, 0), Float32Array.of(0, 0, 4, 0, 4, 2, 0, 2))).toThrow();
  });
});

describe("rotationMatrix", () => {
  it.each(CASES.rotation_matrix_deskew_canvas.map((c, i) => [i, c] as const))("matches cv2 on primitives case %i", (_, c) => {
    const [w, h] = c.size_wh;
    expect(rotationMatrix(w / 2, h / 2, c.angle)).toEqual(Float64Array.from(c.matrix.data));
  });
});

describe("warpAffineCubic", () => {
  it.each(CASES.warp_affine_cubic_constant.map((c, i) => [i, c] as const))("matches cv2 on primitives case %i", (_, c) => {
    const src = raster(c.src);
    const { m, width, height } = deskewMatrix(src, c.angle);
    const fill = typeof c.border_value === "number" ? [c.border_value] : c.border_value;
    const out = warpAffineCubic(src, m, width, height, fill);
    expect([out.height, out.width]).toEqual(c.raw_warp_out.shape.slice(0, 2));
    expect(out.data).toEqual(Uint8Array.from(c.raw_warp_out.data));
  });
});
