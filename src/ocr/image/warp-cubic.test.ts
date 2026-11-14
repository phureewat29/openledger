import { describe, expect, it } from "vitest";
import type { Raster } from "../raster.js";
import { warpCubic } from "./warp-cubic.js";

/** The noise the expected bytes below were made from with cv2 (flags INTER_CUBIC | WARP_INVERSE_MAP). */
const noise = (width: number, height: number, channels: 1 | 3): Raster => ({
  width,
  height,
  channels,
  data: Uint8Array.from({ length: width * height * channels }, (_, i) => Math.imul(i, 2654435761) >>> 24),
});

const gray = (width: number, height: number): Raster => {
  const { data } = noise(width, height, 1);
  return { width, height, channels: 3, data: Uint8Array.from({ length: data.length * 3 }, (_, i) => data[Math.floor(i / 3)]) };
};

const hex = (r: Raster): string => Buffer.from(r.data).toString("hex");

const OFF_EDGE = Float32Array.of(1, 0, 5.020898342132568, 0, 1, 0.7479914426803589, 0, 0, 1);
const TURN = Float32Array.of(0.9, 0.1, 0.25, -0.1, 0.95, 0.7, 0, 0, 1);

describe("warpCubic", () => {
  it("fills a batch of eight lanes that all miss the image with the border value outright", () => {
    expect(hex(warpCubic(noise(3, 3, 3), OFF_EDGE, "affine", 12, 1, [254, 254, 254]))).toBe("fe".repeat(36));
  });

  it("runs the float16 arithmetic on border taps for a batch shorter than eight, as cv2 does", () => {
    expect(hex(warpCubic(noise(3, 3, 3), OFF_EDGE, "affine", 5, 1, [254, 254, 254]))).toBe("fd".repeat(15));
  });

  it("rounds a flat neighbourhood in float16, which can move it off its value", () => {
    const flat: Raster = { width: 8, height: 8, channels: 3, data: new Uint8Array(192).fill(254) };
    const m = Float32Array.of(1, 0, 0.748228907585144, 0, 1, 0.452741801738739, 0, 0, 1);
    expect(hex(warpCubic(flat, m, "affine", 4, 4, null))).toBe("fd".repeat(48));
  });

  it("matches cv2 on a gray image (one channel computed) and on it with one tinted tap (all three)", () => {
    const tinted = gray(6, 6);
    tinted.data.set([10, 20, 30], (2 * 6 + 3) * 3);
    expect(hex(warpCubic(gray(6, 6), TURN, "affine", 6, 6, null))).toBe(
      "828282808080a0a0a0c4c4c46b6b6b3f3f3f5b5b5b353535e6e6e65e5e5e4e4e4ebfbfbf4a4a4a7171718b8b8b818181e8e8e87a7a7aaaaaaa6b6b6b6b6b6bf8f8f87878783838386c6c6c3e3e3e6767677c7c7c606060f9f9f9232323a4a4a4aeaeae1a1a1a2a2a2ab5b5b5",
    );
    expect(hex(warpCubic(tinted, TURN, "affine", 6, 6, null))).toBe(
      "828282808080a0a0a0c8c8c76c6c6b3f3f3f5b5b5b363636e2e3e4474b4f4e4e4ebfbfbf4a4a4a747373808284535a62eaeaea7a7a7aaaaaaa6a6b6b6e6d6dfefdfc7777773838386c6c6c3e3e3e6767677c7c7c606060f9f9f9232323a4a4a4aeaeae1a1a1a2a2a2ab5b5b5",
    );
  });

  it("weights a subnormal float16 fraction as cv2 does", () => {
    const m = Float32Array.of(1, 0, 2 ** -20, 0, 1, 2 ** -17, 0, 0, 1);
    expect(hex(warpCubic(noise(5, 4, 1), m, "affine", 5, 4, null))).toBe("009e3cda7817b553f18f2ecc6a08a745e3811fbe");
  });

  it("divides per pixel for a perspective matrix and replicates the edge", () => {
    const m = Float32Array.of(0.8, 0.05, 1.3, 0.02, 0.9, -0.4, 0.01, 0.003, 1);
    expect(hex(warpCubic(noise(6, 6, 3), m, "perspective", 7, 5, null))).toBe(
      "e66857ae4bff9332d87600b2574c9440ff7c40ff7cff7736ba5a8da242ec8719d8682ca152628e545c90d5961cf47911c25f88a447db8619db7100ab7200ae4cb052d89427e47900c75e789f3ed48c2ad88e2cd50ed36a2fae4dd79231e07900be5856a544e2a847d3",
    );
  });
});
