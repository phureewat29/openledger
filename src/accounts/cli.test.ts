import { describe, it, expect, beforeEach } from "vitest";
import type Database from "libsql";
import {
  ACCOUNT_FAILURE_EXIT,
  createOneAccount,
  createAccountsBatch,
  failAccountNotFound,
} from "./cli.js";
import type { AccountFailure } from "./accounts.js";
import { findAccountById, insertAccount } from "./queries.js";
import { failingAccountInsert, freshDb } from "../../fixtures/db.js";
import { createOutput } from "../cli/output.js";
import { failReason } from "../cli/errors.js";
import { EXIT } from "../contract/exit.js";

// createOneAccount unwraps RefusedCreate but must not treat any other throw as a refusal:
// a broken database would otherwise misread as "account already exists".
describe("createOneAccount refusal carrier", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb();
  });

  it("lets a broken write escape instead of reporting it as a refusal", () => {
    // The account INSERT fails the way a full disk would; every other statement still works.
    const broken = failingAccountInsert(db, "thb:asset:bank");

    expect(() =>
      createOneAccount(broken, { id: "thb:asset:bank", name: "KBank Savings", type: "asset" }),
    ).toThrow(/disk I\/O/);

    // The whole chain is one transaction: the ledger root it opened must not outlive the leaf.
    expect(findAccountById(db, "thb:asset:bank")).toBeNull();
    expect(findAccountById(db, "thb:asset")).toBeNull();
  });

  it("still reports a taken id as data, not as a throw", () => {
    const first = createOneAccount(db, { id: "thb:asset:bank", name: "KBank", type: "asset" });
    expect(first).toMatchObject({ ok: true, id: "thb:asset:bank" });

    expect(createOneAccount(db, { id: "thb:asset:bank", name: "KBank", type: "asset" })).toEqual({
      ok: false,
      reason: "account_exists",
      message: expect.any(String),
    });
  });
});

// A driver/constraint throw is hard to force through the CLI subprocess without
// corrupting the sandbox db out-of-band, so this pins the batch loop directly.
describe("createAccountsBatch: a mid-batch throw stays that item's failure", () => {
  it("keeps every result row and posts the good items when one item's write throws", () => {
    const db = freshDb();
    const broken = failingAccountInsert(db, "thb:equity:bad");
    const items = [
      { id: "thb:equity:good-a", name: "Good A", type: "equity" },
      { id: "thb:equity:bad", name: "Bad", type: "equity" },
      { id: "thb:equity:good-b", name: "Good B", type: "equity" },
    ];

    const chunks: string[] = [];
    const out = createOutput({ json: true, tty: false, color: false, kind: "json" }, (s) => chunks.push(s));
    const exit = createAccountsBatch(out, broken, items);

    const objs = chunks.join("").trimEnd().split("\n").map((l) => JSON.parse(l));
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
    const db = freshDb(seedThbLedger);
    const err = catchFailAccountNotFound(db, "expense:food");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('account "expense:food" not found');
    expect(err.hint).toBe("account ids start with a currency — existing ledgers: thb");
  });

  it("ledger-shaped id whose head names no existing ledger: NOT_FOUND with a ledger-enumerating hint, caller hint dropped", () => {
    const db = freshDb(seedThbLedger);
    const err = catchFailAccountNotFound(db, "eur:expense:food", "create it with `oled accounts create`");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('account "eur:expense:food" not found');
    expect(err.hint).toBe("account ids start with a currency — existing ledgers: thb");
  });

  it("no ledgers at all: NOT_FOUND with the config --init hint, regardless of id shape", () => {
    const db = freshDb();
    const bare = catchFailAccountNotFound(db, "thb:expense:food");
    expect(bare.code).toBe("NOT_FOUND");
    expect(bare.hint).toBe(
      "account ids start with a currency (e.g. thb:expense:food); no ledger exists yet, run `oled config --init`",
    );

    const prefixLess = catchFailAccountNotFound(db, "expense:food");
    expect(prefixLess.hint).toBe(bare.hint);
  });

  it("ledger-scoped id whose head IS a real ledger: the caller's own hint passes through unchanged", () => {
    const db = freshDb(seedThbLedger);
    const err = catchFailAccountNotFound(db, "thb:expense:doesnotexist", "custom hint");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.message).toBe('account "thb:expense:doesnotexist" not found');
    expect(err.hint).toBe("custom hint");
  });

  it("ledger-scoped id whose head IS a real ledger, no hint given: hint is undefined, not the ledger list", () => {
    const db = freshDb(seedThbLedger);
    const err = catchFailAccountNotFound(db, "thb:expense:doesnotexist");
    expect(err.hint).toBeUndefined();
  });
});

interface ReasonCase {
  reason: AccountFailure;
  exitCode: number;
}

/** Pinned as data, not read off ACCOUNT_FAILURE_EXIT: a re-pointed reason must fail here. */
const REASON_CASES: ReasonCase[] = [
  { reason: "account_exists", exitCode: EXIT.INVALID },
  { reason: "parent_not_found", exitCode: EXIT.NOT_FOUND },
  { reason: "invalid_hierarchy", exitCode: EXIT.INVALID },
];

describe("ACCOUNT_FAILURE_EXIT", () => {
  it.each(REASON_CASES)("$reason exits $exitCode", ({ reason, exitCode }) => {
    let thrown: { code: keyof typeof EXIT } | undefined;
    try {
      failReason(ACCOUNT_FAILURE_EXIT, { reason, message: "refused" });
    } catch (err) {
      thrown = err as { code: keyof typeof EXIT };
    }
    expect(EXIT[thrown!.code]).toBe(exitCode);
  });

  it("assigns an exit code to every reason arm", () => {
    expect(Object.keys(ACCOUNT_FAILURE_EXIT).sort()).toEqual(REASON_CASES.map((c) => c.reason).sort());
  });
});
