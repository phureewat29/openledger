import type { Command } from "commander";
import {
  listNotes as queryNotes,
  addNote as addNoteRow,
  deleteNote as deleteNoteRow,
  type NoteRow,
} from "./queries.js";
import { NOTE_CATEGORIES } from "../contract/enums.js";
import { prepareRedaction } from "../privacy/redactor.js";
import { runAction, type Invocation } from "../cli/output.js";
import type { Column } from "../cli/format.js";
import { fail } from "../cli/errors.js";
import { redactionEnabled, requireYes } from "../cli/input.js";
import { openLedger } from "../config/cli.js";
import * as z from "zod";
import { parseInput, str, num } from "../lib/validate.js";
import type {
  NotesAddSummary,
  NotesListSummary,
  NotesRemoveSummary,
} from "../contract/notes.js";

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

async function listNotes(ctx: Invocation, opts: ListNotesOpts): Promise<void> {
  const { config, db } = await openLedger(ctx.configPath);
  const redact = prepareRedaction(redactionEnabled(opts), config);
  const rows = redact(queryNotes(db), NOTE_REDACT_FIELDS);
  ctx.out.emitList(rows, NOTE_COLUMNS);
  const summary: Omit<NotesListSummary, "type"> = { total: rows.length, returned: rows.length };
  ctx.out.emitSummary(summary);
}

const ADD_NOTE_SPEC = z.object({
  content: str(),
  category: z.enum(NOTE_CATEGORIES).default("fact"),
});

async function addNote(ctx: Invocation, opts: Record<string, unknown>): Promise<void> {
  const parsed = parseInput(ADD_NOTE_SPEC, opts);
  const { db } = await openLedger(ctx.configPath);
  const saved = addNoteRow(db, parsed.content, parsed.category);
  ctx.out.emitList([saved], NOTE_COLUMNS);
  const summary: Omit<NotesAddSummary, "type"> = { added: 1 };
  ctx.out.emitSummary(summary);
}

const NOTE_ID_SPEC = z.object({ id: num() });
const NOTE_ID_LABELS = { id: "note id" };

async function removeNote(ctx: Invocation, id: string, opts: { yes?: boolean }): Promise<void> {
  requireYes(opts, "removing this note");
  const parsed = parseInput(NOTE_ID_SPEC, { id }, { labels: NOTE_ID_LABELS });

  const { db } = await openLedger(ctx.configPath);
  const deleted = deleteNoteRow(db, parsed.id);
  if (!deleted) fail("NOT_FOUND", `note "${id}" not found`);
  ctx.out.emitList([deleted], NOTE_COLUMNS);
  const summary: Omit<NotesRemoveSummary, "type"> = { removed: 1 };
  ctx.out.emitSummary(summary);
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
    .option(
      "--category <cat>",
      `note category: ${new Intl.ListFormat("en", { type: "disjunction" }).format(NOTE_CATEGORIES)}`,
    )
    .action(runAction(addNote));

  notes
    .command("rm <id>")
    .description("Remove a note")
    .option("--yes", "skip confirmation")
    .action(runAction(removeNote));
}
