import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "libsql";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inTransaction } from "./transaction.js";
import { isBusyError, sqliteErrorCode } from "./errors.js";

function values(db: Database.Database): number[] {
  return (db.prepare(`SELECT x FROM t ORDER BY x`).all() as { x: number }[]).map((r) => r.x);
}

function insert(db: Database.Database, x: number): void {
  db.prepare(`INSERT INTO t (x) VALUES (?)`).run(x);
}

describe("inTransaction", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE t (x INTEGER)`);
  });
  afterEach(() => db.close());

  it("returns fn's value and commits its writes", () => {
    expect(inTransaction(db, () => { insert(db, 1); return "done"; })).toBe("done");
    expect(db.inTransaction).toBe(false);
    expect(values(db)).toEqual([1]);
  });

  it("joins an open transaction instead of beginning a second one", () => {
    const result = inTransaction(db, () => {
      insert(db, 1);
      return inTransaction(db, () => { insert(db, 2); return db.inTransaction; });
    });
    expect(result).toBe(true);
    expect(values(db)).toEqual([1, 2]);
  });

  it("rolls the outer writes back when a nested call throws, since the nested one only joined", () => {
    expect(() =>
      inTransaction(db, () => {
        insert(db, 1);
        inTransaction(db, () => {
          insert(db, 2);
          throw new Error("inner failure");
        });
      }),
    ).toThrow("inner failure");
    expect(db.inTransaction).toBe(false);
    expect(values(db)).toEqual([]);
  });

  it("refuses an async fn and rolls back what it wrote before its first await", () => {
    expect(() => inTransaction(db, async () => { insert(db, 1); })).toThrow(/synchronous fn/);
    expect(db.inTransaction).toBe(false);
    expect(values(db)).toEqual([]);
  });

  it("refuses an async fn that would only join, taking the outer unit down with it", () => {
    expect(() =>
      inTransaction(db, () => {
        insert(db, 1);
        inTransaction(db, async () => { insert(db, 2); });
      }),
    ).toThrow(/synchronous fn/);
    expect(db.inTransaction).toBe(false);
    expect(values(db)).toEqual([]);
  });

  it("surfaces the original error when SQLite has already rolled the transaction back", () => {
    db.exec(`CREATE TABLE big (b BLOB)`);
    db.pragma("max_page_count = 20");
    // SQLITE_FULL ends the transaction itself; a blind second ROLLBACK would throw over it.
    let thrown: unknown;
    try {
      inTransaction(db, () => {
        insert(db, 1);
        db.prepare(`INSERT INTO big (b) VALUES (zeroblob(500000))`).run();
      });
    } catch (err) {
      thrown = err;
    }
    expect(sqliteErrorCode(thrown)).toBe("SQLITE_FULL");
    expect(db.inTransaction).toBe(false);
    expect(values(db)).toEqual([]);
  });
});

describe("inTransaction: lock contention", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // IMMEDIATE takes the write lock at BEGIN, where SQLite's busy handler applies; a deferred
  // transaction that reads first would fail its lock upgrade without waiting at all.
  it("waits out busy_timeout at BEGIN, then throws SQLITE_BUSY before running fn", () => {
    const dir = mkdtempSync(join(tmpdir(), "oled-tx-busy-"));
    dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const db = new Database(path, { timeout: 100 });
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE t (x INTEGER)`);
    const holder = new Database(path);
    holder.exec("BEGIN IMMEDIATE");

    let ran = false;
    let thrown: unknown;
    const startedAt = Date.now();
    try {
      inTransaction(db, () => { ran = true; });
    } catch (err) {
      thrown = err;
    }
    const waited = Date.now() - startedAt;
    holder.exec("ROLLBACK");
    holder.close();
    db.close();

    expect(isBusyError(thrown)).toBe(true);
    expect(ran).toBe(false);
    expect(waited).toBeGreaterThanOrEqual(90);
  });
});
