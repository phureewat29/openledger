import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { countBy } from "es-toolkit";
import Database from "libsql";
import { commitRows, type BatchContext } from "./commit-cli.js";
import { seedAccount, failingStatement, freshDB, ledgerLockedAtTransaction } from "../../fixtures/db.js";
import { tempDir } from "../../fixtures/test-cleanup.js";
import { createOutput, describeFailure } from "../cli/output.js";
import {
  countTransactions,
  findTransactionById,
  insertTransaction,
  listTransactions,
} from "../transactions/queries.js";
import { findAccountById } from "../accounts/queries.js";
import { EXIT } from "../contract/exit.js";
import { deriveGroupId, deriveTransactionId, newBatchId } from "../lib/ids.js";
import { insertPendingFile } from "../files/queries.js";

function seedLedger(db: Database.Database): void {
  seedAccount(db, { id: "thb:asset:cash" });
  seedAccount(db, { id: "thb:expense:food" });
}

function batch(): BatchContext {
  return { batchId: newBatchId(), noise: [] };
}

function row(description: string, debit = "thb:expense:food"): Record<string, unknown> {
  return {
    date: "2026-05-01",
    description,
    debit_account: debit,
    credit_account: "thb:asset:cash",
    amount: 50,
  };
}

function jsonOutput(): { out: ReturnType<typeof createOutput>; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const out = createOutput({ tty: false, color: false, kind: "json" }, (s) => chunks.push(s));
  const lines = (): Record<string, unknown>[] =>
    chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { out, lines };
}

describe("commitRows: a row's own throw", () => {
  it("becomes that row's unexpected_error, leaves none of its writes, and the batch goes on", () => {
    const db = freshDB(seedLedger);
    // Only the uncategorized row raises a question, so only its last write fails.
    const broken = failingStatement(db, "INSERT INTO questions");
    const { out, lines } = jsonOutput();

    const results = commitRows(out, broken, batch(), [
      row("Coffee"),
      row("Parked", "thb:expense:uncategorized"),
      row("Lunch"),
    ]);

    expect(lines().map((r) => ({ index: r.index, ok: r.ok, reason: r.reason }))).toEqual([
      { index: 0, ok: true, reason: undefined },
      { index: 1, ok: false, reason: "unexpected_error" },
      { index: 2, ok: true, reason: undefined },
    ]);
    expect(results).toEqual(lines());
    expect(countTransactions(db)).toBe(2);
    expect(findAccountById(db, "thb:expense:uncategorized")).toBeNull();
  });
});

describe("commitRows: a non-string field", () => {
  it("is that row's dirty_input, not an unexpected_error, and nothing posts", () => {
    const db = freshDB(seedLedger);
    const { out } = jsonOutput();

    const results = commitRows(out, db, batch(), [
      { ...row("Object file"), source_file_id: { id: "sf-1" } },
      { ...row("Array description"), description: ["Lunch"] },
    ]);

    expect(results).toEqual([
      expect.objectContaining({
        ok: false,
        reason: "dirty_input",
        message: '--source-file-id must be a string, got "{"id":"sf-1"}"',
      }),
      expect.objectContaining({
        ok: false,
        reason: "dirty_input",
        message: '--description must be a string, got "["Lunch"]"',
      }),
    ]);
    expect(countTransactions(db)).toBe(0);
  });
});

describe("commitRows: an inline merchant", () => {
  it("reads a null optional field as absent, and posts", () => {
    const db = freshDB(seedLedger);
    const { out } = jsonOutput();

    const results = commitRows(out, db, batch(), [
      { ...row("Coffee"), merchant: { canonical_name: "Cafe X", alias: null, default_account_id: null } },
    ]);

    expect(results).toMatchObject([{ ok: true, merchant: { how: "linked" } }]);
    expect(countTransactions(db)).toBe(1);
  });

  it("names every field it reads when the shape is wrong", () => {
    const db = freshDB(seedLedger);
    const { out } = jsonOutput();

    const results = commitRows(out, db, batch(), [{ ...row("Coffee"), merchant: { alias: "CAFE X" } }]);

    expect(results).toMatchObject([
      {
        ok: false,
        reason: "dirty_input",
        message:
          "--merchant must be a merchant object {canonical_name, alias?, default_account_id?} with a non-empty canonical_name",
      },
    ]);
  });
});

