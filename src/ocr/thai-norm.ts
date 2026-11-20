/** Ported from thai_norm.py and line_engine.py (Apache-2.0). */

/** Legacy Thai glyph variants (shifted or lowered marks, tail-less ฐ ญ) to standard code points. */
const PUA: Readonly<Record<number, number>> = {
  0xf700: 0x0e10, 0xf701: 0x0e34, 0xf702: 0x0e35, 0xf703: 0x0e36, 0xf704: 0x0e37,
  0xf705: 0x0e48, 0xf706: 0x0e49, 0xf707: 0x0e4a, 0xf708: 0x0e4b, 0xf709: 0x0e4c,
  0xf70a: 0x0e48, 0xf70b: 0x0e49, 0xf70c: 0x0e4a, 0xf70d: 0x0e4b, 0xf70e: 0x0e4c,
  0xf70f: 0x0e0d, 0xf710: 0x0e31, 0xf711: 0x0e4d, 0xf712: 0x0e47, 0xf713: 0x0e48,
  0xf714: 0x0e49, 0xf715: 0x0e4a, 0xf716: 0x0e4b, 0xf717: 0x0e4c, 0xf718: 0x0e38,
  0xf719: 0x0e39, 0xf71a: 0x0e3a,
};

/** Zero-width characters, soft hyphen and BOM dropped; NBSP to a space; legacy glyph variants to standard Thai. */
const TRANSLATE: ReadonlyMap<number, string> = new Map([
  ...Object.entries(PUA).map(([from, to]): [number, string] => [Number(from), String.fromCodePoint(to)]),
  ...[0x200b, 0x200c, 0x200d, 0x2060, 0x00ad, 0xfeff].map((code): [number, string] => [code, ""]),
  [0x00a0, " "],
]);

const VOWEL_MARKS = "\u0E31\u0E34\u0E35\u0E36\u0E37\u0E3A\u0E38\u0E39\u0E47";
const TONE_MARKS = "\u0E48\u0E49\u0E4A\u0E4B\u0E4C\u0E4E";
const NIKHAHIT = "\u0E4D";
const MARK_RANK: ReadonlyMap<string, number> = new Map([
  ...Array.from(VOWEL_MARKS, (ch): [string, number] => [ch, 0]),
  ...Array.from(TONE_MARKS, (ch): [string, number] => [ch, 1]),
  [NIKHAHIT, 2],
]);

const MARK_RUN = new RegExp(`[${VOWEL_MARKS}${TONE_MARKS}${NIKHAHIT}]{2,}`, "gu");
const SARA_AM = /([\u0E48-\u0E4B]?)\u0E4D([\u0E48-\u0E4B]?)\u0E32/gu;
const SPACES = /[ \t\f\v]+/gu;
/** Python's str.isspace() set, which str.strip() trims. */
export const PY_SPACE = "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const EDGE_SPACE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");

const LONE_W = /(?<![A-Za-z])[Ww](?=\.?[\u0E01-\u0E2E\u0E40-\u0E44])/gu;
const ZERO_IN_THAI = /(?<=[\u0E50-\u0E59])[Oo0]|[Oo0](?=[\u0E50-\u0E59])/gu;
/** Python's re `\d` on str is any Unicode Nd digit, Thai ones included. */
const DECIMAL_COMMA = /(?<![\p{Nd}.,])(\p{Nd}{1,3}(?:,\p{Nd}{3})*),(\p{Nd}{2})(?![\p{Nd}.,])/gu;

const translate = (text: string): string => Array.from(text, (ch) => TRANSLATE.get(ch.codePointAt(0) ?? 0) ?? ch).join("");

/** A run of marks in one order (vowel, tone, nikhahit), a doubled mark kept once since it renders as one. */
function orderMarks(run: string): string {
  const rank = (ch: string) => MARK_RANK.get(ch) ?? 0;
  const sorted = Array.from(run).sort((a, b) => rank(a) - rank(b));
  return sorted.filter((ch, i) => i === 0 || sorted[i - 1] !== ch).join("");
}

export const pyStrip = (text: string): string => text.replace(EDGE_SPACE, "");

/** One canonical spelling for Thai text, so equal renderings compare equal. */
export function canonical(text: string): string {
  const normalized = translate(text)
    .normalize("NFC")
    .replace(MARK_RUN, orderMarks)
    .replace(SARA_AM, (_, before: string, after: string) => `${before}${after}\u0E33`)
    .replaceAll("\u0E40\u0E40", "\u0E41")
    .replaceAll("\u0E33\u0E33", "\u0E33")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  return pyStrip(
    normalized
      .split("\n")
      .map((line) => pyStrip(line.replace(SPACES, " ")))
      .join("\n"),
  );
}

/** Look-alikes no real Thai text contains: a Latin W glued to Thai letters (a bold พ), a Latin O or digit zero inside Thai digits. */
export const fixScripts = (text: string): string => text.replace(LONE_W, "\u0E1E").replace(ZERO_IN_THAI, "\u0E50");

/** A raw reading as the line filter judges it: canonical, look-alikes fixed. */
export const normalizeReading = (raw: string): string => fixScripts(canonical(raw));

/** A whole amount whose last comma has exactly two digits after it ("88,226,21", "280,00") gets a decimal point. */
export const fixDecimalCommas = (text: string): string => text.replace(DECIMAL_COMMA, "$1.$2");
