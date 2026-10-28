import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "libsql";
import {
  upsertMerchant,
  findMerchantByAlias,
  findMerchantById,
  listMerchants,
  renameMerchant,
  setMerchantDefaultAccount,
  mergeMerchants,
  normalizeDescriptor,
} from "./queries.js";

import { insertTransaction, type TransactionInput } from "../transactions/queries.js";
import { freshDb, seedAccount } from "../../fixtures/db.js";

function seedChartOfAccounts(db: Database.Database): void {
  seedAccount(db, { id: "thb:expense:food" });
  seedAccount(db, { id: "thb:expense:food:dining" });
  seedAccount(db, { id: "thb:asset:cash" });
}

/** Spelled out, not read from `datasets/th.json`: editing that data must not
 *  change what this file asserts about the algorithm. */
const TH_NOISE = ["bangkok", "bkk", "th", "tha", "thailand"];

function tf(over: Partial<TransactionInput> = {}): TransactionInput {
  return {
    date: "2026-05-01",
    description: "Coffee",
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    amount: 15000,
    ...over,
  };
}

describe("normalizeDescriptor", () => {
  it("strips trailing #1234-style store ids", () => {
    expect(normalizeDescriptor("STARBUCKS #1234", TH_NOISE)).toBe("starbucks");
    expect(normalizeDescriptor("Starbucks #5678 BANGKOK", TH_NOISE)).toBe("starbucks");
  });

  it("strips common location and transaction tokens", () => {
    expect(normalizeDescriptor("AMAZON WEB CHARGE", TH_NOISE)).toBe("amazon");
    expect(normalizeDescriptor("LAZADA TH POS PAYMENT", TH_NOISE)).toBe("lazada");
  });

  it("collapses whitespace and lowercases", () => {
    expect(normalizeDescriptor("  HOME   DEPOT  ", TH_NOISE)).toBe("home depot");
  });

  it("keeps a word no list names, however place-like it reads", () => {
    expect(normalizeDescriptor("STARBUCKS SILOM CHARGE", TH_NOISE)).toBe("starbucks silom");
  });

  it("strips the locale's place words only when that locale's tokens are passed", () => {
    expect(normalizeDescriptor("LAZADA BANGKOK POS", [])).toBe("lazada bangkok");
    expect(normalizeDescriptor("LAZADA POS", [])).toBe("lazada");
  });

  it("returns empty string for empty input", () => {
    expect(normalizeDescriptor("", TH_NOISE)).toBe("");
    expect(normalizeDescriptor("  ", TH_NOISE)).toBe("");
  });
});

describe("upsertMerchant", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("inserts a new merchant the first time", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    expect(m.id).toMatch(/^m:/);
    expect(m.canonical_name).toBe("Starbucks");
    expect(m.default_account_id).toBeNull();
  });

  it("returns the stored created_at, not one fabricated from the JS clock", () => {
    // A frozen Date diverges from SQLite's own `now`, so a fabricated timestamp cannot pass.
    vi.useFakeTimers({ now: new Date("2020-01-01T00:00:00Z"), toFake: ["Date"] });
    try {
      const m = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
      expect(m.created_at).toBe(findMerchantById(db, m.id)!.created_at);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the same merchant on second upsert by canonical_name", () => {
    const a = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    const b = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    expect(b.id).toBe(a.id);
  });

  it("updates default_account_id on subsequent upsert", () => {
    upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    const updated = upsertMerchant(db, {
      canonical_name: "Starbucks",
      default_account_id: "thb:expense:food:dining",
    }, TH_NOISE);
    expect(updated.default_account_id).toBe("thb:expense:food:dining");
  });

  it("inserts an alias when provided, deduped on normalized_pattern", () => {
    upsertMerchant(db, { canonical_name: "Starbucks", alias: "STARBUCKS #1234" }, TH_NOISE);
    upsertMerchant(db, { canonical_name: "Starbucks", alias: "STARBUCKS #5678" }, TH_NOISE);
    const aliases = db.prepare(`SELECT normalized_pattern FROM merchant_aliases`).all() as { normalized_pattern: string }[];
    expect(aliases.map(a => a.normalized_pattern).sort()).toEqual(["starbucks"]);
  });

  it("reports alias_conflict and leaves the alias on its current owner when it belongs to another merchant", () => {
    upsertMerchant(db, { canonical_name: "Starbucks", alias: "STARBUCKS #1234" }, TH_NOISE);
    const amazon = upsertMerchant(db, { canonical_name: "Amazon", alias: "STARBUCKS #5678" }, TH_NOISE);
    expect(amazon.alias_conflict).toEqual({ pattern: "starbucks", held_by: expect.stringMatching(/^m:/) });
    const owner = db
      .prepare(`SELECT merchant_id FROM merchant_aliases WHERE normalized_pattern = 'starbucks'`)
      .get() as { merchant_id: string };
    expect(owner.merchant_id).not.toBe(amazon.id);
    expect(owner.merchant_id).toBe(amazon.alias_conflict!.held_by);
  });

  it("stays a silent no-op (no alias_conflict) when the alias already belongs to the same merchant", () => {
    const first = upsertMerchant(db, { canonical_name: "Starbucks", alias: "STARBUCKS #1234" }, TH_NOISE);
    const second = upsertMerchant(db, { canonical_name: "Starbucks", alias: "STARBUCKS #1234" }, TH_NOISE);
    expect(second.alias_conflict).toBeUndefined();
    expect(first.id).toBe(second.id);
  });

  it("omits alias_conflict for a fresh alias with no existing owner", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks", alias: "STARBUCKS #1234" }, TH_NOISE);
    expect(m.alias_conflict).toBeUndefined();
  });
});

