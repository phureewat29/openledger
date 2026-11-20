/** Ported from line_engine.py (Apache-2.0). */

import { extent, lineHeight, quadHeight, type Quad } from "./geometry/quad.js";
import { codePointLength, f32 } from "./numeric.js";
import { REC } from "./settings.js";
import { DIGITS, LATIN, MARKS } from "./text-classes.js";

const LEADING = new Set("\u0E40\u0E41\u0E42\u0E43\u0E44");
const isThai = (ch: string): boolean => ch >= "\u0E00" && ch <= "\u0E7F";
const isConsonant = (ch: string | undefined): boolean => ch !== undefined && ch >= "\u0E01" && ch <= "\u0E2E";

/**
 * Share of Thai characters that break Thai spelling: a mark with no consonant under it, or a leading vowel not
 * followed by a consonant. Stamps, seals and signatures score high; real text in an unfamiliar font near zero.
 */
export function invalidShare(text: string): number {
  const chars = Array.from(text);
  let thai = 0;
  let bad = 0;
  chars.forEach((ch, i) => {
    if (!isThai(ch)) return;
    thai += 1;
    const prev = i > 0 ? chars[i - 1] : " ";
    if (MARKS.has(ch)) {
      if (!(isConsonant(prev) || (MARKS.has(prev) && i >= 2 && isConsonant(chars[i - 2])))) bad += 1;
      return;
    }
    if (LEADING.has(ch) && !isConsonant(chars[i + 1])) bad += 1;
  });
  return thai ? bad / thai : 0;
}

export const nonSpaceLength = (text: string): number => codePointLength(text.replaceAll(" ", ""));

/**
 * Boxes that are pieces of a neighbouring line (a stacked mark or a tail detected on its own): at most three
 * characters, under 35 % of the line height, and touching a full-height line above or below.
 */
export function fragments(boxes: readonly Quad[], texts: readonly string[]): Set<number> {
  if (boxes.length < 3) return new Set();
  const hs = boxes.map(quadHeight);
  const hmed = lineHeight(boxes);
  const reach = f32(0.5 * hmed);
  const ext = boxes.map(extent);
  const touches = (i: number, j: number): boolean => {
    const [x0, x1, y0, y1] = ext[i];
    const [cx0, cx1, cy0, cy1] = ext[j];
    return cx0 <= x1 && x0 <= cx1 && Math.min(Math.abs(f32(y0 - cy1)), Math.abs(f32(cy0 - y1))) <= reach;
  };
  const small = (i: number) => hs[i] < 0.35 * hmed && nonSpaceLength(texts[i] ?? "") <= 3;
  return new Set(
    boxes
      .map((_, i) => i)
      .filter((i) => small(i) && boxes.some((_, j) => j !== i && hs[j] >= 0.6 * hmed && touches(i, j))),
  );
}

export type DropReason = "empty" | "low_confidence" | "too_short" | "invalid_thai";

const CELL_CHARS: ReadonlySet<string> = new Set([...DIGITS, ...LATIN]);

/** A table cell's lone "2" or "M" is not junk when its box is tall enough; a floating mark read as "9" or "๘" is shorter. */
function minChars(text: string, heightRatio: number | undefined): number {
  const bare = Array.from(text.replaceAll(" ", ""));
  const cell = bare.length > 0 && bare.every((ch) => CELL_CHARS.has(ch)) && (heightRatio ?? 0) >= REC.minCharsDigitsHeight;
  return cell ? REC.minCharsDigits : REC.minChars;
}

/**
 * Why a canonical, script-fixed reading is dropped (stamps, seals, signatures, stray marks), or undefined to keep it.
 * `heightRatio` is the box's height over the page's line height; without it the one-character exception never applies.
 */
export function dropReason(text: string, confidence: number, heightRatio?: number): DropReason | undefined {
  if (!text) return "empty";
  if (confidence < REC.dropBelow) return "low_confidence";
  if (nonSpaceLength(text) < minChars(text, heightRatio)) return "too_short";
  if (confidence < REC.junkBelow && invalidShare(text) > REC.junkInvalid) return "invalid_thai";
  return undefined;
}
