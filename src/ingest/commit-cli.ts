import type Database from "libsql";
import { countBy, isPlainObject, memoize, sumBy } from "es-toolkit";
import {
  commitLinkedTransactions,
  commitTransaction,
  type TransactionCommitContext,
  type LinkedTransactionHeader,
  type LinkedTransactionLeg,
} from "./commit.js";
import type { RawTransactionInput } from "./refuse.js";
import type {
  CommitCompoundResult,
  CommitFailureReason,
  CommitFailureResult,
  CommitResult,
  CommitStandaloneResult,
  CommitSummary,
} from "../contract/ingest.js";
import type { Invocation, Output } from "../cli/output.js";
import { fail, toCLIError, tryBatchItem } from "../cli/errors.js";
import { readStdinBatch } from "../cli/input.js";
import { openLedger } from "../config/cli.js";
import { noiseTokens } from "../datasets/datasets.js";
import type { ExitCode } from "../contract/exit.js";
import { newBatchId } from "../lib/ids.js";
import { findFileById } from "../files/queries.js";
import { countTransactionsBySourceFile } from "../transactions/queries.js";
import { countQuestions } from "../questions/queries.js";
import * as z from "zod";
import { safeParse, str, num, json } from "../lib/validate.js";
import type { MerchantUpsertInput } from "../merchants/queries.js";
import { requireFile } from "../files/cli.js";

interface CommitIngestOpts {
  file?: string;
  input?: string;
}

/**
 * The store trims canonical_name too; validating here turns a malformed merchant into dirty input, not a row crash.
 */
const MERCHANT_INPUT = json(
  z.object({
    canonical_name: z.string().trim().min(1),
    alias: z
      .string()
      .nullish()
      .transform((alias) => alias ?? undefined),
    default_account_id: z.string().nullish(),
  }) satisfies z.ZodType<MerchantUpsertInput>,
  "a merchant object {canonical_name, alias?, default_account_id?} with a non-empty canonical_name",
)
  .nullable()
  .default(null);

/**
 * validateRawTransaction is the validity authority: missing fields default to "" and surface as dirty_input.
 * amount is excluded so its raw type reaches the validator's typeof check, unconverted by num().
 */
const LINKED_HEADER_SPEC = z.object({
  date: str().default(""),
  description: str().default(""),
  raw_descriptor: str().nullable().default(null),
  source_page: num().nullable().default(null),
  source_file_id: str().nullable().optional(),
  merchant: MERCHANT_INPUT,
  merchant_id: str().nullable().default(null),
  group_id: str().nullable().default(null),
  row_index: num().nullable().default(null),
});

const LINKED_LEG_SPEC = z.object({
  debit_account_id: str().default(""),
  credit_account_id: str().default(""),
  currency: str().nullable().default(null),
  description: str().optional(),
});

const STANDALONE_SPEC = z.object({
  id: str().optional(),
  date: str().default(""),
  description: str().default(""),
  raw_descriptor: str().nullable().default(null),
  source_page: num().nullable().default(null),
  source_file_id: str().nullable().optional(),
  row_index: num().nullable().default(null),
  merchant: MERCHANT_INPUT,
  merchant_id: str().nullable().default(null),
  debit_account_id: str().default(""),
  credit_account_id: str().default(""),
  currency: str().nullable().default(null),
});

/** debit/credit accept a snake_case synonym that isn't the camelCase auto-bridge. */
const LEG_ALIASES = {
  debit_account_id: ["debit_account"],
  credit_account_id: ["credit_account"],
};

type ContextFor = (sourceFileId: string | null | undefined) => TransactionCommitContext;

function failRow(index: number, message: string): CommitFailureResult {
  return failOutcome(index, { reason: "dirty_input", message, raisedQuestions: 0 });
}

function failOutcome(
  index: number,
  outcome: {
    reason: CommitFailureReason;
    message: string;
    raisedQuestions: number;
    unopenedLedger?: string;
  },
): CommitFailureResult {
  return {
    type: "result",
    index,
    ok: false,
    reason: outcome.reason,
    message: outcome.message,
    raised_questions: outcome.raisedQuestions,
    ...(outcome.unopenedLedger ? { unopened_ledger: outcome.unopenedLedger } : {}),
  };
}