describe("findMerchantByAlias", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    upsertMerchant(db, {
      canonical_name: "Starbucks",
      alias: "STARBUCKS #1234 BANGKOK",
      default_account_id: "thb:expense:food:dining",
    }, TH_NOISE);
  });

  it("finds the merchant by an exact-match raw descriptor", () => {
    const hit = findMerchantByAlias(db, "STARBUCKS #1234 BANGKOK", TH_NOISE);
    expect(hit).toBeTruthy();
    expect(hit!.canonical_name).toBe("Starbucks");
    expect(hit!.default_account_id).toBe("thb:expense:food:dining");
  });

  it("finds the merchant by a normalized-equivalent descriptor", () => {
    const hit = findMerchantByAlias(db, "Starbucks #9999 BKK CHARGE", TH_NOISE);
    expect(hit).toBeTruthy();
    expect(hit!.canonical_name).toBe("Starbucks");
  });

  it("returns null when no alias matches", () => {
    expect(findMerchantByAlias(db, "Some Random Store", TH_NOISE)).toBeNull();
  });
});

describe("setMerchantDefaultAccount + listMerchants + findMerchantById", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedChartOfAccounts);
    upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    upsertMerchant(db, { canonical_name: "Amazon", default_account_id: "thb:expense:food" }, TH_NOISE);
  });

  it("returns before/after when updating the default", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    const result = setMerchantDefaultAccount(db, m.id, "thb:expense:food:dining");
    expect(result).toEqual({ before: null, after: "thb:expense:food:dining" });
    expect(findMerchantById(db, m.id)!.default_account_id).toBe("thb:expense:food:dining");
  });

  it("lists merchants with alias counts", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    upsertMerchant(db, { canonical_name: "Starbucks", alias: "starbucks #1" }, TH_NOISE);
    upsertMerchant(db, { canonical_name: "Starbucks", alias: "starbucks #2" }, TH_NOISE);
    const rows = listMerchants(db);
    expect(rows.length).toBeGreaterThan(0);
    const sbux = rows.find(r => r.id === m.id)!;
    expect(sbux.alias_count).toBe(1); // both aliases normalize to "starbucks": single row
  });
});

describe("setMerchantDefaultAccount with a null account (clear)", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("clears the default and returns the prior value", () => {
    const m = upsertMerchant(db, {
      canonical_name: "Amazon",
      default_account_id: "thb:expense:food",
    }, TH_NOISE);
    const result = setMerchantDefaultAccount(db, m.id, null);
    expect(result).toEqual({ before: "thb:expense:food", after: null });
    expect(findMerchantById(db, m.id)!.default_account_id).toBeNull();
  });

  it("returns null when the merchant does not exist", () => {
    expect(setMerchantDefaultAccount(db, "m:does-not-exist", null)).toBeNull();
    expect(setMerchantDefaultAccount(db, "m:does-not-exist", "thb:expense:food")).toBeNull();
  });

  it("is idempotent on a merchant that already has no default", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    const result = setMerchantDefaultAccount(db, m.id, null);
    expect(result).toEqual({ before: null, after: null });
    expect(findMerchantById(db, m.id)!.default_account_id).toBeNull();
  });
});

