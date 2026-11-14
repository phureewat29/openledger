import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cropLine } from "./crop.js";
import { detectorGeometry, toPage } from "./detect.js";
import { lineHeight, orderPoints, orientation, type Quad } from "./geometry/quad.js";
import { splitLine } from "./gutter-split.js";
import { padWhite } from "./image/border.js";
import { bgrToGray, grayToBGR } from "./image/color.js";
import { rot90 } from "./image/rotate.js";
import { invalidShare } from "./line-filter.js";
import { f32, roundHalfEven } from "./numeric.js";
import type { Raster } from "./raster.js";
import { readingOrder } from "./reading-order.js";
import { LINE_NORMALIZE, lineWidth, planBatches, recognizerWidth } from "./recognize/batch.js";
import { decodeCTC } from "./recognize/ctc.js";
import { flatten, medianRow } from "./recognize/flatten.js";
import { pageSkew } from "./skew.js";

interface NDArray {
  shape: number[];
  data: number[];
}
type Points = number[][];
type Case = Record<string, unknown>;

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../fixtures/ocr/${name}`, import.meta.url), "utf8"));
const P = fixture("primitives.json") as Record<string, Case[]> & { functions: { name: string; cases: Case[] }[] };
const fn = (name: string): Case[] => P.functions.find((f) => f.name === name)?.cases ?? [];

const raster = (a: NDArray): Raster => ({
  height: a.shape[0],
  width: a.shape[1],
  channels: (a.shape[2] ?? 1) as 1 | 3,
  data: Uint8Array.from(a.data),
});
const quad = (points: Points): Quad => Float32Array.from(points.flat());
const bytes = (r: Raster | Uint8Array) => Array.from(r instanceof Uint8Array ? r : r.data);
const CHARSET = ["", ...readFileSync(new URL("../../models/ocr/rec_dict.txt", import.meta.url), "utf8").split("\n").filter(Boolean), " "];

describe("raster primitives", () => {
  it("convert BGR to grey and back as cv2 does", () => {
    for (const c of P.cvt_color_bgr2gray as { src: NDArray; gray: NDArray; back_to_bgr: NDArray }[]) {
      const gray = bgrToGray(raster(c.src));
      expect(Array.from(gray)).toEqual(c.gray.data);
      expect(bytes(grayToBGR(gray, c.src.shape[1], c.src.shape[0]))).toEqual(c.back_to_bgr.data);
    }
  });

  it("pad white, turn by quarters and median-filter rows as cv2 and numpy do", () => {
    for (const c of P.copy_make_border_constant_white as { src: NDArray; pad: number; out: NDArray }[]) {
      expect(bytes(padWhite(raster(c.src), c.pad))).toEqual(c.out.data);
    }
    for (const c of P.np_rot90 as { src: NDArray; k1: NDArray; k_minus1: NDArray; k2: NDArray; flip_both: NDArray }[]) {
      const src = raster(c.src);
      expect([rot90(src, 1), rot90(src, -1), rot90(src, 2)].map(bytes)).toEqual([c.k1.data, c.k_minus1.data, c.k2.data]);
      expect(bytes(rot90(src, 2))).toEqual(c.flip_both.data);
    }
    for (const c of P.median_blur_three_rows as { row: number[]; ksize: number; out_row1: number[] }[]) {
      expect(Array.from(medianRow(Uint8Array.from(c.row), c.ksize))).toEqual(c.out_row1);
    }
  });

  it("flatten crops to dark text on white", () => {
    for (const c of fn("flatten") as { src: NDArray; out: NDArray }[]) {
      expect(Array.from(flatten(Uint8Array.from(c.src.data), c.src.shape[1], c.src.shape[0]))).toEqual(c.out.data);
    }
  });
});

describe("detector and recognizer framing", () => {
  it("rounds halves to even and sizes the detector input", () => {
    for (const c of P.py_round as { x: number; round0: number }[]) expect(roundHalfEven(c.x)).toBe(c.round0);
    for (const c of P.det_size as { hw: [number, number]; pad: number; padded: [number, number]; resized: [number, number] }[]) {
      const g = detectorGeometry(c.hw[1], c.hw[0]);
      expect([g.pad, g.paddedHeight, g.paddedWidth, g.height, g.width]).toEqual([c.pad, ...c.padded, ...c.resized]);
    }
  });

  it("maps boxes back to the page in float32", () => {
    for (const c of P.float32_box_rescale_clip as { box_in: Points; sx: number; sy: number; pad: number; W0: number; H0: number; box_out: Points }[]) {
      const frame = { pad: c.pad, paddedWidth: 0, paddedHeight: 0, pageWidth: c.W0, pageHeight: c.H0 };
      expect(Array.from(toPage(quad(c.box_in), frame, f32(c.sx), f32(c.sy)))).toEqual(c.box_out.flat());
    }
  });

  it("sizes, orders and batches recognizer lines", () => {
    for (const c of P.rec_flatten_width as { crop_hw: [number, number]; flatten_width: number }[]) {
      expect(recognizerWidth(c.crop_hw[1], c.crop_hw[0])).toBe(c.flatten_width);
    }
    for (const c of P.rec_batching as { ratios: number[]; order: number[]; batches: { idx: number[]; W: number; widths: number[] }[] }[]) {
      const plans = planBatches(c.ratios);
      expect(plans.flatMap((p) => p.indices)).toEqual(c.order);
      expect(plans.map((p) => ({ idx: p.indices, W: p.width, widths: p.indices.map((i) => lineWidth(c.ratios[i], p.width)) }))).toEqual(c.batches);
    }
    for (const c of P.rec_preprocess as { src: NDArray; tensor: NDArray }[]) {
      const [h, w] = c.src.shape;
      const chw = [0, 1, 2].flatMap((ch) => Array.from({ length: h * w }, (_, i) => LINE_NORMALIZE[c.src.data[i * 3 + ch]]));
      expect(chw).toEqual(c.tensor.data);
    }
  });

  it("decodes CTC with first-max ties, collapsed runs and dropped blanks", () => {
    const { cases } = (fn("ctc_detail_and_words") as unknown as { cases: { T: number; n_classes: number; peaks_t_class_value: Points; text: string; conf: number }[] });
    for (const c of cases) {
      const probs = new Float32Array(c.T * c.n_classes);
      for (const [t, cls, value] of c.peaks_t_class_value) probs[t * c.n_classes + cls] = value;
      expect(decodeCTC(probs, 0, c.T, c.n_classes, CHARSET)).toEqual({ text: c.text, confidence: c.conf });
    }
    for (const c of P.argmax_ties as { rows: NDArray; argmax: number[]; max: number[] }[]) {
      const [steps, classes] = c.rows.shape;
      const decoded = decodeCTC(Float32Array.from(c.rows.data), 0, steps, classes, ["", "a", "b", "c"]);
      const emitted = c.argmax.flatMap((id, t) => (id !== 0 && id !== c.argmax[t - 1] ? [t] : []));
      expect(decoded.text).toBe(emitted.map((t) => "_abc"[c.argmax[t]]).join(""));
    }
  });
});

describe("line crops and gutter splits", () => {
  it("rectifies a quad into a line image", () => {
    for (const c of fn("crop_line") as { src: NDArray; box: Points; turn: 0 | 1 | -1; out: NDArray }[]) {
      const crop = cropLine(raster(c.src), quad(c.box));
      const turned = c.turn !== 0 && crop.height / crop.width >= 1.5 ? rot90(crop, c.turn) : crop;
      expect([turned.height, turned.width, bytes(turned)]).toEqual([c.out.shape[0], c.out.shape[1], c.out.data]);
    }
  });

  it("cuts a line at wide blank stretches and trims blank ends", () => {
    for (const c of fn("split_one") as { name: string; src: NDArray; box: Points; ratio: number; pieces: Points[]; identity: boolean }[]) {
      const box = quad(c.box);
      const pieces = splitLine(box, cropLine(raster(c.src), box), c.ratio);
      expect([c.name, pieces.map((p) => Array.from(p)), pieces[0] === box]).toEqual([c.name, c.pieces.map((p) => p.flat()), c.identity]);
    }
  });
});

describe("page geometry functions", () => {
  it("order corners, measure line height, vote orientation and median skew", () => {
    for (const c of fn("order_points") as { in: Points; out: Points }[]) expect(Array.from(orderPoints(quad(c.in)))).toEqual(c.out.flat());
    for (const c of fn("line_height") as { boxes: Points[]; out: number }[]) expect(lineHeight(c.boxes.map(quad))).toBe(c.out);
    for (const c of fn("vertical") as { box: Points; ratio: number; out: number }[]) expect(orientation(quad(c.box), c.ratio)).toBe(c.out);
    for (const c of fn("page_skew") as { boxes: Points[]; out: number }[]) expect(pageSkew(c.boxes.map(quad))).toBeCloseTo(c.out, 12);
    for (const c of fn("invalid_share") as { text: string; out: number }[]) expect(invalidShare(c.text)).toBe(c.out);
  });

  it("orders boxes into rows and column blocks", () => {
    const cases = fn("reading_order") as { name: string; boxes: Points[]; angle: number | null; columns: boolean; texts: string[] | null; out: number[][] }[];
    for (const c of cases.filter((k) => k.columns)) {
      const boxes = c.boxes.map(quad);
      const texts = c.texts ?? boxes.map(() => "");
      expect([c.name, c.angle === null ? readingOrder(boxes, texts) : readingOrder(boxes, texts, c.angle)]).toEqual([c.name, c.out]);
    }
  });
});
