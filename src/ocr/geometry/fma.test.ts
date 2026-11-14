import { describe, expect, it } from "vitest";
import { fma32, fma64 } from "./fma.js";

describe("fused multiply-add", () => {
  it("rounds a float32 a*b + c once where a double sum would land on a tie", () => {
    const a = 1 + 2 ** -12;
    expect(Math.fround(a * a + 2 ** -60)).toBe(1 + 2 ** -11);
    expect(fma32(a, a, 2 ** -60)).toBe(1 + 2 ** -11 + 2 ** -23);
    expect(fma32(3, 5, -15)).toBe(0);
  });

  it("keeps the low product bits a separate double multiply drops", () => {
    const a = 1 + 2 ** -30;
    expect(a * a - 1).toBe(2 ** -29);
    expect(fma64(a, a, -1)).toBe(2 ** -29 + 2 ** -60);
    expect(fma64(0.1, 10, -1)).toBe(5.551115123125783e-17);
  });
});
