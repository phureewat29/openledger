import type Database from "libsql";
import { DBBusyError, DBNotReadyError, isBusyError, isDamagedDBError, sqliteErrorCode } from "./errors.js";
import { migrate } from "./schema.js";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { chmod600 } from "../lib/perms.js";
import { errorMessage, tryExecute } from "../lib/result.js";

// libsql defaults this to 0, so without it any write loses to a concurrent one instantly.
const BUSY_TIMEOUT_MS = 5000;

// Codes libsql reports when the volume or its permissions block the write, not contention.
const NOT_WRITABLE_CODES = new Set(["SQLITE_READONLY", "SQLITE_PERM", "SQLITE_CANTOPEN"]);

// libsql loads lazily here so its native binding stays off the startup path of commands that never open the ledger.
export async function openDB(dbPath: string): Promise<Database.Database> {
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });

  // A path that cannot be opened at all (a directory, a bad mount) throws from the
  // constructor, where there is no connection to close and nothing to diagnose further.
  const { default: LibSQL } = await import("libsql");
  const opened = tryExecute(() => new LibSQL(dbPath, { timeout: BUSY_TIMEOUT_MS }));
  if (!opened.ok) throw new DBNotReadyError(`Cannot open database at ${dbPath}: ${opened.error}`);
  const db = opened.value;

  // status and doctor survive a failed open via tryExecute and keep running, so the
  // handle must not outlive a throw from anything below.
  try {
    ensureWAL(db, dbPath);
    db.pragma("foreign_keys = ON");
    migrate(db, dbPath);
    // WAL mode writes committed rows into the -wal/-shm sidecars, so the 0600 promise has to cover them too.
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      chmod600(path);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

// A racer that loses the conversion has usually been kept out by a rival CONVERTING, so
// one re-read after the lost wait finds WAL already set; a second loss means a real holder.
const WAL_OPEN_ATTEMPTS = 2;

/**
 * Only the first-ever open converts the journal, and only that conversion contends;
 * re-setting WAL on a WAL database never goes busy, so the mode is read first and the
 * conversion is skipped on every later open. A foreign lock can make either the read or
 * the write below block, but the constructor's busy_timeout (BUSY_TIMEOUT_MS) already
 * covers each attempt's wait; the retry only re-reads the mode, it never waits on its own.
 */
function ensureWAL(db: Database.Database, dbPath: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      if (journalMode(db) === "wal") return;
      db.pragma("journal_mode = WAL");
      return;
    } catch (err) {
      if (!isBusyError(err)) throw openFailureError(err, dbPath);
      if (attempt >= WAL_OPEN_ATTEMPTS) {
        throw new DBBusyError(
          `The ledger at ${dbPath} is in use by another process and did not free up in time.`,
          { cause: err },
        );
      }
    }
  }
}

/** Maps a non-busy journal-conversion failure to its actual cause instead of one catch-all message. */
function openFailureError(err: unknown, dbPath: string): DBNotReadyError {
  const code = sqliteErrorCode(err);
  if (NOT_WRITABLE_CODES.has(code)) {
    return new DBNotReadyError(
      `The ledger at ${dbPath} is not writable (${code}): check the file's permissions ` +
        "and the volume it sits on.",
      { cause: err },
    );
  }
  if (isDamagedDBError(err)) {
    return new DBNotReadyError(
      `Failed to open database. ${dbPath} is not a database OpenLedger can read. ` +
        "Move it aside (keep a backup) and re-run to start a fresh one.",
      { cause: err },
    );
  }
  return new DBNotReadyError(`Cannot open the ledger at ${dbPath}: ${errorMessage(err)}`, { cause: err });
}

// libsql answers every pragma read with `[{ <name>: value }]` and ignores `{ simple: true }`; an
// empty array is also possible, so the row is optional-chained rather than destructured.
function journalMode(db: Database.Database): string {
  const rows = db.pragma("journal_mode") as { journal_mode: string }[];
  return rows[0]?.journal_mode ?? "";
}