describe("commitRows: a row's own source_file_id", () => {
  it("overrides the batch's --file, and the row's ids derive from that file's hash", () => {
    const db = freshDB(seedLedger);
    const pdf = { path: "/statements/x.pdf", mime: "application/pdf" };
    insertPendingFile(db, { ...pdf, id: "sf-batch", file_hash: "hash-batch" });
    insertPendingFile(db, { ...pdf, id: "sf-own", file_hash: "hash-own" });
    const { out } = jsonOutput();

    const results = commitRows(out, db, { ...batch(), file: "sf-batch" }, [
      { ...row("Inherits"), source_page: 1, row_index: 0 },
      { ...row("Names its own"), source_page: 1, row_index: 0, source_file_id: "sf-own" },
      {
        date: "2026-05-01",
        description: "Compound, names its own",
        source_page: 1,
        row_index: 1,
        source_file_id: "sf-own",
        linked: [{ debit_account: "thb:expense:food", credit_account: "thb:asset:cash", amount: 5 }],
      },
    ]);

    const inherited = deriveTransactionId("hash-batch", 1, 0);
    const own = deriveTransactionId("hash-own", 1, 0);
    const leg = deriveTransactionId("hash-own", 1, 1, 0);
    expect(results).toMatchObject([
      { ok: true, transaction_id: inherited },
      { ok: true, transaction_id: own },
      { ok: true, group_id: deriveGroupId("hash-own", 1, 1), legs: [{ transaction_id: leg }] },
    ]);
    expect([inherited, own, leg].map((id) => findTransactionById(db, id)?.source_file_id)).toEqual([
      "sf-batch",
      "sf-own",
      "sf-own",
    ]);
  });
});

function commitUntilThrown(db: Database.Database, items: unknown[]): unknown {
  try {
    commitRows(jsonOutput().out, db, batch(), items);
  } catch (thrown) {
    return thrown;
  }
  throw new Error("expected the batch to stop mid-way");
}

describe("commitRows: a locked ledger", () => {
  function dbPath(): string {
    return join(tempDir("oled-commit-busy-"), "db.sqlite");
  }

  it("stops the batch with BUSY (8), keeping the row that posted before the lock reported", () => {
    const ledger = ledgerLockedAtTransaction(dbPath(), 2, seedLedger);
    const { out, lines } = jsonOutput();

    let thrown: unknown;
    try {
      commitRows(out, ledger.db, batch(), [row("Coffee"), row("Lunch"), row("Dinner")]);
    } catch (err) {
      thrown = err;
    }
    const posted = countTransactions(ledger.db);
    ledger.release();

    expect(describeFailure(thrown, true).exitCode).toBe(EXIT.BUSY);
    expect(lines().map((r) => ({ index: r.index, ok: r.ok }))).toEqual([{ index: 0, ok: true }]);
    expect(posted).toBe(1);
  });

  it("names what posted and where to resume, and resuming there posts every row once", () => {
    const path = dbPath();
    // One transaction per row: the duplicate, the refused row, Coffee, then the lock at Lunch.
    const ledger = ledgerLockedAtTransaction(path, 4, (db) => {
      seedLedger(db);
      insertTransaction(db, {
        id: "tx:fixed",
        date: "2026-05-01",
        description: "Fixed",
        debit_account_id: "thb:expense:food",
        credit_account_id: "thb:asset:cash",
        amount: 5000,
      });
    });
    const items = [
      { ...row("Fixed"), id: "tx:fixed" },
      { ...row("Refused"), amount: -1 },
      row("Coffee"),
      row("Lunch"),
      row("Dinner"),
    ];

    const thrown = commitUntilThrown(ledger.db, items);
    ledger.release();

    const failure = describeFailure(thrown, true);
    expect(failure.exitCode).toBe(EXIT.BUSY);
    expect(JSON.parse(failure.stderr).error).toEqual({
      code: "E_BUSY",
      message: "The ledger is in use by another process.",
      hint:
        "rows before index 3 already ran (1 posted, results above); re-run only the rows from index 3, " +
        "since re-running them all would post rows without a stable id twice",
      details: { posted: 1, resume_from_index: 3 },
    });

    const db = new Database(path);
    db.pragma("foreign_keys = ON");
    commitRows(jsonOutput().out, db, batch(), items.slice(3));
    expect(countBy(listTransactions(db), (t) => t.description)).toEqual({
      Fixed: 1,
      Coffee: 1,
      Lunch: 1,
      Dinner: 1,
    });
    db.close();
  });

  it("keeps the plain re-run hint while nothing has posted", () => {
    const ledger = ledgerLockedAtTransaction(dbPath(), 1, seedLedger);

    const thrown = commitUntilThrown(ledger.db, ["not an object", row("Coffee")]);
    ledger.release();

    const { error } = JSON.parse(describeFailure(thrown, true).stderr);
    expect(error.code).toBe("E_BUSY");
    expect(error.hint).toBe("another oled process is using the ledger; re-run the same command in a moment");
    expect(error.details).toBeUndefined();
  });
});

describe("commitRows: a ledger failure that is not a lock", () => {
  it("propagates unchanged after a row posted, with no resume details", () => {
    const db = freshDB(seedLedger);
    const damaged = Object.assign(new Error("database disk image is malformed"), { code: "SQLITE_CORRUPT" });
    const prepare = db.prepare.bind(db);
    let inserts = 0;
    vi.spyOn(db, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("INSERT INTO transactions") && ++inserts === 2) throw damaged;
      return prepare(sql);
    });

    const thrown = commitUntilThrown(db, [row("Coffee"), row("Lunch")]);

    expect(thrown).toBe(damaged);
    const failure = describeFailure(thrown, true);
    expect(failure.exitCode).toBe(EXIT.NOT_READY);
    expect(JSON.parse(failure.stderr).error.details).toBeUndefined();
    expect(countTransactions(db)).toBe(1);
  });
});