function commitCompoundRow(
  db: Database.Database,
  contextFor: ContextFor,
  record: Record<string, unknown>,
  index: number,
  linked: unknown[],
): CommitCompoundResult | CommitFailureResult {
  const parsedHeader = safeParse(LINKED_HEADER_SPEC, record);
  if (!parsedHeader.ok) return failRow(index, parsedHeader.error);

  const legs: LinkedTransactionLeg[] = [];
  for (const rawLeg of linked) {
    if (!isPlainObject(rawLeg)) return failRow(index, "each linked leg must be a JSON object.");
    const parsedLeg = safeParse(LINKED_LEG_SPEC, rawLeg, { aliases: LEG_ALIASES });
    if (!parsedLeg.ok) return failRow(index, parsedLeg.error);
    // Cast is a lie for malformed rows: validateRawTransaction rejects those.
    legs.push({ ...parsedLeg.value, amount: rawLeg.amount as number });
  }

  const ctx = contextFor(parsedHeader.value.source_file_id);
  const header: LinkedTransactionHeader = { ...parsedHeader.value, source_file_id: ctx.fileId };
  const outcome = commitLinkedTransactions(db, ctx, header, legs);
  if (!outcome.ok) return failOutcome(index, outcome);

  return {
    type: "result",
    index,
    ok: true,
    group_id: outcome.group_id,
    legs: outcome.results.map((r) => ({ transaction_id: r.id, duplicate: r.duplicate })),
    duplicate: outcome.results.every((r) => r.duplicate),
    currency_overridden: outcome.currencyOverridden,
    raised_questions: outcome.raisedQuestions,
    merchant: outcome.merchant,
  };
}

function commitStandaloneRow(
  db: Database.Database,
  contextFor: ContextFor,
  record: Record<string, unknown>,
  index: number,
): CommitStandaloneResult | CommitFailureResult {
  const parsed = safeParse(STANDALONE_SPEC, record, { aliases: LEG_ALIASES });
  if (!parsed.ok) return failRow(index, parsed.error);

  const ctx = contextFor(parsed.value.source_file_id);
  // Cast is a lie for malformed rows: validateRawTransaction rejects those.
  const raw: RawTransactionInput = {
    ...parsed.value,
    source_file_id: ctx.fileId,
    amount: record.amount as number,
  };
  const outcome = commitTransaction(db, ctx, raw);
  if (!outcome.ok) return failOutcome(index, outcome);

  return {
    type: "result",
    index,
    ok: true,
    transaction_id: outcome.transactionId,
    duplicate: outcome.duplicate,
    currency_overridden: outcome.currencyOverridden,
    raised_questions: outcome.raisedQuestions,
    merchant: outcome.merchant,
    sides: outcome.sides,
  };
}

export interface BatchContext {
  batchId: string;
  /** The `--file` id every row inherits unless it names its own. */
  file?: string;
  noise: readonly string[];
}

function commitRow(
  db: Database.Database,
  contextFor: ContextFor,
  item: unknown,
  index: number,
): CommitResult {
  if (!isPlainObject(item)) return failRow(index, "each transaction must be a JSON object.");
  const { linked } = item;
  if (Array.isArray(linked) && linked.length > 0) {
    return commitCompoundRow(db, contextFor, item, index, linked);
  }
  return commitStandaloneRow(db, contextFor, item, index);
}

function commitItem(
  db: Database.Database,
  contextFor: ContextFor,
  item: unknown,
  index: number,
): CommitResult {
  const committed = tryBatchItem(() => commitRow(db, contextFor, item, index));
  if (committed.ok) return committed.value;
  // Reason stays `unexpected_error` (not `dirty_input`): unknown whether the row or the database was at fault.
  return failOutcome(index, { reason: "unexpected_error", message: committed.error, raisedQuestions: 0 });
}

function rethrowMidBatch(thrown: unknown, results: CommitResult[]): never {
  const { posted } = tallyRows(results);
  const failure = toCLIError(thrown);
  if (failure.code !== "BUSY" || posted === 0) throw thrown;

  const resumeFrom = results.length;
  fail("BUSY", failure.message, {
    hint:
      `rows before index ${resumeFrom} already ran (${posted} posted, results above); ` +
      `re-run only the rows from index ${resumeFrom}, since re-running them all would post rows without a stable id twice`,
    details: { posted, resume_from_index: resumeFrom },
  });
}

