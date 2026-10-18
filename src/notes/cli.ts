import type { Command } from "commander";
import {
  listNotes as queryNotes,
  addNote as addNoteRow,
  deleteNote as deleteNoteRow,
  type NoteRow,
} from "./queries.js";
import { applyRedaction } from "../privacy/redactor.js";
import { emitList, emitSummary, runAction, type Column } from "../cli/output.js";
import { fail } from "../cli/errors.js";
import { redactionEnabled, requireYes } from "../cli/input.js";
import { openDb } from "../db/connection.js";
import { requireConfig } from "../config/cli.js";
import * as z from "zod";
import { parseInput, str, num } from "../lib/validate.js";
import type {
  NotesAddSummary,
  NotesListSummary,
  NotesRemoveSummary,
} from "../contract/notes.js";

const VALID_CATEGORIES = ["rule", "preference", "fact"] as const;

// `content` is the only free-text field; id/category/created_at are structured data left verbatim.
const NOTE_REDACT_FIELDS = ["content"] as const;

const NOTE_COLUMNS: Column<NoteRow>[] = [
  { header: "ID", value: (r) => String(r.id), align: "right" },
  { header: "Category", value: (r) => r.category },
  { header: "Content", value: (r) => r.content },
  { header: "Created At", value: (r) => r.created_at },
];

interface ListNotesOpts {
  redact?: boolean;
}

async function listNotes(opts: ListNotesOpts, command: Command): Promise<void> {
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const rows = applyRedaction(
    queryNotes(db),
    redactionEnabled(opts),
    NOTE_REDACT_FIELDS,
    config,
  );
  emitList(rows, NOTE_COLUMNS);
  const summary: Omit<NotesListSummary, "type"> = { total: rows.length, returned: rows.length };
  emitSummary(summary);
}

const ADD_NOTE_SPEC = z.object({
  content: str(),
  category: z.enum(VALID_CATEGORIES).default("fact"),
});

async function addNote(opts: Record<string, unknown>, command: Command): Promise<void> {
  const parsed = parseInput(ADD_NOTE_SPEC, opts);
  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const saved = addNoteRow(db, parsed.content, parsed.category);
  emitList([saved], NOTE_COLUMNS);
  const summary: Omit<NotesAddSummary, "type"> = { added: 1 };
  emitSummary(summary);
}

// Positional `<id>` args aren't commander opts; parsed through the same spec API with an ad hoc object.
const NOTE_ID_SPEC = z.object({ id: num() });
const NOTE_ID_LABELS = { id: "note id" };

async function removeNote(id: string, opts: { yes?: boolean }, command: Command): Promise<void> {
  requireYes(opts, "removing this note");
  const parsed = parseInput(NOTE_ID_SPEC, { id }, { labels: NOTE_ID_LABELS });

  const config = requireConfig(command);
  const db = await openDb(config.dbPath);
  const deleted = deleteNoteRow(db, parsed.id);
  if (!deleted) fail("NOT_FOUND", `note "${id}" not found`);
  emitList([deleted], NOTE_COLUMNS);
  const summary: Omit<NotesRemoveSummary, "type"> = { removed: 1 };
  emitSummary(summary);
}

export function registerNotes(program: Command): void {
  const notes = program.command("notes").description("Manage freeform notes");

  notes
    .command("list")
    .description("List notes")
    .option("--no-redact", "skip PII redaction (on by default)")
    .action(runAction(listNotes));

  notes
    .command("add")
    .description("Add a note")
    .option("--content <text>", "note content")
    .option("--category <cat>", "note category: rule, preference, or fact")
    .action(runAction(addNote));

  notes
    .command("rm <id>")
    .description("Remove a note")
    .option("--yes", "skip confirmation")
    .action(runAction(removeNote));
}
