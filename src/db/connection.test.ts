import { describe, it, expect, afterEach } from "vitest";
import Database from "libsql";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDB } from "./connection.js";
import { DBBusyError, DBNotReadyError, isBusyError, sqliteErrorCode } from "./errors.js";

// Sandboxed temp dirs only: openDB migrates and chmods whatever path it is handed.
const dirs: string[] = [];
const opened: Database.Database[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oled-connection-"));
  dirs.push(dir);
  return dir;
}

async function open(dbPath: string): Promise<Database.Database> {
  const db = await openDB(dbPath);
  opened.push(db);
  return db;
}

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function journalMode(db: Database.Database): string {
  return (db.pragma("journal_mode") as { journal_mode: string }[])[0].journal_mode;
}

/** A rollback-journal database, the one state whose open still has a conversion to contend over. */
function seedNonWAL(dbPath: string): void {
  const seed = new Database(dbPath);
  seed.pragma("journal_mode = DELETE");
  seed.close();
}

describe("openDB: lock settings", () => {
  it("sets busy_timeout so a concurrent write waits instead of failing at once", async () => {
    const db = await open(join(tempDir(), "db.sqlite"));

    expect(db.pragma("busy_timeout")).toEqual([{ timeout: 5000 }]);
    // libsql ignores `{ simple: true }` and answers with the row anyway; reading a pragma as
    // a scalar silently yields an object, which is how a WAL checkpoint check once broke.
    expect(db.pragma("busy_timeout", { simple: true })).not.toBe(5000);
  });

  it("converts a rollback-journal database to WAL", async () => {
    const dbPath = join(tempDir(), "db.sqlite");
    seedNonWAL(dbPath);

    expect(journalMode(await open(dbPath))).toBe("wal");
  });

  it("leaves an existing WAL database in WAL on every later open", async () => {
    const dbPath = join(tempDir(), "db.sqlite");
    (await openDB(dbPath)).close();

    expect(journalMode(await open(dbPath))).toBe("wal");
  });
});

describe("openDB: unusable paths", () => {
  it("refuses a file that is not a database without calling it corrupt", async () => {
    const dbPath = join(tempDir(), "notes.txt");
    writeFileSync(dbPath, "dear diary, this is not a database\n");

    // The open pragma never sees page-body damage, so "corrupt" was always the wrong word
    // here: it coached users into moving a healthy ledger aside.
    await expect(open(dbPath)).rejects.toThrow(DBNotReadyError);
    await expect(open(dbPath)).rejects.toThrow(dbPath);
    await expect(open(dbPath)).rejects.not.toThrow(/corrupt/i);
  });

  it("reports a path that cannot be opened at all as NOT_READY, not a raw driver error", async () => {
    const dbPath = join(tempDir(), "a-directory");
    mkdirSync(dbPath);

    // The constructor throws a plain Error with no `code`; unwrapped it exited 1 with driver text.
    await expect(open(dbPath)).rejects.toThrow(DBNotReadyError);
    await expect(open(dbPath)).rejects.toThrow(`Cannot open database at ${dbPath}`);
  });

  it("reports a read-only ledger as not writable, not as a file to move aside", async (ctx) => {
    // Root and Windows cannot be denied write permission; report that as skipped, never as passed.
    ctx.skip(process.platform === "win32" || process.getuid?.() === 0, "needs an unprivileged posix uid");

    const dbPath = join(tempDir(), "db.sqlite");
    seedNonWAL(dbPath);
    chmodSync(dbPath, 0o444);

    try {
      await expect(open(dbPath)).rejects.toThrow(DBNotReadyError);
      await expect(open(dbPath)).rejects.toThrow(/not writable/);
      await expect(open(dbPath)).rejects.not.toThrow(/Move it aside/);
    } finally {
      chmodSync(dbPath, 0o600);
    }
  });
});

describe("openDB: contention", () => {
  /**
   * One attempt costs a full busy_timeout inside libsql before it reports the lock, so this
   * case takes seconds by construction: the driver's busy_timeout does the waiting, not a
   * retry loop above it, and this pins DBBusyError once that wait ends (~5.2s, deterministic).
   */
  it("reports a ledger another process holds as DBBusyError", async () => {
    const dbPath = join(tempDir(), "db.sqlite");
    seedNonWAL(dbPath);
    const holder = new Database(dbPath);
    holder.exec("BEGIN EXCLUSIVE");

    let thrown: unknown;
    try {
      await open(dbPath);
    } catch (err) {
      thrown = err;
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }

    expect(thrown).toBeInstanceOf(DBBusyError);
    expect((thrown as Error).message).toContain(dbPath);
    expect((thrown as Error).message).toContain("in use by another process");
  }, 30_000);
});

describe("isBusyError", () => {
  const BUSY = ["SQLITE_BUSY", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT"];
  const FINAL = ["SQLITE_NOTADB", "SQLITE_CORRUPT", "SQLITE_CONSTRAINT", "BUSY"];

  it.each(BUSY)("treats %s as retryable", (code) => {
    expect(isBusyError(Object.assign(new Error("database is locked"), { code }))).toBe(true);
  });

  it.each(FINAL)("treats %s as final", (code) => {
    expect(isBusyError(Object.assign(new Error("nope"), { code }))).toBe(false);
  });

  // The family is read off `code`, never off the message, and a codeless throw is not a lock.
  const CODELESS: unknown[] = [new Error("SQLITE_BUSY: database is locked"), "SQLITE_BUSY", null, undefined];

  it.each(CODELESS)("reads no code off %p", (thrown) => {
    expect(sqliteErrorCode(thrown)).toBe("");
    expect(isBusyError(thrown)).toBe(false);
  });
});
