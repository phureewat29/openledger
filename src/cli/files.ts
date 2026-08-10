import type Database from "libsql";
import { findFileById, type FileRow } from "../db/queries/files.js";
import { fail } from "./output.js";

export function requireFile(db: Database.Database, id: string, hint?: string): FileRow {
  const row = findFileById(db, id);
  if (!row) fail("NOT_FOUND", `no file: ${id}`, hint ? { hint } : undefined);
  return row;
}
