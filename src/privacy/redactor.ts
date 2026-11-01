import { escapeRegExp, uniqBy } from "es-toolkit";
import { readContext } from "../config/context.js";
import { homeRelative, relativizeHomeIn } from "../lib/path.js";

/** Where redaction terms come from: the configured user plus their context.md. */
export interface RedactionSource {
  userName: string;
  contextPath: string;
}

interface RedactionEntry {
  real: string;
  token: string;
}

interface SectionRule {
  heading: string;
  token: string;
  patterns: RegExp[];
  /** Trim a trailing parenthesised qualifier, e.g. "Corgi (partner)" becomes "Corgi". */
  stripParen?: boolean;
  skipIfUser?: boolean;
}

const SECTION_RULES: SectionRule[] = [
  {
    heading: "Family",
    token: "[PARTNER]",
    stripParen: true,
    skipIfUser: true,
    patterns: [
      /^(?:partner|spouse|wife|husband|child|kid|son|daughter|dependent)[:\s]+(.+)/i,
      /^([\p{Lu}\p{Lo}][\p{L}\s]+)/u,
    ],
  },
  {
    heading: "Income",
    token: "[EMPLOYER]",
    patterns: [
      /(?:employer|works? (?:at|for)|employed (?:at|by))[:\s]+([A-Z][\w\s&.,-]+?)(?:\s*[-–—|,;(\n]|$)/i,
      /\bfrom ([A-Z][A-Za-z\s&.,-]+?)(?:\s*[-–—|,;(\n]|$)/,
      /\bat ([A-Z][A-Za-z\s&.,-]+?)(?:\s*[-–—|,;(\n]|$)/,
    ],
  },
];

const NUMERIC_PII_PATTERNS: [RegExp, string][] = [
  // Thai national ID with dashes: 1-2345-67890-12-3
  [/\b\d-\d{4}-\d{5}-\d{2}-\d\b/g, "[NATID]"],
  // Thai national ID without dashes (13 digits): must precede the generic ACCT pattern.
  [/\b\d{13}\b/g, "[NATID]"],
  // Thai mobile numbers: 0[689]xxxxxxxx (10 digits starting 06/08/09)
  [/\b0[689]\d{8}\b/g, "[PHONE]"],
  // 16-digit credit card (with optional separators)
  [/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, "[CARD]"],
  // 10-12 digit account / routing numbers at a word boundary
  [/\b\d{10,12}\b(?=\s|$|[,.])/g, "[ACCT]"],
];

function extractSectionLines(context: string, heading: string): string[] {
  const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n##|$)`);
  const match = context.match(re);
  if (!match) return [];
  return match[1]
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .map((l) => l.replace(/^-\s*/, "").trim())
    .filter((text) => text.length > 0 && !text.startsWith("("));
}

function nameFrom(rule: SectionRule, line: string, userName: string): string | null {
  const match = rule.patterns.map((pattern) => line.match(pattern)).find((m) => m !== null);
  if (!match) return null;
  const captured = match[1].trim();
  const name = rule.stripParen ? captured.replace(/\s*\(.*\)/, "").trim() : captured;
  if (!name) return null;
  if (rule.skipIfUser && name.toLowerCase() === userName.toLowerCase()) return null;
  // "user" must never become a redaction term: it seeds context.md's Family
  // section, and would rewrite the literal word elsewhere (e.g. file paths).
  if (name.toLowerCase() === "user") return null;
  return name;
}

function userEntries(userName: string): RedactionEntry[] {
  if (!userName || userName === "User") return [];
  const parts = userName.split(/\s+/);
  if (parts.length === 1) return [{ real: userName, token: "[USER]" }];
  return [
    { real: userName, token: "[USER]" },
    { real: parts[0], token: "[USER_FIRST]" },
    { real: parts[parts.length - 1], token: "[USER_LAST]" },
  ];
}

function buildRedactions(userName: string, context: string): RedactionEntry[] {
  const contextEntries = SECTION_RULES.flatMap((rule) =>
    extractSectionLines(context, rule.heading)
      .filter((line) => !(rule.skipIfUser && line.toLowerCase() === userName.toLowerCase()))
      .flatMap((line) => {
        const name = nameFrom(rule, line, userName);
        return name ? [{ real: name, token: rule.token }] : [];
      }),
  );

  const candidates = [...userEntries(userName), ...contextEntries].map(({ real, token }) => ({
    real: real.trim(),
    token,
  }));
  return uniqBy(
    candidates.filter(({ real }) => real.length >= 2),
    ({ real }) => real.toLowerCase(),
  ).sort((a, b) => b.real.length - a.real.length);
}

/** `context` is context.md's text; a closure, so the patterns compile once per payload rather than once per field. */
export function createRedactor(userName: string, context: string): (text: string) => string {
  // ASCII lookarounds, not \b: Thai text has no spaces, so a Unicode letter
  // boundary would lose recall; this still blocks "User" matching inside "Users".
  const termPatterns = buildRedactions(userName, context).map(
    ({ real, token }): [RegExp, string] => [
      new RegExp("(?<![A-Za-z0-9_])" + escapeRegExp(real) + "(?![A-Za-z0-9_])", "gu"),
      token,
    ],
  );
  const patterns = [...termPatterns, ...NUMERIC_PII_PATTERNS];
  return (text: string): string =>
    patterns.reduce((result, [pattern, token]) => result.replace(pattern, token), text);
}

// Fails closed: running without context.md's terms would print the very names it lists.
function requireContext(contextPath: string): string {
  const context = readContext(contextPath);
  if (context.ok) return context.value;
  const shown = homeRelative(contextPath);
  throw new Error(
    `cannot read ${shown} (${relativizeHomeIn(context.error, contextPath)}), so redaction cannot run: fix the file, or pass --no-redact`,
  );
}

/** Redacts a string value only when its key is in the per-command `fields`
 *  allowlist; returns a fresh structure, a no-op when `enabled` is false. */
export function applyRedaction<T>(
  data: T,
  enabled: boolean,
  fields: readonly string[],
  source: RedactionSource,
): T {
  if (!enabled) return data;
  const redact = createRedactor(source.userName, requireContext(source.contextPath));
  const allow = new Set(fields);

  const walk = (value: unknown, key: string | undefined): unknown => {
    if (typeof value === "string") {
      return key !== undefined && allow.has(key) ? redact(value) : value;
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, key));
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
    }
    return value;
  };

  return walk(data, undefined) as T;
}
