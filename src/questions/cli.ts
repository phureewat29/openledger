import type { Command } from "commander";
import { partition, uniq } from "es-toolkit";
import {
  listQuestions as queryQuestions,
  countQuestions,
  clampQuestionsLimit,
  closeQuestion,
  deferQuestion as deferQuestionRow,
  findQuestionById,
  type QuestionRow,
} from "./queries.js";
import { prepareRedaction } from "../privacy/redactor.js";
import { cappedSummary, runAction, type Invocation } from "../cli/output.js";
import type { Column } from "../cli/format.js";
import { fail } from "../cli/errors.js";
import { redactionEnabled } from "../cli/input.js";
import { clampOffset } from "../lib/limit.js";
import { openLedger } from "../config/cli.js";
import { inTransaction } from "../db/transaction.js";
import * as z from "zod";
import { parseInput, str, int } from "../lib/validate.js";
import { parseJSONOrNull } from "../lib/json.js";
import type {
  AnsweredQuestion,
  DeferredQuestion,
  Question,
  QuestionsAnswerSummary,
  QuestionsDeferSummary,
} from "../contract/questions.js";

function toListRow(row: QuestionRow): Question {
  return {
    id: row.id,
    kind: row.kind,
    prompt: row.prompt,
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    context: parseJSONOrNull(row.context_json),
    file_id: row.file_id,
    created_at: row.created_at,
  };
}

/** `prompt` is the only free-text field; context is structured JSON the agent needs verbatim. */
const QUESTION_REDACT_FIELDS = ["prompt"] as const;

const LIST_COLUMNS: Column<Question>[] = [
  { header: "ID", value: (r) => r.id },
  { header: "Kind", value: (r) => r.kind ?? "" },
  { header: "Prompt", value: (r) => r.prompt },
  { header: "Transaction ID", value: (r) => r.transaction_id ?? "" },
  { header: "Account ID", value: (r) => r.account_id ?? "" },
  { header: "Context", value: (r) => (r.context != null ? JSON.stringify(r.context) : "") },
  { header: "File ID", value: (r) => r.file_id ?? "" },
  { header: "Created At", value: (r) => r.created_at },
];

const ANSWERED_COLUMNS: Column<AnsweredQuestion>[] = [
  { header: "ID", value: (r) => r.id },
  { header: "Kind", value: (r) => r.kind ?? "" },
  { header: "Answer", value: (r) => r.answer },
  { header: "Rule Key", value: (r) => r.rule_key ?? "" },
];

const DEFER_COLUMNS: Column<DeferredQuestion>[] = [
  { header: "ID", value: (r) => r.id },
  { header: "Days", value: (r) => String(r.days) },
];

interface ListQuestionsOpts {
  includeDeferred?: boolean;
  redact?: boolean;
}

const LIST_QUESTIONS_SPEC = z.object({
  batch: str().optional(),
  limit: int().optional(),
  offset: int().optional(),
});

async function listQuestions(ctx: Invocation, opts: ListQuestionsOpts): Promise<void> {
  const parsed = parseInput(LIST_QUESTIONS_SPEC, opts);
  const { config, db } = await openLedger(ctx);
  const redact = prepareRedaction(redactionEnabled(opts), config);
  // One filter object for both queries, so `total` counts what the list filtered.
  const filter = { batch_id: parsed.batch, includeDeferred: !!opts.includeDeferred };
  const rows = queryQuestions(db, { ...filter, limit: parsed.limit, offset: parsed.offset });
  const listRows = redact(rows.map(toListRow), QUESTION_REDACT_FIELDS);
  ctx.out.emitList(listRows, LIST_COLUMNS);
  const total = countQuestions(db, filter);
  ctx.out.emitSummary(
    cappedSummary(
      total,
      listRows.length,
      clampQuestionsLimit(parsed.limit),
      clampOffset(parsed.offset),
    ),
  );
}

const ANSWER_SPEC = z.object({
  answer: str(),
  also: str().optional(),
});

