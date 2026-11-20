import { partition } from "es-toolkit";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isListPair, isProse, startRep, type Extent } from "./columns.js";
import { cropLine } from "./crop.js";
import { detectorGeometry, toPage } from "./detect.js";
import { lineHeight, orderPoints, orientation, type Quad } from "./geometry/quad.js";
import { splitLine } from "./gutter-split.js";
import { padWhite } from "./image/border.js";
import { bgrToGray, grayToBGR } from "./image/color.js";
import { rot90 } from "./image/rotate.js";
import { dropReason, invalidShare } from "./line-filter.js";
import { applyMarks, markCandidates, planMarks } from "./marks.js";
import { f32, roundHalfEven } from "./numeric.js";
import type { Raster } from "./raster.js";
import { bandedColumns, readingOrder } from "./reading-order.js";
import { LINE_NORMALIZE, lineWidth, planBatches, recognizerWidth } from "./recognize/batch.js";
import { decodeCTC } from "./recognize/ctc.js";
import { flatten, medianRow } from "./recognize/flatten.js";
import { pageSkew } from "./skew.js";
import { baseLetters, digitsOf, mixedLatin } from "./text-classes.js";
import { fixDecimalCommas } from "./thai-norm.js";

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
      expect([c.name, readingOrder(c.boxes.map(quad), c.texts ?? undefined, c.angle ?? undefined)]).toEqual([c.name, c.out]);
    }
  });
});

interface Rules {
  list_rep: number;
  list_facing: number;
  list_max_w: number;
  list_enum: number;
}
type Reading = [text: string, confidence: number];

const SHIPPED_RULES: Rules = { list_rep: 0.6, list_facing: 0, list_max_w: 10, list_enum: 0 };
const SHIPPED_REC = { drop_below: 0.8, min_chars: 2, min_chars_digits: 1, min_chars_digits_height: 0.62, min_chars_latin: true, junk_below: 0.9, junk_invalid: 0.05 };
const shipped = (actual: Record<string, unknown> | null, expected: Record<string, unknown>) =>
  actual !== null && Object.entries(expected).every(([key, value]) => actual[key] === value);
const reading = ([text, confidence]: Reading) => ({ text, confidence });

