import type { Command } from "commander";
import type Database from "libsql";
import { runAction, type Invocation } from "../cli/output.js";
import type { Column } from "../cli/format.js";
import { fail } from "../cli/errors.js";
import { requireYes } from "../cli/input.js";
import { openLedger } from "../config/cli.js";
import { parseInput } from "../lib/validate.js";
import * as z from "zod";
import { FILE_STATUSES } from "../contract/enums.js";
import {
  deleteFile,
  findFileById,
  listFiles as queryFiles,
  type FileRow,
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

const LIST_FILES_SPEC = z.object({ status: z.enum(FILE_STATUSES).optional() });

async function listFiles(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const { status } = parseInput(LIST_FILES_SPEC, opts);
  const { db } = await openLedger(ctx.configPath);
  const rows = queryFiles(db);
  const shown = status ? rows.filter((r) => r.status === status) : rows;
  ctx.out.emitList(shown, FILE_COLUMNS);
  const summary: Omit<FilesListSummary, "type"> = {
    total: rows.length,
    returned: shown.length,
    // Empty must not read as "nothing to do": registration happens at ingest, not here.
    ...(rows.length === 0
      ? { hint: "files lists what ingest already registered; new statements in the data dir appear with `oled ingest list`" }
      : {}),
  };
  ctx.out.emitSummary(summary);
}

async function showFile(ctx: Invocation, id: string): Promise<void> {
  const { db } = await openLedger(ctx.configPath);
  const row = requireFile(db, id, "run `oled files list --json` for the ids");

  const detail: FileDetail = {
    type: "file_detail",
    ...row,
    transaction_count: countTransactionsBySourceFile(db, id),
    open_question_count: countQuestions(db, { file_id: id }),
  };
  ctx.out.emitObject(detail);
}

interface DropFileOpts {
  yes?: boolean;
}

async function dropFile(ctx: Invocation, id: string, opts: DropFileOpts): Promise<void> {
  requireYes(opts, `dropping file ${id}`);
  const { config, db } = await openLedger(ctx.configPath);
  requireFile(db, id, "run `oled files list --json` for the ids");
  const deleted = deleteFile(db, id);

  // Nothing can reach the extracted text once the row is gone.
  const { removed } = cleanCache(config.cacheDir, id);
  const dropped: FileDropResult = {
    file_id: id,
    removed_transactions: deleted.removedTransactions,
    removed_questions: deleted.removedQuestions,
    unvoided: deleted.unvoided,
    cache_removed: removed,
  };
  ctx.out.emitObject(dropped);
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
