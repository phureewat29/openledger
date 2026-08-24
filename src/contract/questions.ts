import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { CappedSummary, Summary } from "./primitives.js";

/** `prompt` is redacted by default. */
export const Question = z.object({
  id: z.string(),
  kind: z.string().nullable(),
  prompt: z.string(),
  transaction_id: z.string().nullable(),
  account_id: z.string().nullable(),
  /**
   * The kind's own structured payload, passed through unvalidated: narrow it by
   * `kind` before reading. null when the question carries none, or when the
   * stored blob failed to parse.
   */
  context: z.unknown(),
  file_id: z.string().nullable(),
  created_at: z.iso.datetime(),
});
export type Question = z.infer<typeof Question>;

/** `questions answer`'s row: one per question closed, the named id first. */
export const AnsweredQuestion = z.object({
  id: z.string(),
  kind: z.string().nullable(),
  answer: z.string(),
  /** The signature a learned rule keys on; null learns nothing. */
  rule_key: z.string().nullable(),
});
export type AnsweredQuestion = z.infer<typeof AnsweredQuestion>;

export const QuestionsAnswerSummary = Summary.extend({
  answered: z.number().int(),
  /** The `--also` ids closed beside the named one, de-duplicated. */
  closed_siblings: z.number().int(),
});
export type QuestionsAnswerSummary = z.infer<typeof QuestionsAnswerSummary>;

export const DeferredQuestion = z.object({
  id: z.string(),
  days: z.number().int(),
});
export type DeferredQuestion = z.infer<typeof DeferredQuestion>;

export const QuestionsDeferSummary = Summary.extend({
  deferred: z.number().int(),
});
export type QuestionsDeferSummary = z.infer<typeof QuestionsDeferSummary>;

export const QUESTIONS_CONTRACTS = {
  "questions list": { lines: [Question, CappedSummary], summary: "capped" },
  "questions answer": { lines: [AnsweredQuestion, QuestionsAnswerSummary], summary: "plain" },
  "questions defer": { lines: [DeferredQuestion, QuestionsDeferSummary], summary: "plain" },
} as const satisfies Record<string, CommandContract>;
