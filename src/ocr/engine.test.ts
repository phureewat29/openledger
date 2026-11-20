import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { readPageText } from "./engine.js";
import type { Models } from "./models.js";
import type { Raster } from "./raster.js";
import { loadModels } from "./session.js";

interface Golden {
  image: { shape: [number, number, number]; png?: "grey" };
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
  "letterpress-marks",
  "receipt-cells",
  "prose-banded",
  "committee-list",
  "loopless-kanit",
  "columns-tilted-lines",
];

const fixture = (name: string) => new URL(`../../fixtures/ocr/${name}`, import.meta.url);

/** A grey PNG stays one channel, so the engine turns it to BGR itself, as cv2.imread does. */
async function readPNG(name: string): Promise<Raster> {
  const mupdf = await import("mupdf");
  const image = new mupdf.Image(readFileSync(fixture(name)));
  const decoded = image.toPixmap();
  const grey = decoded.getNumberOfComponents() === 1 && !decoded.getAlpha();
  const pixmap = grey ? decoded : decoded.convertToColorSpace(mupdf.ColorSpace.DeviceBGR, false);
  const channels = grey ? 1 : 3;
  const [width, height, stride] = [pixmap.getWidth(), pixmap.getHeight(), pixmap.getStride()];
  const pixels = pixmap.getPixels();
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) data.set(pixels.subarray(y * stride, y * stride + width * channels), y * width * channels);
  if (pixmap !== decoded) pixmap.destroy();
  decoded.destroy();
  image.destroy();
  return { width, height, channels, data };
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
    const raster = await readPNG(`${name}.png`);
    expect([raster.height, raster.width, raster.channels === 1]).toEqual([golden.image.shape[0], golden.image.shape[1], golden.image.png === "grey"]);
    const page = await readPageText(raster, models);
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
