import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { boxPoints, minAreaRect } from "./min-area-rect.js";
import { orderPoints } from "./quad.js";
import { unclip } from "./unclip.js";

interface Case {
  box: number[][];
  ratio: number;
  out: number[][] | null;
}

const CASES = (
  JSON.parse(readFileSync(new URL("../../../fixtures/ocr/primitives.json", import.meta.url), "utf8")) as {
    unclip_pyclipper_round: Case[];
  }
).unclip_pyclipper_round;

const grown = (box: number[], ratio: number) => {
  const out = unclip(Float32Array.from(box), ratio);
  return out && Array.from(out);
};

describe("unclip", () => {
  it.each(CASES.map((c, i) => [i, c] as const))("returns pyclipper's polygon point for point on case %i", (_, c) => {
    expect(grown(c.box.flat(), c.ratio)).toEqual(c.out?.flat());
  });

  it("starts after the topmost, rightmost vertex, which moves minAreaRect's float32 result", () => {
    const box = [
      260.7365417480469, 850.0121459960938, 283.4513244628906, 850.0121459960938, 283.4513244628906, 905.9170532226562,
      260.7365417480469, 905.9170532226562,
    ];
    const out = unclip(Float32Array.from(box), 1.5);
    expect(out && Array.from(out)).toEqual([
      288, 839, 292, 842, 294, 846, 295, 850, 295, 905, 294, 910, 291, 914, 287, 916, 283, 917, 260, 917, 255, 916,
      251, 913, 249, 909, 248, 905, 248, 850, 249, 845, 252, 841, 256, 839, 260, 838, 283, 838,
    ]);
    const rect = minAreaRect(out ?? new Float32Array(0));
    expect(Array.from(orderPoints(boxPoints(rect)))).toEqual([248, 838, 295, 838, 295, 917, 248, 917]);
    expect(Math.min(rect.width, rect.height)).toBe(46.99999237060547);
  });

  it("truncates corners toward zero on the way in, as pyclipper's integer conversion does", () => {
    const box = [
      -1.7034361362457275, 119.08193969726562, 4.662606239318848, 109.15322875976562, 7.453652381896973,
      110.94277954101562, 1.0876095294952393, 120.87149047851562,
    ];
    expect(grown(box, 1.4)).toEqual([8, 108, 9, 110, 9, 111, 3, 121, 0, 122, -2, 121, -3, 118, 2, 108, 5, 107]);
  });
});