describe("2.1 runtime functions", () => {
  it("count mixed Latin, pick digits as str.isdigit, strip marks, fix decimal commas and measure line starts", () => {
    for (const c of fn("mixed") as { text: string; out: number }[]) expect([c.text, mixedLatin(c.text)]).toEqual([c.text, c.out]);
    for (const c of fn("digits") as { text: string; out: string }[]) expect([c.text, digitsOf(c.text)]).toEqual([c.text, c.out]);
    for (const c of fn("base") as { text: string; out: string }[]) expect([c.text, baseLetters(c.text)]).toEqual([c.text, c.out]);
    const { cases } = fn("decimal_comma") as unknown as { cases: { text: string; out: string }[] };
    for (const c of cases) expect([c.text, fixDecimalCommas(c.text)]).toEqual([c.text, c.out]);
    for (const c of fn("start_rep") as { lines: string[]; out: number }[]) expect([c.lines, startRep(c.lines)]).toEqual([c.lines, c.out]);
  });

  it("drop lines with the shipped filter, the one-character exception gated by box height", () => {
    const cases = fn("drop_reason") as { text: string; conf: number; hratio: number | null; rec: Record<string, unknown>; out: string | null }[];
    // A case that changes a rec key exercises a config the bundled model does not ship.
    const [run, skipped] = partition(cases, (k) => shipped(k.rec, SHIPPED_REC));
    expect(skipped.map((k) => k.text)).toEqual(["2", "2", "g", "ก"]);
    for (const c of run) {
      expect([c.text, c.conf, c.hratio, dropReason(c.text, c.conf, c.hratio ?? undefined) ?? null]).toEqual([c.text, c.conf, c.hratio, c.out]);
    }
  });

  it("test prose columns, the list guard and banded columns at the shipped rules", () => {
    type ColumnCase = { name: string; ext: Extent[]; hmed: number; texts: string[] | null };
    const layout = (c: ColumnCase) => ({ ext: c.ext, hmed: c.hmed, texts: c.texts ?? undefined });
    for (const c of fn("prose") as (ColumnCase & { col: number[]; out: boolean })[]) expect([c.name, isProse(c.col, layout(c))]).toEqual([c.name, c.out]);
    const pairs = fn("list_pair") as (ColumnCase & { lcol: number[]; rcol: number[]; rules: Rules | null; out: boolean })[];
    // rules=None, list_rep 0, list_facing and list_enum are off in the shipped config, which always runs the list_rep guard.
    const [run, skipped] = partition(pairs, (k) => shipped(k.rules as Record<string, unknown> | null, { ...SHIPPED_RULES }));
    expect(skipped.map((k) => k.name)).toEqual([
      "rules_none",
      "rules_all_zero",
      "facing_narrow",
      "facing_wide",
      "facing_offset_rows",
      "enum_numbered_left",
      "enum_half_numbered",
      "enum_not_facing",
    ]);
    for (const c of run) {
      expect([c.name, isListPair(c.lcol, c.rcol, layout(c))]).toEqual([c.name, c.out]);
    }
    for (const c of fn("banded_columns") as (ColumnCase & { idx: number[]; depth: number; rules: Rules; out: number[][] | null })[]) {
      expect(c.rules).toEqual(SHIPPED_RULES);
      expect([c.name, bandedColumns(c.idx, layout(c), c.depth) ?? null]).toEqual([c.name, c.out]);
    }
  });

  it("order boxes with the shipped list guard and the unrotated frame", () => {
    const cases = fn("reading_order_rules") as { name: string; boxes: Points[]; angle: number | null; texts: string[] | null; rules: Rules | null; out: number[][] }[];
    // rules=None turns the list guard off, which the shipped config never does.
    const [run, skipped] = partition(cases, (k) => k.rules !== null);
    expect(skipped.map((k) => k.name)).toEqual(["columns_starting_alike_rules_none", "committee_list_rules_none"]);
    for (const c of run) {
      expect(c.rules).toEqual(SHIPPED_RULES);
      expect([c.name, readingOrder(c.boxes.map(quad), c.texts ?? undefined, c.angle ?? undefined)]).toEqual([c.name, c.out]);
    }
  });

  it("attach floating marks: grown boxes, accepted re-reads and absorbed marks", () => {
    const cases = fn("attach_marks") as {
      name: string;
      img_hw: [number, number];
      boxes: Points[];
      rec: Reading[];
      frag: number[];
      reread: Record<string, Reading>;
      reread_boxes: Points[];
      absorbed: number[];
      boxes_after: Points[];
      rec_after: Reading[];
    }[];
    for (const c of cases) {
      const lines = { boxes: c.boxes.map(quad), readings: c.rec.map(reading), rows: [] };
      const page = { height: c.img_hw[0], width: c.img_hw[1] };
      const plan = planMarks(lines.boxes, markCandidates(lines, new Set(c.frag)), page);
      const grown = plan?.grown ?? [];
      expect([c.name, grown.map((g) => Array.from(g.box))]).toEqual([c.name, c.reread_boxes.map((b) => b.flat())]);
      const after = plan ? applyMarks(lines, plan, grown.map(({ line }) => reading(c.reread[line] ?? ["", 0]))) : { lines, absorbed: new Set<number>() };
      expect([c.name, [...after.absorbed].sort((a, b) => a - b), after.lines.boxes.map((b) => Array.from(b)), after.lines.readings.map((r) => [r.text, r.confidence])]).toEqual([
        c.name,
        c.absorbed,
        c.boxes_after.map((b) => b.flat()),
        c.rec_after,
      ]);
    }
  });
});
