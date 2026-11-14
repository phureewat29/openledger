import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Raster } from "../raster.js";
import { resizeLinear } from "./resize.js";

interface NDArray {
  shape: number[];
  data: number[];
}

interface ResizeCase {
  src: NDArray;
  size_wh: [number, number];
  out: NDArray;
}

const { resize_linear: CASES } = JSON.parse(
  readFileSync(new URL("../../../fixtures/ocr/primitives.json", import.meta.url), "utf8"),
) as { resize_linear: ResizeCase[] };

const raster = (a: NDArray): Raster => ({
  height: a.shape[0],
  width: a.shape[1],
  channels: a.shape.length === 3 ? 3 : 1,
  data: Uint8Array.from(a.data),
});

/** The noise the expected bytes below were made from with cv2.resize. */
const noise = (width: number, height: number): Raster => ({
  width,
  height,
  channels: 3,
  data: Uint8Array.from({ length: width * height * 3 }, (_, i) => Math.imul(i, 2654435761) >>> 24),
});

const fnv1a = (bytes: Uint8Array): number => bytes.reduce((h, b) => Math.imul(h ^ b, 0x01000193) >>> 0, 0x811c9dc5);

describe("resizeLinear", () => {
  it("matches cv2 on every three-channel primitives case", () => {
    const colour = CASES.filter((c) => c.src.shape.length === 3);
    const mismatches = colour.filter((c) => {
      const got = resizeLinear(raster(c.src), c.size_wh[0], c.size_wh[1]);
      return got.height !== c.out.shape[0] || got.width !== c.out.shape[1] || !got.data.every((v, i) => v === c.out.data[i]);
    });
    expect(colour.length).toBe(11);
    expect(mismatches).toEqual([]);
  });

  it("rejects anything but three channels", () => {
    const gray = CASES.filter((c) => c.src.shape.length === 2);
    expect(gray.length).toBe(2);
    for (const c of gray) expect(() => resizeLinear(raster(c.src), c.size_wh[0], c.size_wh[1])).toThrow(/3 channels/);
  });

  it.each([
    [
      "KleidiCV r2",
      40,
      3,
      30,
      2,
      "25a341b3716fa03fd26f2dac3dbc7aaba947da7836a846c47614b244ad8173b14fd67e1daf4db67d7bba4ba9873ab856c88624b554928442c152d18f20be5cb98d2bbd5b598b29bc59c29628c664959332c462c09230af609e9c44e28032b04ebf7e51ae4ceb7c3bb94ac88659b755878543b553d1832cc052908e55bd5cee8c35bc5a998a28c659579547c563d49331c361609150ce5f3d9b38cc6a9c9a38ca683b9841d567a5a334d27163a13fd16f2e9f3dbb",
    ],
    [
      "KleidiCV r3",
      70,
      3,
      30,
      2,
      "9a77408260be40c967d4723b7d5bb93bc462ce6c4b7755b335be5cc967457250ae5bb957c361406c4aa955b352be5cbb6745a350ae4cb857b5613f9e8aa847b351b05c3a9884a357ad4caa5635937f9e51a846a551ef8d79984c8826af30cf6daf78558220a92bc967a972507d1bb926c462a46d4a7796b420be5dc967457291ae1bb957c462c06c8ba915b352be5cbb6786a310ae4cb957b561809ecaa947b351c55c7b98c5a341ae4cc0567593bf9e3ca847ba",
    ],
    [
      "KleidiCV r3 with the last lane read directly",
      90,
      3,
      31,
      2,
      "cb724e673ca4cc99378f2dcb46c05eb6548c49e786dd7b2b7070ad54a2409836d12bc967bf5dd352b68f9984497a38b674ab49a13fdd42d270c8665a5b3c97df8d2b8321bf45b452aa489e3ddb79d16f296484a06696448c33c822bd5ba240db35ca71c967965d7999d48e2c8322c05eb553ab49b83edc7ad2701e66c1a2a397358c2bc920be5cb352d647c584b479646e47ab37a03e9534d22bc765bc5ba9508c8dd28120778eb470a9479e3db731d06ec5644059c096af8a32",
    ],
    [
      "OpenCV past a third of the width, where its float32 coordinates and half-to-even weights show",
      270,
      2,
      67,
      1,
      "9475937e9c806886a49e6f8e8caa77a442608dac4a779590617f7e4a68879c527089a7598794b2708ea0597796be617fabca69963755809e436987a560718f4e6c78a559788fad657896b583809e706987b553719ebc5b885675718f625b79978062816e8c6a977997809f846a88a6a37290905b79a6456390ae4c7a76956381824c6a89a054728dab5c8999b77391a55c7a98c26482af4e6b993b5a82a0476b89a865739152717ba85e7c91af697b99b78882a04e6c8ab75574a1bf5d8a5b797492665d7b9a856583",
    ],
    ["OpenCV halving, which cv2 runs as INTER_AREA", 8, 6, 4, 3, "9876548d2bc942a07fb796348260be37d574ad8b29a2409e2ccb69a2805e9735d34caa89"],
  ])("matches cv2 on %s", (_path, width, height, dstWidth, dstHeight, hex) => {
    expect(Buffer.from(resizeLinear(noise(width, height), dstWidth, dstHeight).data).toString("hex")).toBe(hex);
  });

  it("matches cv2 where KleidiCV recalibrates its running coordinate or its last row lands on the image's last row", () => {
    const digests = [
      [4000, 2, 2900, 1],
      [6000, 2, 3001, 1],
      [9000, 2, 3001, 1],
      [40, 300, 30, 299],
    ].map(([width, height, dstWidth, dstHeight]) => fnv1a(resizeLinear(noise(width, height), dstWidth, dstHeight).data));
    expect(digests).toEqual([0x1f5a3095, 0x53c1287a, 0xc6aa7b99, 0x573d58e6]);
  });
});
