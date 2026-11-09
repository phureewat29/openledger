import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";

import {
  countAccounts,
  findAccountById,
  insertStructuralAccount,
  updateAccountMetadata,
} from "./queries.js";
import { freshDB, seedAccount } from "../../fixtures/db.js";

describe("insertStructuralAccount", () => {
  it("swallows a lost race on the id: the winner's row stands, no UNIQUE escapes", () => {
    // Every caller checks findAccountById first, so a second insert here is a concurrent writer having won in between.
    const db = freshDB();
    const root = { id: "thb:asset", name: "Assets (THB)", type: "asset", parent_id: null } as const;
    insertStructuralAccount(db, { ...root });

    expect(() =>
      insertStructuralAccount(db, { ...root, name: "Assets (THB), later writer" }),
    ).not.toThrow();
    expect(findAccountById(db, "thb:asset")!.name).toBe("Assets (THB)");
    expect(countAccounts(db)).toBe(1);
  });
});

describe("updateAccountMetadata", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDB();
    seedAccount(db, { id: "thb:liability:ktc", name: "KTC Card", bank_name: "ktc", due_day: 15 });
  });

  function updated(patch: Parameters<typeof updateAccountMetadata>[2]) {
    const result = updateAccountMetadata(db, "thb:liability:ktc", patch);
    if (!result.ok) throw new Error(`refused: ${result.message}`);
    return result;
  }

  it("returns before/after for changed fields", () => {
    const result = updated({ due_day: 20, statement_day: 28 });
    expect(Object.keys(result.after).length).toBeGreaterThan(0);
    expect(result.before.due_day).toBe(15);
    expect(result.after.due_day).toBe(20);
    expect(result.before.statement_day).toBeNull();
    expect(result.after.statement_day).toBe(28);
  });

  it("reports no change when patch is empty", () => {
    expect(Object.keys(updated({}).after).length).toBe(0);
  });

  it("shallow-merges metadata into the existing blob", () => {
    updated({ metadata: { points_program: "Forever" } });
    updated({ metadata: { points_balance: 1200 } });
    const row = findAccountById(db, "thb:liability:ktc")!;
    expect(JSON.parse(row.metadata_json!)).toEqual({
      points_program: "Forever",
      points_balance: 1200,
    });
  });

  it("stores an empty bank name as NULL, the same rule create applies", () => {
    seedAccount(db, { id: "thb:asset:cash", bank_name: "" });
    expect(findAccountById(db, "thb:asset:cash")!.bank_name).toBeNull();

    expect(updated({ bank_name: "" })).toMatchObject({
      before: { bank_name: "KTC" },
      after: { bank_name: null },
    });
    expect(findAccountById(db, "thb:liability:ktc")!.bank_name).toBeNull();
  });

  it("normalizes a masked number's check digit on the way in", () => {
    updated({ account_number_masked: "••7652-0" });
    expect(findAccountById(db, "thb:liability:ktc")!.account_number_masked).toBe("••7652");
  });

  it("refuses an unknown account as not_found", () => {
    expect(updateAccountMetadata(db, "thb:asset:nope", { due_day: 1 })).toEqual({
      ok: false,
      reason: "not_found",
      message: 'Account "thb:asset:nope" not found.',
    });
  });

  it("refuses to overwrite a metadata blob it cannot read", () => {
    db.prepare(`UPDATE accounts SET metadata_json = '"abc"' WHERE id = 'thb:liability:ktc'`).run();
    expect(updateAccountMetadata(db, "thb:liability:ktc", { metadata: { x: 1 } })).toEqual({
      ok: false,
      reason: "unreadable_metadata",
      message: 'Account "thb:liability:ktc" has unreadable metadata_json; refusing to overwrite it.',
    });
  });
});
