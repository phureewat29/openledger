import { difference, dropRight } from "es-toolkit";
import type Database from "libsql";
import { copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DBNotReadyError } from "./errors.js";
import { MIGRATIONS, type Migration } from "./migrations/index.js";
import { ISO_NOW_SQL } from "./timestamps.js";

// A migration may drop tables (0002 rebaselines v1); the file is copied aside first.
export function migrate(db: Database.Database, dbPath?: string): void {
  applyMigrations(db, MIGRATIONS, dbPath);
}

/** Migrations are a parameter, not a direct import, so tests can drive a synthetic manifest. */
export function applyMigrations(
  db: Database.Database,
  migrations: Migration[],
  dbPath?: string,
): void {
  const current = currentVersion(db);

  if (current > migrations.length) throw newerThanBuildError(current, migrations.length);
  // The path every open after the first takes, before any write lock or file copy.
  if (current === migrations.length) return;

  // A version-0 database that reaches here is empty; only an upgrade has anything worth copying.
  if (dbPath && current >= 1) backupDatabase(db, dbPath);

  for (let i = current; i < migrations.length; i++) {
    applyMigration(db, migrations[i], i + 1, migrations.length, dbPath);
  }
}

/** Shared by the pre-lock guard and the in-transaction re-check below, so the two cannot drift. */
function newerThanBuildError(current: number, manifestLength: number): DBNotReadyError {
  return new DBNotReadyError(
    `Database schema version ${current} is newer than this build supports ` +
      `(${manifestLength}). Upgrade OpenLedger to open this database.`,
  );
}

/**
 * IMMEDIATE so a concurrent opener waits for the write lock instead of failing on the
 * first write, and the version is re-read under that lock: the waiter must see the
 * winner's rows and skip a migration already applied, or its stamp collides on the
 * schema_migrations primary key. That re-read can also land past this build's own
 * manifest (a newer-build winner stamped a version this build has no migration for),
 * which must throw rather than fall into the "already applied" skip below it.
 */
function applyMigration(
  db: Database.Database,
  migration: Migration,
  version: number,
  manifestLength: number,
  dbPath?: string,
): void {
  const apply = db.transaction((): void => {
    const applied = currentVersion(db);
    if (applied > manifestLength) throw newerThanBuildError(applied, manifestLength);
    if (applied >= version) return;
    if (applied === 0) refuseForeignDatabase(db, dbPath);

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (${ISO_NOW_SQL})
      );
    `);
    migration.up(db);
    db.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(version);
  });
  apply.immediate();
}

/**
 * Every migration is CREATE TABLE IF NOT EXISTS, so a foreign database would otherwise be
 * half-adopted in silence. It runs under the migration's write lock because outside one a
 * concurrent opener's freshly committed tables read as somebody else's database.
 */
function refuseForeignDatabase(db: Database.Database, dbPath?: string): void {
  if (!hasUserTables(db)) return;
  const at = dbPath ? ` at ${dbPath}` : "";
  throw new DBNotReadyError(
    `This database${at} is not an OpenLedger database. Your data has not been ` +
      `touched. Back up the file, then remove it to start fresh.`,
  );
}

function currentVersion(db: Database.Database): number {
  const table = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1`,
    )
    .get();
  if (!table) return 0;
  const row = db
    .prepare(`SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`)
    .get() as { version: number };
  return row.version;
}

/** Feeds the schema half of `doctor`. */
export function listMissingTables(db: Database.Database, tables: string[]): string[] {
  const placeholders = tables.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...tables) as { name: string }[];
  return difference(tables, rows.map((r) => r.name));
}

function hasUserTables(db: Database.Database): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'
        LIMIT 1`,
    )
    .get();
  return !!row;
}

/**
 * Folds the WAL into the main file first, or the copy would miss every committed row still in
 * it. A rollback-journal database has no WAL and the checkpoint is a no-op there. SQLite never
 * throws BUSY from this pragma: a concurrent reader makes it return a `busy: 1` row instead, so
 * the copy then reflects the last checkpointed state, older than the live database but never
 * torn. A thrown error here is a real failure (disk full, I/O) and must abort the upgrade rather
 * than let copyFileSync produce a backup that is silently missing rows.
 */
function backupDatabase(db: Database.Database, dbPath: string): void {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  copyFileSync(dbPath, `${dbPath}.${backupStamp()}.bak`);
  pruneBackups(dbPath);
}

function backupStamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Keeps the five newest `<dbPath>.<stamp>.bak` copies. */
function pruneBackups(dbPath: string): void {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.`;
  // The fixed-width stamp makes lexicographic order chronological.
  const backups = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .sort();
  for (const name of dropRight(backups, 5)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Housekeeping mid-migration: an undeletable stale copy must not fail an upgrade the new backup already covers.
    }
  }
}
