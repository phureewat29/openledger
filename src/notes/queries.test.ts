import { describe, it, expect, beforeEach } from "vitest";
import type Database from "libsql";
import { addNote, countNotes, deleteNote, listNotes } from "./queries.js";
import { freshDB } from "../../fixtures/db.js";

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("addNote", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDB();
  });

  it("returns the stored row, created_at included", () => {
    const note = addNote(db, "Rent is paid on the 1st", "fact");
    expect(note.created_at).toMatch(ISO_TIMESTAMP_RE);
    expect(listNotes(db)).toMatchObject([
      { id: note.id, content: "Rent is paid on the 1st", category: "fact", created_at: note.created_at },
    ]);
  });

  it("returns the existing row for a verbatim (category, content) repeat", () => {
    const first = addNote(db, "Prefer short names", "preference");
    const again = addNote(db, "Prefer short names", "preference");
    expect(again.id).toBe(first.id);
    expect(countNotes(db)).toBe(1);
  });

  it("keeps the same content under another category as a separate note", () => {
    addNote(db, "Statements land in bank/", "rule");
    addNote(db, "Statements land in bank/", "fact");
    expect(countNotes(db)).toBe(2);
  });
});

describe("listNotes", () => {
  it("breaks a created_at tie newest insert first", () => {
    const db = freshDB();
    const ids = ["first", "second", "third"].map((content) => addNote(db, content, "fact").id);
    db.prepare(`UPDATE notes SET created_at = '2026-01-01T00:00:00.000Z'`).run();
    expect(listNotes(db).map((note) => note.id)).toEqual(ids.toReversed());
  });
});

describe("deleteNote", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDB();
  });

  it("removes the note and returns the row it removed", () => {
    const note = addNote(db, "Rent is paid on the 1st", "fact");
    expect(deleteNote(db, note.id)).toMatchObject({
      id: note.id,
      content: "Rent is paid on the 1st",
      category: "fact",
      created_at: note.created_at,
    });
    expect(countNotes(db)).toBe(0);
  });

  it("returns null and removes nothing when no note has the id", () => {
    addNote(db, "Rent is paid on the 1st", "fact");
    expect(deleteNote(db, 9999)).toBeNull();
    expect(countNotes(db)).toBe(1);
  });
});
