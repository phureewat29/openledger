import { describe, it, expect } from "vitest";
import {
  OCR_TIMEOUT_MS,
  isServerFailure,
  ocrPage,
  ocrPages,
  pickServedModel,
  probeOCREndpoint,
  resolveOCR,
  resolveServedModel,
  type OCRConfigSource,
} from "./ocr.js";
import { modelCardFor } from "./cards/index.js";
import { fallbackModelCard } from "./cards/fallback.js";
import { typhoonModelCard } from "./cards/typhoon-ocr1.5.js";
import type { PageImage } from "./pdf.js";
import { samplePng } from "../../fixtures/images.js";
import {
  LIVE_PAGE_TIMEOUT_MS,
  deadOCRSettings,
  liveOCR,
  requireLiveOCR,
} from "../../fixtures/ocr.js";

const png = samplePng();
const page1: PageImage = { page: 1, mime: "image/png", bytes: png };
const page2: PageImage = { page: 2, mime: "image/png", bytes: png };

// Mirrors the shipped config defaults (OCR unset).
function cfg(over: Partial<OCRConfigSource> = {}): OCRConfigSource {
  return { ocrBaseUrl: "", ocrModel: "", ocrApiKey: "", ...over };
}

const TYPHOON = typhoonModelCard;
const FALLBACK = fallbackModelCard;

describe("resolveOCR", () => {
  it("reads null when no endpoint url is set", () => {
    expect(resolveOCR(cfg())).toBeNull();
  });

  it("treats a whitespace-only url as unset", () => {
    expect(resolveOCR(cfg({ ocrBaseUrl: "  " }))).toBeNull();
  });

  it("stays unset when a model is set ahead of the url", () => {
    expect(resolveOCR(cfg({ ocrModel: "some-ocr-model" }))).toBeNull();
  });

  it("builds settings from the url alone, taking the rest from the default model card", () => {
    const settings = resolveOCR(
      cfg({ ocrBaseUrl: "http://127.0.0.1:1234/v1//", ocrApiKey: "sk-test" }),
    );
    expect(settings).toEqual({
      baseURL: "http://127.0.0.1:1234/v1",
      model: TYPHOON.model,
      apiKey: "sk-test",
      timeoutMs: OCR_TIMEOUT_MS,
      prompt: TYPHOON.prompt,
      params: TYPHOON.params,
      render: TYPHOON.render,
    });
  });

  it("keeps a model id from no known family, reading it with the fallback card", () => {
    expect(resolveOCR(cfg({ ocrBaseUrl: "http://x/v1", ocrModel: "test-ocr-model" }))).toMatchObject({
      model: "test-ocr-model",
      prompt: FALLBACK.prompt,
      params: FALLBACK.params,
      render: FALLBACK.render,
    });
  });

  // Model ids come from the registry: spelling one out here would name a vendor.
  it("matches a family whatever the version suffix", () => {
    const model = `${TYPHOON.model}-preview-v9`;
    expect(resolveOCR(cfg({ ocrBaseUrl: "http://x/v1", ocrModel: model }))).toMatchObject({
      model,
      prompt: TYPHOON.prompt,
      params: TYPHOON.params,
    });
  });

  it("matches a family case-insensitively, carrying that card's own render", () => {
    const model = TYPHOON.model.toUpperCase();
    expect(resolveOCR(cfg({ ocrBaseUrl: "http://x/v1", ocrModel: model }))).toMatchObject({
      model,
      prompt: TYPHOON.prompt,
      params: TYPHOON.params,
      render: TYPHOON.render,
    });
  });

  it("selects the typhoon card from its own model id", () => {
    expect(modelCardFor(TYPHOON.model)).toBe(TYPHOON);
  });
});

describe("isServerFailure", () => {
  it("treats a bad page as page-level and a bad server as fatal", () => {
    expect(isServerFailure("timeout")).toBe(false);
    expect(isServerFailure("bad_response")).toBe(false);
    expect(isServerFailure("unreachable")).toBe(true);
    expect(isServerFailure("rejected")).toBe(true);
  });
});

describe("ocrPage", () => {
  it("reports a closed port as unreachable", async () => {
    const result = await ocrPage(page1, deadOCRSettings());
    expect(result).toMatchObject({ ok: false, page: 1, reason: "unreachable" });
  });
});

describe("ocrPages", () => {
  it("stops at the first server-level failure instead of hammering a dead endpoint", async () => {
    const outcomes = await ocrPages([page1, page2], deadOCRSettings());
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ ok: false, page: 1, reason: "unreachable" });
  });
});

describe("probeOCREndpoint", () => {
  it("fails when nothing is listening", async () => {
    const result = await probeOCREndpoint(deadOCRSettings());
    expect(result.ok).toBe(false);
  });
});

describe("pickServedModel", () => {
  const model = TYPHOON.model;

  it("prefers the exact spelling over a variant listed first", () => {
    expect(pickServedModel(model, [`${model}-2b`, model])).toBe(model);
  });

  // Suffix shapes come from real servers; the base id comes from the registry.
  it.each([
    ["a size suffix", `${model}-2b`],
    ["a size and format suffix", `${model}-3b-gguf`],
    ["a quantization tag", `${model}-2b@q4_k_m`],
    ["an org prefix", `org/${model}-2b`],
    ["the server's own casing", model.toUpperCase()],
  ])("matches a served id carrying %s", (_variant, served) => {
    expect(pickServedModel(model, ["other-model", served])).toBe(served);
  });

  it("takes the first served variant when several match", () => {
    expect(pickServedModel(model, [`${model}-2b`, `${model}-3b`])).toBe(`${model}-2b`);
  });

  it("matches nothing when no served id contains the configured one", () => {
    expect(pickServedModel(model, ["other-model"])).toBeNull();
    expect(pickServedModel(model, [])).toBeNull();
  });

  it("matches nothing from an empty id instead of everything", () => {
    expect(pickServedModel("", [model])).toBeNull();
  });
});

describe("resolveServedModel", () => {
  it("keeps the configured id when the endpoint is unreachable", async () => {
    const settings = deadOCRSettings();
    expect(await resolveServedModel(settings)).toEqual(settings);
  });
});

describe.skipIf(!liveOCR)("ocrPages and probeOCREndpoint (live OCR endpoint)", () => {
  it(
    "reads every page in order and returns one outcome per page",
    async () => {
      const outcomes = await ocrPages([page1, page2], requireLiveOCR());
      expect(outcomes).toMatchObject([
        { ok: true, page: 1, text: expect.any(String) },
        { ok: true, page: 2, text: expect.any(String) },
      ]);
    },
    2 * LIVE_PAGE_TIMEOUT_MS,
  );

  it(
    "lists the model ids the endpoint serves",
    async () => {
      const result = await probeOCREndpoint(requireLiveOCR());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBeGreaterThan(0);
      expect(result.value.every((id) => typeof id === "string")).toBe(true);
    },
    30_000,
  );

  it(
    "re-spells a family-level id to the served spelling and re-reads the card from it",
    async () => {
      const live = requireLiveOCR();
      const served = await probeOCREndpoint(live);
      expect(served.ok).toBe(true);
      if (!served.ok) return;
      const servedId = served.value[0];

      const resolved = await resolveServedModel({ ...live, model: servedId.slice(0, -1) });
      const card = modelCardFor(servedId);
      expect(resolved).toMatchObject({
        model: servedId,
        prompt: card.prompt,
        params: card.params,
        render: card.render,
      });
    },
    30_000,
  );
});
