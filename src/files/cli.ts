import type { Command } from "commander";
import type Database from "libsql";
import { type Column, emitList, emitObject, emitSummary, runAction } from "../cli/output.js";
import { fail } from "../cli/errors.js";
import { requireYes } from "../cli/input.js";
import { openDb } from "../db/connection.js";
import { requireConfig } from "../config/cli.js";
import {
  FILE_STATUSES,
  deleteFile,
  findFileById,
  listFiles as queryFiles,
  type FileRow,
  type FileStatus,
} from "./queries.js";
import { countTransactionsBySourceFile } from "../transactions/queries.js";
import { countQuestions } from "../questions/queries.js";
import { cleanCache } from "./files.js";
import type {
  FileDetail,
  FileDropResult,
  FileRecord,
  FilesListSummary,
} from "../contract/files.js";

export function requireFile(db: Database.Database, id: string, hint?: string): FileRow {
  const row = findFileById(db, id);
  if (!row) fail("NOT_FOUND", `no file: ${id}`, hint ? { hint } : undefined);
  return row;
}

const FILE_COLUMNS: Column<FileRecord>[] = [
  { header: "Status", value: (r) => r.status },
  { header: "ID", value: (r) => r.id },
  { header: "Source", value: (r) => r.source ?? "-" },
  { header: "Ingested At", value: (r) => r.ingested_at ?? "-" },
  { header: "Path", value: (r) => r.path },
];

interface ListFilesOpts {
  status?: string;
}

async function listFiles(opts: ListFilesOpts, command: Command): Promise<void> {
  // Checked up front: an unrecognized status would otherwise silently return zero rows.
  const { status } = opts;
  if (status !== undefined && !FILE_STATUSES.includes(status as FileStatus)) {
    fail("USAGE", `--status must be one of ${FILE_STATUSES.join("|")}, got "${status}"`);
  }

  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const rows = queryFiles(db);
  const shown = status ? rows.filter((r) => r.status === status) : rows;
  emitList(shown, FILE_COLUMNS);
  const summary: Omit<FilesListSummary, "type"> = {
    total: rows.length,
    returned: shown.length,
    // Empty must not read as "nothing to do": registration happens at ingest, not here.
    ...(rows.length === 0
      ? { hint: "files lists what ingest already registered; new statements in the data dir appear with `oled ingest list`" }
      : {}),
  };
  emitSummary(summary);
}

async function showFile(id: string, _opts: Record<string, unknown>, command: Command): Promise<void> {
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const row = requireFile(db, id, "run `oled files list --json` for the ids");

  const detail: FileDetail = {
    type: "file_detail",
    ...row,
    transaction_count: countTransactionsBySourceFile(db, id),
    open_question_count: countQuestions(db, { file_id: id }),
  };
  emitObject(detail);
}

interface DropFileOpts {
  yes?: boolean;
}

async function dropFile(id: string, opts: DropFileOpts, command: Command): Promise<void> {
  requireYes(opts, `dropping file ${id}`);
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  requireFile(db, id, "run `oled files list --json` for the ids");
  const res = deleteFile(db, id);

  // Same cache purge `ingest done`/`fail` do: nothing can reach the extracted text once the row is gone.
  const { removed } = cleanCache(config.cacheDir, id);
  const dropped: FileDropResult = {
    file_id: id,
    removed_transactions: res.removedTransactions,
    removed_questions: res.removedQuestions,
    unvoided: res.unvoided,
    cache_removed: removed,
  };
  emitObject(dropped);
}

export function registerFiles(program: Command): void {
  const files = program.command("files").description("Browse ingested files (list / show / drop)");

  files
    .command("list")
    .description("List ingested files")
    .option("--status <status>", `filter by status (${FILE_STATUSES.join("|")})`)
    .action(runAction(listFiles));

  files
    .command("show <id>")
    .description("Show a file with its transaction and open-question counts")
    .action(runAction(showFile));

  files
    .command("drop <id>")
    .description("Drop a file and cascade-remove its transactions/questions")
    .option("--yes", "skip confirmation")
    .action(runAction(dropFile));
}
