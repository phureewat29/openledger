import { describe, it, expect } from "vitest";
import * as z from "zod";
import { str, num, int, bool, json, isoDate, parseInput, safeParse, ValidationError } from "./validate.js";

describe("validate: defaults", () => {
  it("uses the default when the key is absent", () => {
    expect(parseInput(z.object({ currency: str().default("THB") }), {}).currency).toBe("THB");
  });

  it("prefers the provided value over the default", () => {
    expect(
      parseInput(z.object({ currency: str().default("THB") }), { currency: "USD" }).currency,
    ).toBe("USD");
  });
});

describe("validate: required accumulation", () => {
  it("lists every missing required field in one message, exact format", () => {
    const spec = z.object({ id: str(), name: str(), type: str() });
    expect(safeParse(spec, {})).toEqual({ ok: false, error: "--id, --name, --type required" });
  });

  it("derives the default label from the key (underscores to dashes)", () => {
    expect(safeParse(z.object({ due_day: int() }), {})).toEqual({
      ok: false,
      error: "--due-day required",
    });
  });

  it("accumulates coercion failures alongside missing-required, in key order", () => {
    const spec = z.object({ id: str(), amount: num() });
    expect(safeParse(spec, { amount: "abc" })).toEqual({
      ok: false,
      error: '--id required; --amount must be a number, got "abc"',
    });
  });
});

describe("validate: coercions", () => {
  it("coerces numbers and reports non-numbers", () => {
    expect(parseInput(z.object({ amount: num() }), { amount: "12.5" }).amount).toBe(12.5);
    expect(safeParse(z.object({ amount: num() }), { amount: "abc" })).toEqual({
      ok: false,
      error: '--amount must be a number, got "abc"',
    });
  });

  it("coerces integers and rejects non-integers with the integer message", () => {
    expect(parseInput(z.object({ n: int() }), { n: "7" }).n).toBe(7);
    expect(safeParse(z.object({ n: int() }), { n: "7.5" })).toEqual({
      ok: false,
      error: '--n must be an integer, got "7.5"',
    });
  });

  it("accepts real booleans and the strings true/false", () => {
    expect(parseInput(z.object({ f: bool() }), { f: true }).f).toBe(true);
    expect(parseInput(z.object({ f: bool() }), { f: "true" }).f).toBe(true);
    expect(parseInput(z.object({ f: bool() }), { f: "false" }).f).toBe(false);
    expect(safeParse(z.object({ f: bool() }), { f: "maybe" })).toEqual({
      ok: false,
      error: '--f must be a boolean, got "maybe"',
    });
  });

  it("coerces numbers, booleans and bigints to strings", () => {
    const spec = z.object({ s: str() });
    expect(parseInput(spec, { s: 5 }).s).toBe("5");
    expect(parseInput(spec, { s: false }).s).toBe("false");
    expect(parseInput(spec, { s: 5n }).s).toBe("5");
  });

  it("rejects objects and arrays as a string, echoing JSON", () => {
    const spec = z.object({ s: str() });
    expect(safeParse(spec, { s: { id: "sf-1" } })).toEqual({
      ok: false,
      error: '--s must be a string, got "{"id":"sf-1"}"',
    });
    expect(safeParse(spec, { s: [1, 2] })).toEqual({ ok: false, error: '--s must be a string, got "[1,2]"' });
  });

  it("reads a JSON null as absent where the field cannot hold null", () => {
    expect(safeParse(z.object({ s: str() }), { s: null })).toEqual({ ok: false, error: "--s required" });
    expect(parseInput(z.object({ s: str().default("") }), { s: null }).s).toBe("");
    expect(Object.keys(parseInput(z.object({ s: str().optional() }), { s: null }))).toEqual([]);
    expect(parseInput(z.object({ s: str().nullable().default("x") }), { s: null }).s).toBeNull();
  });

  it("converts only numbers and non-blank numeric strings to numbers", () => {
    const spec = z.object({ n: num() });
    expect(parseInput(spec, { n: "12.5" }).n).toBe(12.5);
    expect(parseInput(spec, { n: 3 }).n).toBe(3);
    for (const [raw, echo] of [["", ""], ["  ", "  "], [true, "true"], [[], "[]"]] as const) {
      expect(safeParse(spec, { n: raw })).toEqual({ ok: false, error: `--n must be a number, got "${echo}"` });
    }
  });

  it("truncates a long echoed object", () => {
    const bad = safeParse(z.object({ s: str() }), { s: { text: "x".repeat(100) } });
    expect(bad).toEqual({ ok: false, error: `--s must be a string, got "{"text":"${"x".repeat(51)}…"` });
  });

  it("echoes an object as JSON in number and enum clauses too", () => {
    expect(safeParse(z.object({ n: num() }), { n: {} })).toEqual({ ok: false, error: '--n must be a number, got "{}"' });
    expect(safeParse(z.object({ t: z.enum(["a", "b"]) }), { t: { x: 1 } })).toEqual({
      ok: false,
      error: '--t must be one of a, b, got "{"x":1}"',
    });
  });

  it("parses JSON strings and passes already-parsed values through", () => {
    const spec = z.object({ m: json(z.record(z.string(), z.unknown()), "a JSON object") });
    expect(parseInput(spec, { m: '{"a":1}' }).m).toEqual({ a: 1 });
    expect(parseInput(spec, { m: { a: 1 } }).m).toEqual({ a: 1 });
    const bad = safeParse(spec, { m: "{bad" });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error).toMatch(/^--m must be valid JSON: /);
  });

  it("rejects well-formed JSON of the wrong shape with the expected clause", () => {
    const spec = z.object({ m: json(z.record(z.string(), z.unknown()), "a JSON object") });
    for (const raw of ['"abc"', "5", "[1,2]", "null"]) {
      expect(safeParse(spec, { m: raw })).toEqual({ ok: false, error: "--m must be a JSON object" });
    }
  });

  it("accepts a YYYY-MM-DD date and echoes any other shape in the date clause", () => {
    const spec = z.object({ date: isoDate().optional() });
    expect(parseInput(spec, { date: "2026-01-31" }).date).toBe("2026-01-31");
    for (const raw of ["2026/01/31", "2026-1-31", ""]) {
      expect(safeParse(spec, { date: raw })).toEqual({
        ok: false,
        error: `--date must be an ISO date (YYYY-MM-DD), got "${raw}"`,
      });
    }
    expect(safeParse(spec, { date: ["2026-01-31"] })).toEqual({
      ok: false,
      error: '--date must be a string, got "["2026-01-31"]"',
    });
  });
});

