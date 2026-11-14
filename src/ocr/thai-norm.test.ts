import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonical, fixScripts } from "./thai-norm.js";

interface NormCase {
  input: string;
  canonical: string;
  fixed: string;
}

const { cases: CASES } = JSON.parse(
  readFileSync(new URL("../../fixtures/ocr/thai-norm.json", import.meta.url), "utf8"),
) as { cases: NormCase[] };

describe("thai-norm", () => {
  it("matches the golden canonical form and script fix-ups", () => {
    const mismatches = CASES.filter((c) => canonical(c.input) !== c.canonical || fixScripts(canonical(c.input)) !== c.fixed);
    expect(CASES.length).toBeGreaterThan(600);
    expect(mismatches).toEqual([]);
  });
});