async function answerQuestion(
  ctx: Invocation,
  id: string,
  opts: Record<string, unknown>,
): Promise<void> {
  const parsed = parseInput(ANSWER_SPEC, opts);
  const also: string[] = parsed.also
    ? parsed.also.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // Deduped: a repeated id (e.g. the primary id echoed back into --also) must
  // answer once, not delete once and then fail NOT_FOUND on its own second pass.
  const ids = uniq([id, ...also]);

  const { db } = await openLedger(ctx);

  // One transaction, every id resolved before any closes: closing is irreversible, so a
  // bogus id or a failure partway through the list must not cost the ids before it.
  const results = inTransaction(db, (): AnsweredQuestion[] => {
    const [found, missing] = partition(ids, (qid) => !!findQuestionById(db, qid));
    if (missing.length > 0) {
      fail(
        "NOT_FOUND",
        `question(s) not found: ${missing.map((m) => `"${m}"`).join(", ")}`,
        found.length ? { hint: `these ids do exist: ${found.join(", ")}` } : undefined,
      );
    }

    return ids.map((qid) => {
      const closed = closeQuestion(db, qid, parsed.answer);
      if (!closed) throw new Error(`question "${qid}" vanished mid-answer`);
      return { id: qid, kind: closed.kind, answer: closed.answer, rule_key: closed.rule_key };
    });
  });
  ctx.out.emitList(results, ANSWERED_COLUMNS);
  // `ids` is deduped, so the siblings are whatever --also added beyond the named id.
  const summary: Omit<QuestionsAnswerSummary, "type"> = {
    answered: results.length,
    closed_siblings: results.length - 1,
  };
  ctx.out.emitSummary(summary);
}

const DEFER_SPEC = z.object({
  days: int().default(7),
});

async function deferQuestion(
  ctx: Invocation,
  id: string,
  opts: Record<string, unknown>,
): Promise<void> {
  const parsed = parseInput(DEFER_SPEC, opts);
  const { db } = await openLedger(ctx);
  if (!deferQuestionRow(db, id, parsed.days)) fail("NOT_FOUND", `question "${id}" not found`);
  ctx.out.emitList([{ id, days: parsed.days }], DEFER_COLUMNS);
  const summary: Omit<QuestionsDeferSummary, "type"> = { deferred: 1 };
  ctx.out.emitSummary(summary);
}

export function registerQuestions(program: Command): void {
  const questions = program
    .command("questions")
    .description("List, answer, and defer open questions")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: the harness opens a question when a row is ambiguous; you list them, then answer or defer.",
        "Typical flow: list --json, resolve each by kind, then answer (--also <id,id> closes siblings) or defer.",
        "By kind: similar_accounts -> accounts merge; uncategorized -> transactions recategorize, then merchants set-default; unknown_merchant -> merchants upsert or update; dirty_input -> read the question's reason: fix the bad row (date, description, amount) or the account ids it names, then re-run ingest commit; currency_mismatch -> when both ledgers exist, re-post as linked legs through <currency>:equity:conversion (one per ledger, sharing a group); when the named ledger doesn't exist yet, open it with accounts create or fix the prefix, then re-run ingest commit.",
        "Example: oled questions list --json",
      ].join("\n"),
    );

  questions
    .command("list")
    .description("List questions")
    .option("--batch <id>", "filter by batch id")
    .option("--limit <n>", "max rows (default 200, max 1000)")
    .option("--offset <n>", "rows to skip; repeat with offset += returned while the summary says has_more")
    .option("--include-deferred", "include deferred questions")
    .option("--no-redact", "skip PII redaction (on by default)")
    .addHelpText(
      "after",
      "\nThe summary row carries total/returned/has_more: while has_more is true, repeat with offset += returned.",
    )
    .action(runAction(listQuestions));

  questions
    .command("answer <id>")
    .description("Answer a question")
    .option("--answer <text>", "the answer text")
    .option("--also <ids>", "additional question ids to answer")
    .addHelpText(
      "after",
      [
        "",
        "Behavior: records the answer and closes the question. Closing is final; there is no reopen.",
        "  Make the ledger fix first (recategorize, merge, upsert), then answer to record what you did.",
        "  --also takes a comma-separated list: --also cn:aaa,cn:bbb. Every id must exist or nothing closes.",
        'Example: oled questions answer cn:abc --answer "booked to thb:expense:pet:grooming" --json',
      ].join("\n"),
    )
    .action(runAction(answerQuestion));

  questions
    .command("defer <id>")
    .description("Defer a question")
    .option("--days <n>", "number of days to defer (default to one week)")
    .action(runAction(deferQuestion));
}
