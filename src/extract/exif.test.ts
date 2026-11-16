import { describe, it, expect } from "vitest";
import { exifOrientation } from "./exif.js";

/** SOI, an APP1 Exif segment whose IFD0 holds one orientation entry, then SOS. */
function jpegWith(orientation: number, order: "II" | "MM", tag = 0x0112): Buffer {
  const little = order === "II";
  const u16 = (n: number) => (little ? [n & 0xff, n >> 8] : [n >> 8, n & 0xff]);
  const u32 = (n: number) => (little ? [n, 0, 0, 0] : [0, 0, 0, n]);
  const tiff = [...Buffer.from(order, "latin1"), ...u16(42), ...u32(8), ...u16(1), ...u16(tag), ...u16(3), ...u32(1), ...u16(orientation), 0, 0, ...u32(0)];
  const body = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  const length = body.length + 2;
  return Buffer.from([0xff, 0xd8, 0xff, 0xe1, length >> 8, length & 0xff, ...body, 0xff, 0xda, 0, 2]);
}

describe("exifOrientation", () => {
  it.each(["II", "MM"] as const)("reads every orientation in %s byte order", (order) => {
    for (const value of [1, 2, 3, 4, 5, 6, 7, 8]) expect(exifOrientation(jpegWith(value, order))).toBe(value);
  });

  it("is 1 when the orientation tag is absent", () => {
    expect(exifOrientation(jpegWith(6, "MM", 0x010f))).toBe(1);
  });

  it("is 1 for an out-of-range value, a non-JPEG and empty input", () => {
    expect(exifOrientation(jpegWith(9, "II"))).toBe(1);
    expect(exifOrientation(jpegWith(0, "II"))).toBe(1);
    expect(exifOrientation(Buffer.from("not a jpeg"))).toBe(1);
    expect(exifOrientation(Buffer.alloc(0))).toBe(1);
  });

  it("is 1 for every truncation that cuts the orientation entry", () => {
    const whole = jpegWith(6, "II");
    const entryEnd = whole.length - 4 - 6;
    for (let cut = 0; cut < entryEnd; cut++) expect(exifOrientation(whole.subarray(0, cut))).toBe(1);
  });

  it("is 1 when the IFD offset points past the data", () => {
    const bad = jpegWith(6, "MM");
    bad[bad.indexOf(0x2a) + 4] = 0xff;
    expect(exifOrientation(bad)).toBe(1);
  });
});
