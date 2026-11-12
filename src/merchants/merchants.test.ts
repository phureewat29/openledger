import { describe, it, expect, beforeEach } from "vitest";
import type Database from "libsql";
import { findMerchantById, upsertMerchant } from "./queries.js";
import { mergeMerchants } from "./merchants.js";
import { insertTransaction, type TransactionInput } from "../transactions/queries.js";
import { freshDB, seedAccount } from "../../fixtures/db.js";

function seedChartOfAccounts(db: Database.Database): void {
  seedAccount(db, { id: "thb:expense:food" });
  seedAccount(db, { id: "thb:expense:food:dining" });
  seedAccount(db, { id: "thb:asset:cash" });
}

const NOISE: string[] = [];

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

describe("mergeMerchants", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDB(seedChartOfAccounts); });

  it("re-points transactions, moves aliases, and deletes the source", () => {
    const from = upsertMerchant(db, { canonical_name: "Starbux", alias: "STARBUX #1" }, NOISE);
    const to = upsertMerchant(db, { canonical_name: "Starbucks" }, NOISE);
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
    const from = upsertMerchant(db, { canonical_name: "Starbux", default_account_id: "thb:expense:food:dining" }, NOISE);
    const to = upsertMerchant(db, { canonical_name: "Starbucks" }, NOISE);

    expect(mergeMerchants(db, from.id, to.id)).toMatchObject({
      ok: true,
      adopted_default_account: "thb:expense:food:dining",
    });
    expect(findMerchantById(db, to.id)!.default_account_id).toBe("thb:expense:food:dining");
  });

  it("keeps the destination's default_account_id when it already has one", () => {
    const from = upsertMerchant(db, { canonical_name: "Starbux", default_account_id: "thb:expense:food:dining" }, NOISE);
    const to = upsertMerchant(db, { canonical_name: "Starbucks", default_account_id: "thb:expense:food" }, NOISE);

    expect(mergeMerchants(db, from.id, to.id)).toEqual({ ok: true, moved_transactions: 0, moved_aliases: 0 });
    expect(findMerchantById(db, to.id)!.default_account_id).toBe("thb:expense:food");
  });

  it("refuses a self-merge", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" }, NOISE);
    expect(mergeMerchants(db, m.id, m.id)).toEqual({
      ok: false,
      reason: "same_merchant",
      message: "Cannot merge a merchant into itself.",
    });
  });

  it("refuses a missing source or destination as not_found, merging nothing", () => {
    const m = upsertMerchant(db, { canonical_name: "Starbucks" }, NOISE);
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
