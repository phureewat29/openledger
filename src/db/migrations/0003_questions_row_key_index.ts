import type Database from "libsql";

/** SQLite uses an expression index only for the identical expression: `ROW_KEY_SQL` in src/questions/queries.ts. */
export function up(db: Database.Database): void {
  db.exec(
    `CREATE INDEX IF NOT EXISTS questions_row_key_idx ON questions(json_extract(context_json, '$.row_key'))`,
  );
}