describe("validate: nullable", () => {
  it("passes explicit null through and does not call map", () => {
    let called = false;
    const spec = z.object({
      due_day: int()
        .transform((v) => {
          called = true;
          return v * 2;
        })
        .nullable(),
    });
    const parsed = parseInput(spec, { due_day: null });
    expect(parsed.due_day).toBeNull();
    expect(called).toBe(false);
  });

  it("treats the string \"null\" as a normal value, not null", () => {
    expect(parseInput(z.object({ name: str().nullable() }), { name: "null" }).name).toBe("null");
  });
});

describe("validate: optional", () => {
  it("omits an absent optional key entirely", () => {
    const parsed = parseInput(z.object({ name: str().optional() }), {});
    expect(Object.keys(parsed)).toEqual([]);
  });
});

describe("validate: oneOf", () => {
  it("rejects a non-member with the join-formatted message", () => {
    expect(safeParse(z.object({ type: z.enum(["asset", "liability"]) }), { type: "bogus" })).toEqual({
      ok: false,
      error: '--type must be one of asset, liability, got "bogus"',
    });
  });
});

describe("validate: key resolution", () => {
  it("reads an explicit alias", () => {
    const spec = z.object({ debit_account_id: str() });
    expect(
      parseInput(spec, { debit_account: "acc:1" }, { aliases: { debit_account_id: ["debit_account"] } })
        .debit_account_id,
    ).toBe("acc:1");
  });

  it("auto-bridges a camelCase raw key to a snake_case spec key", () => {
    expect(parseInput(z.object({ due_day: int() }), { dueDay: "20" }).due_day).toBe(20);
  });
});

describe("validate: map", () => {
  it("applies map to present values", () => {
    expect(parseInput(z.object({ due_day: int().transform((v) => v * 2) }), { due_day: "10" }).due_day).toBe(
      20,
    );
  });
});

describe("validate: atLeastOne", () => {
  const spec = z.object({ name: str().optional(), due_day: int().optional() });
  const msg = "at least one of --name, --due-day is required";

  it("throws when the parsed object has no keys", () => {
    expect(() => parseInput(spec, {}, { atLeastOne: msg })).toThrowError(msg);
  });

  it("passes when at least one field is present", () => {
    expect(parseInput(spec, { name: "x" }, { atLeastOne: msg })).toEqual({ name: "x" });
  });

  it("does not count a required key", () => {
    const targeted = spec.extend({ id: str() });
    expect(() => parseInput(targeted, { id: "m:1" }, { atLeastOne: msg })).toThrowError(msg);
    expect(parseInput(targeted, { id: "m:1", due_day: "3" }, { atLeastOne: msg })).toEqual({ id: "m:1", due_day: 3 });
  });

  it("counts a defaulted key only when the input supplies it", () => {
    const defaulted = z.object({ name: str().optional(), limit: int().default(10) });
    expect(() => parseInput(defaulted, {}, { atLeastOne: msg })).toThrowError(msg);
    expect(parseInput(defaulted, { limit: "5" }, { atLeastOne: msg })).toEqual({ limit: 5 });
  });
});

describe("validate: entry-point shapes", () => {
  it("safeParse returns an ok Result on success", () => {
    expect(safeParse(z.object({ name: str() }), { name: "x" })).toEqual({
      ok: true,
      value: { name: "x" },
    });
  });

  it("parseInput throws a ValidationError listing all failures", () => {
    const spec = z.object({ id: str(), name: str(), type: str() });
    try {
      parseInput(spec, {});
      expect.unreachable("parseInput should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).message).toBe("--id, --name, --type required");
    }
  });
});
