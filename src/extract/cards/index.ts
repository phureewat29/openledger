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
  model: string;
  prompt: string;
  params: OCRParams;
  render: RenderSpec;
}

export interface FamilyModelCard extends ModelCard {
  /** The model ids this card is written for, matched against the configured id. */
  family: RegExp;
}

const FAMILY_CARDS: readonly FamilyModelCard[] = [typhoonModelCard];

/** The model id `ocrModel` defaults to; the only spelling of it outside this folder. */
export const DEFAULT_MODEL_ID = typhoonModelCard.model;

/** An empty id reads with the default model's card; an id no family claims is sent as-is with the fallback card. */
export function modelCardFor(modelId: string): ModelCard {
  if (!modelId) return typhoonModelCard;
  return FAMILY_CARDS.find((card) => card.family.test(modelId)) ?? fallbackModelCard;
}
