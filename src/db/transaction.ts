import type Database from "libsql";

/**
 * libsql's `transaction()` cannot nest, so a call made inside an open transaction joins it
 * and commits or rolls back with the caller. A new one is IMMEDIATE: a deferred
 * read-then-write fails on the lock upgrade without waiting out busy_timeout.
 */
export function inTransaction<T>(db: Database.Database, fn: () => T): T {
  if (db.inTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (err) {
    // SQLite has already rolled back on SQLITE_FULL; libsql's wrapper would ROLLBACK again and throw over `err`.
    if (db.inTransaction) db.exec("ROLLBACK");
    throw err;
  }
}
