import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { readPageText } from "./engine.js";
import type { Models } from "./models.js";
import type { Raster } from "./raster.js";
import { loadModels } from "./session.js";

interface Golden {
  text: string;
  rotation: number;
  lines: { text: string }[];
  dropped: { text: string; reason: string }[];
}

const PAGES = [
  "statement",
  "eslip-phone",
  "prose-two-column",
  "numbered-across",
  "rotated-ccw90",
  "rotated-cw90",
  "upside-down",
  "skewed-4deg",
  "photo-like",
  "single-line-faint",
  "blank-page",
  "gutter-words",
  "gutter-trim",
];

const fixture = (name: string) => new URL(`../../fixtures/ocr/${name}`, import.meta.url);

async function readPNG(name: string): Promise<Raster> {
  const mupdf = await import("mupdf");
  const pixmap = new mupdf.Image(readFileSync(fixture(name))).toPixmap().convertToColorSpace(mupdf.ColorSpace.DeviceBGR, false);
  const [width, height, stride] = [pixmap.getWidth(), pixmap.getHeight(), pixmap.getStride()];
  const pixels = pixmap.getPixels();
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) data.set(pixels.subarray(y * stride, y * stride + width * 3), y * width * 3);
  return { width, height, channels: 3, data };
}

describe("engine against the vendor runtime's goldens", () => {
  let models: Models;
  beforeAll(async () => {
    const loaded = await loadModels();
    if (!loaded.ok) throw new Error(loaded.error);
    models = loaded.value;
  });

  it.each(PAGES)("reads %s exactly as the vendor runtime does", async (name) => {
    const golden = JSON.parse(readFileSync(fixture(`${name}.json`), "utf8")) as Golden;
    const page = await readPageText(await readPNG(`${name}.png`), models);
    expect({
      rotation: page.rotation,
      lines: page.lines.map((l) => l.text),
      dropped: page.dropped.map((d) => [d.text, d.reason]),
    }).toEqual({
      rotation: golden.rotation,
      lines: golden.lines.map((l) => l.text),
      dropped: golden.dropped.map((d) => [d.text, d.reason]),
    });
    expect(page.text).toBe(golden.text);
  }, 60_000);

  it.each([
    [1, 40],
    [40, 1],
    [1, 1],
  ])("reads a %ix%i image as empty instead of failing", async (width, height) => {
    const page = await readPageText({ width, height, channels: 3, data: new Uint8Array(width * height * 3).fill(255) }, models);
    expect(page.text).toBe("");
  });
});
