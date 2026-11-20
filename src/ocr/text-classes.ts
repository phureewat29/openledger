/** Ported from line_engine.py (Apache-2.0); see THIRD_PARTY_NOTICES.md. */

import { PY_SPACE } from "./thai-norm.js";

/** Arabic and Thai digits. */
export const DIGIT_CHARS = "0123456789๐๑๒๓๔๕๖๗๘๙";
export const DIGITS: ReadonlySet<string> = new Set(DIGIT_CHARS);
/** Thai vowel and tone marks written above or below a consonant. */
const MARK_CHARS = "\u0E31\u0E34\u0E35\u0E36\u0E37\u0E38\u0E39\u0E3A\u0E47\u0E48\u0E49\u0E4A\u0E4B\u0E4C\u0E4D\u0E4E";
export const MARKS: ReadonlySet<string> = new Set(MARK_CHARS);
export const LATIN: ReadonlySet<string> = new Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");

/** Python's str.isdigit(): Unicode Nd plus the Unicode 15 digits outside it (superscripts, circled digits); the charset has both. */
const PY_DIGIT =
  /[\p{Nd}\u{B2}-\u{B3}\u{B9}\u{1369}-\u{1371}\u{19DA}\u{2070}\u{2074}-\u{2079}\u{2080}-\u{2089}\u{2460}-\u{2468}\u{2474}-\u{247C}\u{2488}-\u{2490}\u{24EA}\u{24F5}-\u{24FD}\u{24FF}\u{2776}-\u{277E}\u{2780}-\u{2788}\u{278A}-\u{2792}\u{10A40}-\u{10A43}\u{10E60}-\u{10E68}\u{11052}-\u{1105A}\u{1F100}-\u{1F10A}]/u;
const WORD = new RegExp(`[^${PY_SPACE}]+`, "gu");
const THAI_LETTER = /[\u0E01-\u0E4E]/u;
const ASCII_LETTER = /[A-Za-z]/g;
const MARK_OR_SPACE = new RegExp(`[${MARK_CHARS}${PY_SPACE}]`, "gu");

/** Latin letters inside words that also hold Thai letters ("lละพลNSะทU" has 4): a loopless Thai face read as Latin look-alikes. */
export const mixedLatin = (text: string): number =>
  (text.match(WORD) ?? []).filter((word) => THAI_LETTER.test(word)).reduce((n, word) => n + (word.match(ASCII_LETTER)?.length ?? 0), 0);

/** The digits of a reading, in order, as Python's str.isdigit() picks them. */
export const digitsOf = (text: string): string => Array.from(text).filter((ch) => PY_DIGIT.test(ch)).join("");

/** A reading without its above and below marks (sara am as its aa) and spaces: what a floating-mark re-read must leave unchanged. */
export const baseLetters = (text: string): string => text.replaceAll("\u0E33", "\u0E32").replace(MARK_OR_SPACE, "");
