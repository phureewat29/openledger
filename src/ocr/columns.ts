/** Ported from line_engine.py (Apache-2.0). */

import { countBy, median, sum } from "es-toolkit";
import { mean } from "./numeric.js";
import { COLS } from "./settings.js";
import { DIGIT_CHARS, DIGITS } from "./text-classes.js";
import { PY_SPACE, pyStrip } from "./thai-norm.js";

/** x min, x max, y min, y max of a box in the frame the page is cut in. */
export type Extent = readonly [number, number, number, number];

export interface Layout {
  ext: readonly Extent[];
  hmed: number;
  /** The raw line readings; without them the column tests look at geometry alone. */
  texts?: readonly string[];
}

const SPACE_CLASS = `[${PY_SPACE}]`;
const SPACE = new RegExp(SPACE_CLASS, "u");
const DIGIT = `[${DIGIT_CHARS}]`;
const ENUM = new RegExp(`^${SPACE_CLASS}*\\(?(${DIGIT}{1,4})${SPACE_CLASS}*[.)]`, "u");
const DIGIT_RUN = new RegExp(`${DIGIT}+`, "gu");

const enumNumber = (text: string): number | undefined => {
  const m = text.match(ENUM);
  return m ? Number(Array.from(m[1], (d) => DIGIT_CHARS.indexOf(d) % 10).join("")) : undefined;
};

/** A column of prose: enough long lines, many filling the column width, few digits, and no line repeated. */
export function isProse(col: readonly number[], { ext, hmed, texts }: Layout): boolean {
  if (col.length < 12) return false;
  const widths = col.map((i) => ext[i][1] - ext[i][0]);
  const span = Math.max(...col.map((i) => ext[i][1])) - Math.min(...col.map((i) => ext[i][0]));
  if (median(widths) < 7 * hmed) return false;
  if (widths.filter((w) => w >= 0.75 * span).length / widths.length < 0.35) return false;
  if (!texts) return true;
  const chars = col.flatMap((i) => Array.from(texts[i])).filter((ch) => !SPACE.test(ch));
  if (chars.length > 0 && chars.filter((ch) => DIGITS.has(ch)).length > 0.3 * chars.length) return false;
  return new Set(col.map((i) => pyStrip(texts[i]))).size >= 0.8 * col.length;
}

/** Most facing lines numbered n on the left and n+1 on the right: a list that reads across. */
function numberedAcross(lcol: readonly number[], rcol: readonly number[], { ext, hmed, texts }: Layout): boolean {
  if (!texts) return false;
  const middle = (i: number) => (ext[i][2] + ext[i][3]) / 2;
  const pairs = lcol.filter((i) => {
    const n = enumNumber(texts[i]);
    if (n === undefined) return false;
    return rcol.some((j) => enumNumber(texts[j]) === n + 1 && Math.abs(middle(j) - middle(i)) <= 0.5 * hmed);
  }).length;
  return pairs >= 0.5 * Math.min(lcol.length, rcol.length);
}

/** Share of lines whose first three characters, a digit run counted as one, are one of the two most common starts. */
export function startRep(lines: readonly string[]): number {
  const starts = lines
    .map(pyStrip)
    .filter(Boolean)
    .map((line) => Array.from(line.replace(DIGIT_RUN, "D")).slice(0, 3).join(""));
  if (starts.length === 0) return 0;
  const top = Object.values(countBy(starts, (start) => start)).toSorted((a, b) => b - a);
  return sum(top.slice(0, 2)) / starts.length;
}

/** Two sides of a gap whose lines start alike (names, positions, "label : value", numbers) are a list read row by row. */
export function isListPair(lcol: readonly number[], rcol: readonly number[], { texts }: Layout): boolean {
  if (!texts) return false;
  const rep = (col: readonly number[]) => startRep(col.map((i) => texts[i]));
  return mean([rep(lcol), rep(rcol)]) >= COLS.listRep;
}

/** A gap between two prose columns, read one after the other, rather than a table, a list or a list numbered across. */
export const shouldCutBetween = (lcol: readonly number[], rcol: readonly number[], layout: Layout): boolean =>
  isProse(lcol, layout) && isProse(rcol, layout) && !numberedAcross(lcol, rcol, layout) && !isListPair(lcol, rcol, layout);