/** Writes each row's result as it lands. A row with no source address posts under a random id, so a lock-aborted batch names the index to resume from. */
export function commitRows(
  out: Output,
  db: Database.Database,
  batch: BatchContext,
  items: unknown[],
): CommitResult[] {
  // file_hash makes transaction ids deterministic; caching it is sound because a commit never writes `files`.
  const fileHashOf = memoize((fileId: string) => findFileById(db, fileId)?.file_hash ?? null);
  const contextFor: ContextFor = (sourceFileId) => {
    const fileId = sourceFileId ?? batch.file ?? null;
    const fileHash = fileId ? fileHashOf(fileId) : null;
    return { batchId: batch.batchId, fileId, fileHash, noise: batch.noise };
  };

  const results: CommitResult[] = [];
  try {
    for (const [index, item] of items.entries()) {
      const result = commitItem(db, contextFor, item, index);
      out.emitObject(result);
      results.push(result);
    }
  } catch (thrown) {
    rethrowMidBatch(thrown, results);
  }
  return results;
}

type RowBucket = "posted" | "duplicates" | "failed";

const NO_ROWS: Record<RowBucket, number> = { posted: 0, duplicates: 0, failed: 0 };

function rowBucket(result: CommitResult): RowBucket {
  if (!result.ok) return "failed";
  return result.duplicate ? "duplicates" : "posted";
}

type BatchTally = Pick<CommitSummary, RowBucket | "raised_questions">;

/** Every row's result carries its own raised_questions, failures included. */
function tallyRows(results: CommitResult[]): BatchTally {
  return {
    ...NO_ROWS,
    ...countBy(results, rowBucket),
    raised_questions: sumBy(results, (r) => r.raised_questions),
  };
}

function reportBatch(out: Output, summary: Omit<CommitSummary, "type">): void {
  if (out.mode.kind === "json") {
    out.emitSummary(summary);
    return;
  }
  out.write(
    `\nbatch ${summary.batch_id}: ${summary.posted} posted, ${summary.duplicates} duplicate(s), ${summary.failed} failed, ${summary.raised_questions} question(s) raised\n`,
  );
  if (summary.file_id) {
    out.write(
      `file ${summary.file_id}: ${summary.file_transaction_count} transactions, ${summary.file_open_question_count} open questions\n`,
    );
  }
  if (summary.hint) out.write(`${summary.hint}\n`);
}

export async function commitIngest(
  ctx: Invocation,
  opts: CommitIngestOpts,
): Promise<ExitCode | undefined> {
  const items = await readStdinBatch(opts.input);
  if (items.length === 0) fail("USAGE", "no transaction data provided");

  const { config, db } = await openLedger(ctx);

  // An unknown --file id must fail before insert, else a null file hash breaks id determinism.
  // Held for the summary: a commit writes transactions, never `files`, so the status stays current.
  const fileRow = opts.file
    ? requireFile(
        db,
        opts.file,
        "run `oled ingest list --json` for the file ids, or drop --file to commit rows with no source file",
      )
    : null;

  // Must be non-null: raiseQuestion records nothing without a batch id.
  const batchId = newBatchId();
  const batch: BatchContext = { batchId, file: opts.file, noise: noiseTokens(config.country) };
  const tally = tallyRows(commitRows(ctx.out, db, batch, items));

  // Callers act on the summary, so an unfinished file has to be visible there.
  const pendingHint =
    fileRow?.status === "pending"
      ? `the file stays pending until \`oled ingest done ${fileRow.id}\` closes it`
      : null;

  // Queried after the row loop so the cumulative figures include this batch.
  const fileFacts = fileRow
    ? {
        file_id: fileRow.id,
        file_status: fileRow.status,
        file_transaction_count: countTransactionsBySourceFile(db, fileRow.id),
        file_open_question_count: countQuestions(db, { file_id: fileRow.id }),
      }
    : null;

  reportBatch(ctx.out, {
    batch_id: batchId,
    ...tally,
    ...(fileFacts ?? {}),
    ...(pendingHint ? { hint: pendingHint } : {}),
  });

  // Exit 7 only for genuine failures: duplicates are a successful no-op.
  return tally.failed > 0 ? "PARTIAL" : undefined;
}
