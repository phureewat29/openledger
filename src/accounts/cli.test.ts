import { describe, it, expect } from "vitest";
import type Database from "libsql";
import { join } from "node:path";
import {
  ACCOUNT_FAILURE_EXIT,
  ADJUST_ACCOUNT_EXIT,
  DELETE_ACCOUNT_EXIT,
  MERGE_ACCOUNTS_EXIT,
  UPDATE_ACCOUNT_EXIT,
  createAccountsBatch,
  failAccountNotFound,
} from "./cli.js";
import { findAccountById, insertAccount } from "./queries.js";
import { failingAccountInsert, freshDB, ledgerLockedAtTransaction } from "../../fixtures/db.js";
import { tempDir } from "../../fixtures/test-cleanup.js";
import { createOutput, describeFailure } from "../cli/output.js";
import { EXIT } from "../contract/exit.js";
import { describeReasonTable } from "../../fixtures/reason-table.js";

function jsonOutput(): { out: ReturnType<typeof createOutput>; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const out = createOutput({ tty: false, color: false, kind: "json" }, (s) => chunks.push(s));
  const lines = (): Record<string, unknown>[] =>
    chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { out, lines };
}

// A driver/constraint throw is hard to force through the CLI subprocess without
// corrupting the sandbox db out-of-band, so this pins the batch loop directly.
describe("createAccountsBatch: a mid-batch throw stays that item's failure", () => {
  it("keeps every result row and posts the good items when one item's write throws", () => {
    const db = freshDB();
    const broken = failingAccountInsert(db, "thb:equity:bad");
    const items = [
      { id: "thb:equity:good-a", name: "Good A", type: "equity" },
      { id: "thb:equity:bad", name: "Bad", type: "equity" },
      { id: "thb:equity:good-b", name: "Good B", type: "equity" },
    ];

    const { out, lines } = jsonOutput();
    const exit = createAccountsBatch(out, broken, items);

    const objs = lines();
    const results = objs.filter((o) => o.type === "result");

    expect(results.map((r) => ({ index: r.index, ok: r.ok }))).toEqual([
      { index: 0, ok: true },
      { index: 1, ok: false },
      { index: 2, ok: true },
    ]);
    expect(typeof results[1].message).toBe("string");
    expect(objs.find((o) => o.type === "summary")).toMatchObject({ created: 2, duplicates: 0, failed: 1 });
    expect(exit).toBe("PARTIAL");

    // The broken item's own write rolled back; its siblings still landed.
    expect(findAccountById(db, "thb:equity:good-a")).not.toBeNull();
    expect(findAccountById(db, "thb:equity:good-b")).not.toBeNull();
    expect(findAccountById(db, "thb:equity:bad")).toBeNull();
  });
});

describe("createAccountsBatch: a locked ledger stops the batch", () => {
  it("exits BUSY (8), not PARTIAL, and keeps the rows that landed before the lock", () => {
    const ledger = ledgerLockedAtTransaction(join(tempDir("oled-accounts-busy-"), "db.sqlite"), 2);
    const { out, lines } = jsonOutput();

    let thrown: unknown;
    try {
      createAccountsBatch(out, ledger.db, [
        { id: "thb:equity:first", name: "First", type: "equity" },
        { id: "thb:equity:second", name: "Second", type: "equity" },
        { id: "thb:equity:third", name: "Third", type: "equity" },
      ]);
    } catch (err) {
      thrown = err;
    }
    const landed = findAccountById(ledger.db, "thb:equity:first");
    ledger.release();

    expect(describeFailure(thrown, true).exitCode).toBe(EXIT.BUSY);
    expect(lines()).toEqual([
      { type: "result", index: 0, ok: true, id: "thb:equity:first", created: true, created_parents: ["thb:equity"] },
    ]);
    expect(landed).not.toBeNull();
  });
});

interface ThrownCLIError {
  code: string;
  message: string;
  hint?: string;
}

// failAccountNotFound is typed `never`; catching it is the only way to assert on what it throws.
function catchFailAccountNotFound(
  ...args: Parameters<typeof failAccountNotFound>
): ThrownCLIError {
  try {
    failAccountNotFound(...args);
  } catch (err) {
    return err as ThrownCLIError;
  }
  throw new Error("unreachable: failAccountNotFound always throws");
}

function seedThbLedger(db: Database.Database): void {
  insertAccount(db, { id: "thb:expense", name: "Expenses", type: "expense", parent_id: null });
}

describe("failAccountNotFound", () => {
  it("prefix-less id, ledgers present: NOT_FOUND with a ledger-enumerating hint", () => {
    const db = freshDB(seedThbLedger);
    const err = catchFailAccountNotFound(db, "expense:food");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('account "expense:food" not found');
    expect(err.hint).toBe("account ids start with a currency — existing ledgers: thb");
  });

  it("ledger-shaped id whose head names no existing ledger: NOT_FOUND with a ledger-enumerating hint, caller hint dropped", () => {
    const db = freshDB(seedThbLedger);
    const err = catchFailAccountNotFound(db, "eur:expense:food", "create it with `oled accounts create`");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('account "eur:expense:food" not found');
    expect(err.hint).toBe("account ids start with a currency — existing ledgers: thb");
  });

  it("no ledgers at all: NOT_FOUND with the config --init hint, regardless of id shape", () => {
    const db = freshDB();
    const bare = catchFailAccountNotFound(db, "thb:expense:food");
    expect(bare.code).toBe("NOT_FOUND");
    expect(bare.hint).toBe(
      "account ids start with a currency (e.g. thb:expense:food); no ledger exists yet, run `oled config --init`",
    );

    const prefixLess = catchFailAccountNotFound(db, "expense:food");
    expect(prefixLess.hint).toBe(bare.hint);
  });

  it("ledger-scoped id whose head IS a real ledger: the caller's own hint passes through unchanged", () => {
    const db = freshDB(seedThbLedger);
    const err = catchFailAccountNotFound(db, "thb:expense:doesnotexist", "custom hint");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('account "thb:expense:doesnotexist" not found');
    expect(err.hint).toBe("custom hint");
  });

  it("ledger-scoped id whose head IS a real ledger, no hint given: hint is undefined, not the ledger list", () => {
    const db = freshDB(seedThbLedger);
    const err = catchFailAccountNotFound(db, "thb:expense:doesnotexist");
    expect(err.hint).toBeUndefined();
  });
});

describeReasonTable("ACCOUNT_FAILURE_EXIT", ACCOUNT_FAILURE_EXIT, {
  account_exists: EXIT.INVALID,
  parent_not_found: EXIT.NOT_FOUND,
  invalid_hierarchy: EXIT.INVALID,
});

describeReasonTable("MERGE_ACCOUNTS_EXIT", MERGE_ACCOUNTS_EXIT, {
  same_account: EXIT.INVALID,
  not_found: EXIT.NOT_FOUND,
  cross_ledger: EXIT.INVALID,
  has_children: EXIT.INVALID,
});

describeReasonTable("DELETE_ACCOUNT_EXIT", DELETE_ACCOUNT_EXIT, {
  has_transactions: EXIT.INVALID,
  has_children: EXIT.INVALID,
});

describeReasonTable("ADJUST_ACCOUNT_EXIT", ADJUST_ACCOUNT_EXIT, {
  not_found: EXIT.NOT_FOUND,
  balancing_account: EXIT.INVALID,
  invalid_transaction: EXIT.INVALID,
});

describeReasonTable("UPDATE_ACCOUNT_EXIT", UPDATE_ACCOUNT_EXIT, {
  not_found: EXIT.NOT_FOUND,
  unreadable_metadata: EXIT.INVALID,
});
