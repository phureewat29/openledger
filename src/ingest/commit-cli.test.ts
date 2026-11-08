import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitRows, type BatchContext } from "./commit-cli.js";
import { seedAccount, failingStatement, freshDb, ledgerLockedAtTransaction } from "../../fixtures/db.js";
import { createOutput, describeFailure } from "../cli/output.js";
import { countTransactions, findTransactionById } from "../transactions/queries.js";
import { findAccountById } from "../accounts/queries.js";
import { EXIT } from "../contract/exit.js";
import { deriveGroupId, deriveTransactionId, newBatchId } from "../lib/ids.js";
import { insertPendingFile } from "../files/queries.js";
import type Database from "libsql";

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
  const out = createOutput({ json: true, tty: false, color: false, kind: "json" }, (s) => chunks.push(s));
  const lines = (): Record<string, unknown>[] =>
    chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { out, lines };
}

describe("commitRows: a row's own throw", () => {
  it("becomes that row's unexpected_error, leaves none of its writes, and the batch goes on", () => {
    const db = freshDb(seedLedger);
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

describe("commitRows: a row's own source_file_id", () => {
  it("overrides the batch's --file, and the row's ids derive from that file's hash", () => {
    const db = freshDb(seedLedger);
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

describe("commitRows: a locked ledger", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("stops the batch with BUSY (8), keeping the row that posted before the lock reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "oled-commit-busy-"));
    dirs.push(dir);
    const ledger = ledgerLockedAtTransaction(join(dir, "db.sqlite"), 2, seedLedger);
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
});
