/** A model card pairs a model's prescribed prompt, sampling, and render spec; this folder is the only place in src/ that names a model. */

import type { RenderSpec } from "../pdf.js";
import { fallbackModelCard } from "./fallback.js";
import { typhoonModelCard } from "./typhoon-ocr1.5.js";

/** Wire names: spread straight into the request body. */
export interface OCRParams {
  temperature: number;
  top_p: number;
  max_tokens: number;
  /** Set only where a fixed seed is prescribed; endpoints that ignore it are unaffected. */
  seed?: number;
}

export interface ModelCard {
  /** The model ids this card is written for, matched against the configured id. */
  family: RegExp;
  model: string;
  prompt: string;
  params: OCRParams;
  render: RenderSpec;
}

type ModelCardName = "typhoon" | "fallback";

/** Exhaustive by construction: a new ModelCardName breaks the build until it is listed. */
const MODEL_CARDS: Record<ModelCardName, ModelCard> = {
  typhoon: typhoonModelCard,
  fallback: fallbackModelCard,
};

/** Supplies the model when none is configured. */
const DEFAULT_MODEL_CARD: ModelCardName = "typhoon";

/** The model id `ocrModel` defaults to; the only spelling of it outside this folder. */
export const DEFAULT_MODEL_ID = MODEL_CARDS[DEFAULT_MODEL_CARD].model;

/** Any configured id no family claims. */
const FALLBACK_MODEL_CARD: ModelCardName = "fallback";

/** An empty id reads with the default model card and its own model; an id no family claims is sent as-is with the fallback card. */
export function modelCardFor(modelId: string): ModelCard {
  if (!modelId) return MODEL_CARDS[DEFAULT_MODEL_CARD];
  return (
    Object.values(MODEL_CARDS).find((card) => card.family.test(modelId)) ??
    MODEL_CARDS[FALLBACK_MODEL_CARD]
  );
}
