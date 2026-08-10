import { describe, expect, it } from "vitest";
import { levenshtein } from "./distance.js";

describe("levenshtein", () => {
  it("is zero for identical strings, including empty", () => {
    expect(levenshtein("commit", "commit")).toBe(0);
    expect(levenshtein("", "")).toBe(0);
  });

  it("counts a single insertion, deletion, or substitution as one edit", () => {
    expect(levenshtein("account", "accounts")).toBe(1);
    expect(levenshtein("accounts", "account")).toBe(1);
    expect(levenshtein("comit", "commit")).toBe(1);
    expect(levenshtein("cat", "cot")).toBe(1);
  });

  it("falls back to the other string's length against an empty string", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("is far apart for unrelated strings", () => {
    expect(levenshtein("bogus", "status")).toBe(4);
  });
});
