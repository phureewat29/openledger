/**
 * Suites needing a real OCR endpoint run under `describe.skipIf(!liveOCR)`:
 *
 *     TEST_OCR_BASE_URL=http://127.0.0.1:1234/v1 TEST_OCR_MODEL=<served-id> npm test
 *
 * Toolchain vars, read only by tests: the CLI itself reads no env configuration.
 */

import { resolveOCR, type OCRConfigSource, type OCRSettings } from "../src/extract/ocr.js";

const liveOCRSource: OCRConfigSource = {
  ocrBaseUrl: process.env.TEST_OCR_BASE_URL || "",
  ocrModel: process.env.TEST_OCR_MODEL || "",
  ocrApiKey: process.env.TEST_OCR_API_KEY || "",
};

export const liveOCR: OCRSettings | null = resolveOCR(liveOCRSource);

/** The url alone decides whether OCR is configured; half-set env is a mistake and must not read as a clean skip. */
if (!liveOCR && liveOCRSource.ocrModel) {
  throw new Error("TEST_OCR_MODEL is set without TEST_OCR_BASE_URL: the live OCR suites would skip silently");
}

/** `skipIf` does not narrow `liveOCR`, so the live cases reach it through here. */
export function requireLiveOCR(): OCRSettings {
  if (!liveOCR) throw new Error("no live OCR endpoint: set TEST_OCR_BASE_URL");
  return liveOCR;
}

/** Live subprocess suites merge this into the sandbox's config.json (writeConfig); there is no env to inject. */
export function requireLiveOCRSource(): OCRConfigSource {
  requireLiveOCR();
  return liveOCRSource;
}

/** Binding port 1 needs root, so a connect there is reliably refused: at once on POSIX, after about 2s on Windows. */
export const DEAD_OCR_BASE_URL = "http://127.0.0.1:1/v1";

/** Vitest timeout for a test that dials the dead endpoint twice (probe, then a page). */
export const DEAD_OCR_TEST_TIMEOUT_MS = 15_000;

/** The timeout outlasts Windows' slow refusal, so a refused connect never reads as a timeout. */
export function deadOCRSettings(over: Partial<OCRSettings> = {}): OCRSettings {
  return {
    baseURL: DEAD_OCR_BASE_URL,
    model: "test-ocr-model",
    apiKey: "",
    timeoutMs: 10_000,
    prompt: "read the page",
    params: { temperature: 0, top_p: 1, max_tokens: 256, seed: 7 },
    render: { dpi: 72, maxLongestDimPx: 1024 },
    ...over,
  };
}

/** A small local model can spend minutes on one dense page. */
export const LIVE_PAGE_TIMEOUT_MS = 180_000;
