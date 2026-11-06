import type Database from "libsql";
import * as baseline from "./0001_baseline.js";
import * as rebaseline from "./0002_rebaseline.js";
import * as questionsRowKeyIndex from "./0003_questions_row_key_index.js";

/** A forward migration. Its position in MIGRATIONS is its version (index 0 = v1). */
export interface Migration {
  up(db: Database.Database): void;
}

/** Explicit list (no fs glob) so bare `tsc` type-checks it. Append only; never reorder or remove. */
export const MIGRATIONS: Migration[] = [baseline, rebaseline, questionsRowKeyIndex];
