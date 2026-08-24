import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { Summary } from "./primitives.js";

// `content` is redacted by default on list; `category` mirrors the notes.category CHECK
// (duplicated to keep the contract a leaf).
export const Note = z.object({
  id: z.number().int(),
  content: z.string(),
  category: z.enum(["rule", "preference", "fact"]),
  created_at: z.iso.datetime(),
});
export type Note = z.infer<typeof Note>;

export const NotesListSummary = Summary.extend({
  total: z.number().int(),
  returned: z.number().int(),
});
export type NotesListSummary = z.infer<typeof NotesListSummary>;

export const NotesAddSummary = Summary.extend({
  /** Always 1: a verbatim (category, content) repeat returns the existing note. */
  added: z.number().int(),
});
export type NotesAddSummary = z.infer<typeof NotesAddSummary>;

export const NotesRemoveSummary = Summary.extend({
  removed: z.number().int(),
});
export type NotesRemoveSummary = z.infer<typeof NotesRemoveSummary>;

export const NOTES_CONTRACTS = {
  "notes list": { lines: [Note, NotesListSummary], summary: "plain" },
  "notes add": { lines: [Note, NotesAddSummary], summary: "plain" },
  "notes rm": { lines: [Note, NotesRemoveSummary], summary: "plain" },
} as const satisfies Record<string, CommandContract>;
