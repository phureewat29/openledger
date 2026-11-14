/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

/** The bundled model's det.yml and config.json values over the runtime defaults. */
export const DET = {
  limit: 1280,
  thresh: 0.2,
  boxThresh: 0.4,
  unclip: 1.4,
  minSize: 3,
  maxCandidates: 3000,
  splitGap: 1.2,
} as const;

export const DET_MEAN = [0.485, 0.456, 0.406] as const;
export const DET_STD = [0.229, 0.224, 0.225] as const;

export const REC = {
  height: 48,
  maxWidth: 3200,
  batch: 16,
  dropBelow: 0.8,
  minChars: 2,
  junkBelow: 0.9,
  junkInvalid: 0.05,
} as const;

export const ORI = {
  sample: 8,
  flipBelow: 0.8,
  flipMargin: 0.15,
  deskewAbove: 2.5,
} as const;
