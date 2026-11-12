import type Database from "libsql";
import { inTransaction } from "../db/transaction.js";
import { NOTE_CATEGORIES } from "../contract/enums.js";

type NoteCategory = (typeof NOTE_CATEGORIES)[number];

export interface NoteRow {
  id: number;
  content: string;
  category: NoteCategory;
  created_at: string;
}

const ROW_COLUMNS = "id, content, category, created_at";

export function listNotes(db: Database.Database): NoteRow[] {
  return db.prepare(
    `SELECT ${ROW_COLUMNS} FROM notes ORDER BY created_at DESC, id DESC`,
  ).all() as NoteRow[];
}

export function countNotes(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM notes`).get() as { n: number };
  return row.n;
}

/** Idempotent on (category, content): a verbatim repeat returns the existing row unchanged. Semantic dedup is the calling agent's job. */
export function addNote(db: Database.Database, content: string, category: NoteCategory): NoteRow {
  return inTransaction(db, () => {
    const existing = db
      .prepare(`SELECT ${ROW_COLUMNS} FROM notes WHERE category = ? AND content = ? LIMIT 1`)
      .get(category, content) as NoteRow | undefined;
    if (existing) return existing;
    return db
      .prepare(`INSERT INTO notes (content, category) VALUES (?, ?) RETURNING ${ROW_COLUMNS}`)
      .get(content, category) as NoteRow;
  });
}

export function deleteNote(db: Database.Database, id: number): NoteRow | null {
  const row = db
    .prepare(`DELETE FROM notes WHERE id = ? RETURNING ${ROW_COLUMNS}`)
    .get(id) as NoteRow | undefined;
  return row ?? null;
}
