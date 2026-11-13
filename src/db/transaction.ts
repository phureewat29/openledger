import type Database from "libsql";

/** libsql's `transaction()` cannot nest: a call inside an open transaction joins it. A new one is IMMEDIATE, since a deferred read-then-write fails on lock upgrade. */
export function inTransaction<T>(db: Database.Database, fn: () => T): T {
  if (db.inTransaction) return requireSync(fn());
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = requireSync(fn());
    db.exec("COMMIT");
    return value;
  } catch (err) {
    // SQLite may already have rolled back (SQLITE_FULL); a second ROLLBACK would throw over `err`.
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}

function requireSync<T>(value: T): T {
  if (typeof (value as PromiseLike<unknown> | null)?.then === "function") {
    throw new Error("inTransaction needs a synchronous fn: the unit would end before its awaited writes");
  }
  return value;
}