describe("renameMerchant", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("renames in place and keeps the old name resolving to the same merchant", () => {
    const m = upsertMerchant(db, { canonical_name: "STARBUCKS COFFEE #456", alias: "STARBUCKS #456 BKK" }, TH_NOISE);

    const renamed = renameMerchant(db, m.id, "Starbucks", TH_NOISE);
    expect(renamed).toEqual({ before: "STARBUCKS COFFEE #456", after: "Starbucks" });
    expect(findMerchantById(db, m.id)!.canonical_name).toBe("Starbucks");

    expect(findMerchantByAlias(db, "STARBUCKS #456 BKK", TH_NOISE)?.id).toBe(m.id);
    expect(findMerchantByAlias(db, "STARBUCKS COFFEE #456", TH_NOISE)?.id).toBe(m.id);
  });

  it("reports an alias conflict when another merchant holds the old name's pattern", () => {
    const other = upsertMerchant(db, { canonical_name: "Other", alias: "GRAB FOOD" }, TH_NOISE);
    const m = upsertMerchant(db, { canonical_name: "GRAB FOOD" }, TH_NOISE);

    const renamed = renameMerchant(db, m.id, "Grab", TH_NOISE);
    expect(renamed.after).toBe("Grab");
    expect(renamed.alias_conflict).toEqual({
      pattern: normalizeDescriptor("GRAB FOOD", TH_NOISE),
      held_by: other.id,
    });
  });

  it("is a no-op when the name is unchanged", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    expect(renameMerchant(db, m.id, "Starbucks", TH_NOISE)).toEqual({ before: "Starbucks", after: "Starbucks" });
  });

  it("throws for a missing merchant", () => {
    expect(() => renameMerchant(db, "m:none", "Name", TH_NOISE)).toThrow(/not found/);
  });
});

describe("mergeMerchants", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(seedChartOfAccounts); });

  it("re-points transactions, moves aliases, and deletes the source", () => {
    const from = upsertMerchant(db, { canonical_name: "Starbux", alias: "STARBUX #1" }, TH_NOISE);
    const to = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    insertTransaction(db, tf({ merchant_id: from.id }));
    insertTransaction(db, tf({ merchant_id: from.id, description: "Coffee 2" }));

    expect(mergeMerchants(db, from.id, to.id)).toEqual({ ok: true, moved_transactions: 2, moved_aliases: 1 });
    expect(findMerchantById(db, from.id)).toBeNull();
    const txRows = db.prepare(`SELECT merchant_id FROM transactions`).all() as { merchant_id: string }[];
    expect(txRows.every(r => r.merchant_id === to.id)).toBe(true);
    const aliasRows = db.prepare(`SELECT merchant_id FROM merchant_aliases`).all() as { merchant_id: string }[];
    expect(aliasRows.every(r => r.merchant_id === to.id)).toBe(true);
  });

  it("adopts the source's default_account_id when the destination has none", () => {
    const from = upsertMerchant(db, { canonical_name: "Starbux", default_account_id: "thb:expense:food:dining" }, TH_NOISE);
    const to = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);

    expect(mergeMerchants(db, from.id, to.id)).toMatchObject({
      ok: true,
      adopted_default_account: "thb:expense:food:dining",
    });
    expect(findMerchantById(db, to.id)!.default_account_id).toBe("thb:expense:food:dining");
  });

  it("keeps the destination's default_account_id when it already has one", () => {
    const from = upsertMerchant(db, { canonical_name: "Starbux", default_account_id: "thb:expense:food:dining" }, TH_NOISE);
    const to = upsertMerchant(db, { canonical_name: "Starbucks", default_account_id: "thb:expense:food" }, TH_NOISE);

    expect(mergeMerchants(db, from.id, to.id)).toEqual({ ok: true, moved_transactions: 0, moved_aliases: 0 });
    expect(findMerchantById(db, to.id)!.default_account_id).toBe("thb:expense:food");
  });

  it("refuses a self-merge", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    expect(mergeMerchants(db, m.id, m.id)).toEqual({
      ok: false,
      reason: "same_merchant",
      message: "Cannot merge a merchant into itself.",
    });
  });

  it("refuses a missing source or destination as not_found, merging nothing", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" }, TH_NOISE);
    expect(mergeMerchants(db, "m:does-not-exist", m.id)).toEqual({
      ok: false,
      reason: "not_found",
      message: "Source merchant m:does-not-exist not found.",
    });
    expect(mergeMerchants(db, m.id, "m:does-not-exist")).toEqual({
      ok: false,
      reason: "not_found",
      message: "Destination merchant m:does-not-exist not found.",
    });
    expect(findMerchantById(db, m.id)).not.toBeNull();
  });
});
