import type Database from "libsql";
import {
  deleteQuestionsByRowKey,
  findQuestionByRowKey,
  recordQuestion,
} from "../questions/queries.js";
import { isAccountType } from "../accounts/queries.js";
import { typeFromId } from "../lib/ids.js";
import type { CommitSide } from "../contract/ingest.js";

export type TransactionSide = CommitSide["side"];

export interface QuestionContext {
  readonly batchId: string | null;
  readonly fileId: string | null;
}

/** The row fields a question quotes back to the agent, and nothing else. */
interface QuotedRow {
  readonly date: string;
  readonly description: string;
  readonly raw_descriptor?: string | null;
}

/** Where a row sits in its file. `row_index` is page-scoped, so the page is part
 *  of the address — the same coordinates `deriveTransactionId` hashes. */
interface RowAddress {
  readonly source_page?: number | null;
  readonly row_index?: number | null;
}

type RaisedQuestion = Omit<Parameters<typeof recordQuestion>[1], "file_id" | "batch_id">;

const NON_WORD = /[^\p{L}\p{N}]+/gu;

function normalizeForKey(raw: string): string {
  return raw.toLowerCase().replace(NON_WORD, " ").replace(/\s+/g, " ").trim();
}
function descriptorKey(descriptor: string): string {
  return `descriptor:${normalizeForKey(descriptor)}`;
}
function accountIdKey(id: string): string {
  return `account:${id}`;
}
function accountPairKey(a: string, b: string): string {
  const [lo, hi] = [a, b].sort();
  return `account-pair:${lo}|${hi}`;
}

/** Questions belong to a batch; outside one there is nothing to hang them on,
 *  so the return is what actually landed — callers sum it, never assume it. */
function raiseQuestion(
  db: Database.Database,
  ctx: QuestionContext,
  input: RaisedQuestion,
): 0 | 1 {
  if (!ctx.batchId) return 0;
  recordQuestion(db, { ...input, file_id: ctx.fileId, batch_id: ctx.batchId });
  return 1;
}

/** Null when the row has no address: nothing would recognise it on a re-commit,
 *  which is also the case in which its transaction id is not derived either. */
function rowRefusalKey(ctx: QuestionContext, row: RowAddress): string | null {
  if (!ctx.fileId || row.row_index == null) return null;
  return `refusal:${ctx.fileId}:${row.source_page ?? 0}:${row.row_index}`;
}

/** One question per refused row across re-commits, keyed by its address the way a posted row is by
 *  its derived id; the retry raises 0, and the first refusal's wording stands. */
function raiseRefusal(
  db: Database.Database,
  ctx: QuestionContext,
  row: RowAddress,
  input: RaisedQuestion,
): 0 | 1 {
  const key = rowRefusalKey(ctx, row);
  if (!key) return raiseQuestion(db, ctx, input);
  if (findQuestionByRowKey(db, key)) return 0;
  return raiseQuestion(db, ctx, { ...input, context: { ...input.context, row_key: key } });
}

/** The refusal was about a row that now exists; nothing is left to answer. */
export function closeRowRefusal(
  db: Database.Database,
  ctx: QuestionContext,
  row: RowAddress,
): void {
  const key = rowRefusalKey(ctx, row);
  if (key) deleteQuestionsByRowKey(db, key);
}

export function raiseDirtyInput(
  db: Database.Database,
  ctx: QuestionContext,
  input: QuotedRow & RowAddress,
  reason: string,
): 0 | 1 {
  // reason often already ends in a period; strip it so the template's own doesn't double up.
  const reasonText = reason.replace(/\.+$/, "");
  return raiseRefusal(db, ctx, input, {
    transaction_id: null,
    account_id: null,
    kind: "dirty_input",
    prompt:
      `The ingest input produced a transaction that couldn't be validated: ${reasonText}. ` +
      `Raw description: "${input.description}" on ${input.date}.`,
    context: { description: input.description, date: input.date, reason },
  });
}

export function raiseUnknownMerchant(
  db: Database.Database,
  ctx: QuestionContext,
  input: QuotedRow,
  transactionId: string,
  attemptedId: string,
): 0 | 1 {
  const descriptor = input.raw_descriptor || input.description;
  return raiseQuestion(db, ctx, {
    transaction_id: transactionId,
    account_id: null,
    kind: "unknown_merchant",
    prompt:
      `The ingest input referenced merchant id "${attemptedId}" but no such merchant exists. ` +
      `Link "${descriptor}" to an existing merchant or leave it unlinked.`,
    context: { rule_key: descriptorKey(descriptor), descriptor, attempted_id: attemptedId },
  });
}

type UncategorizedCause = "fallback" | "requested";

/** Telling a caller that parked the row here on purpose that it "couldn't be
 *  matched" would be false, and would name a fix it already applied. */
const UNCATEGORIZED_PROMPT: Record<
  UncategorizedCause,
  (side: TransactionSide, accountId: string) => string
> = {
  fallback: (side, accountId) =>
    `The ${side} side couldn't be matched to a well-formed account and was booked to ` +
    `"${accountId}". Recategorize it onto a real account, or re-run with a full ` +
    `currency-prefixed colon-path hint (e.g. thb:expense:food:dining).`,
  requested: (side, accountId) =>
    `The ${side} side asked for "${accountId}" outright, which categorizes nothing. ` +
    `Name the account this row belongs to, or say it belongs here.`,
};

export function raiseUncategorized(
  db: Database.Database,
  ctx: QuestionContext,
  side: TransactionSide,
  accountId: string,
  transactionId: string,
  cause: UncategorizedCause,
): 0 | 1 {
  return raiseQuestion(db, ctx, {
    transaction_id: transactionId,
    account_id: accountId,
    kind: "uncategorized",
    prompt: UNCATEGORIZED_PROMPT[cause](side, accountId),
    context: { rule_key: accountIdKey(accountId), placeholder_id: accountId, side },
  });
}

/** Anchored on the lookalike: merging deletes the created row, which would
 *  otherwise cascade this question away unanswered. */
export function raiseSimilarAccount(
  db: Database.Database,
  ctx: QuestionContext,
  side: TransactionSide,
  accountId: string,
  similarId: string,
  transactionId: string,
): 0 | 1 {
  return raiseQuestion(db, ctx, {
    transaction_id: transactionId,
    account_id: similarId,
    kind: "similar_accounts",
    prompt:
      `The ${side} side posted to "${accountId}", created as asked, but "${similarId}" ` +
      `already looks like the same account. Merge them with \`accounts merge\`, or leave ` +
      `them apart if they are different.`,
    context: {
      rule_key: accountPairKey(accountId, similarId),
      created_id: accountId,
      similar_id: similarId,
      side,
    },
  });
}

export function raiseCurrencyMismatch(
  db: Database.Database,
  ctx: QuestionContext,
  input: QuotedRow & RowAddress,
  debit: { id: string; currency: string },
  credit: { id: string; currency: string },
): 0 | 1 {
  return raiseRefusal(db, ctx, input, {
    transaction_id: null,
    account_id: null,
    kind: "currency_mismatch",
    prompt:
      `Transaction "${input.description}" on ${input.date} moves money between ` +
      `${debit.id} (${debit.currency}) and ${credit.id} (${credit.currency}), which are ` +
      `different ledgers. A single transaction can't cross currencies: record it as a ` +
      `linked conversion pair (one leg into ${debit.currency.toLowerCase()}:equity:conversion, one out of ` +
      `${credit.currency.toLowerCase()}:equity:conversion, sharing a group) so the FX conversion is explicit.`,
    context: { debit, credit, date: input.date, description: input.description },
  });
}

// account_id stays null: the named account can't exist without the ledger.
export function raiseUnknownLedger(
  db: Database.Database,
  ctx: QuestionContext,
  input: QuotedRow & RowAddress,
  side: TransactionSide,
  accountId: string,
  ledger: string,
): 0 | 1 {
  const type = typeFromId(accountId);
  const repair = isAccountType(type)
    ? `create the account first (\`oled accounts create --id ${accountId} --name <name> --type ${type}\`), ` +
      `or fix the currency prefix and re-ingest.`
    : `fix the id to <currency>:<type>:<path> against an open ledger and re-ingest.`;
  return raiseRefusal(db, ctx, input, {
    transaction_id: null,
    account_id: null,
    kind: "currency_mismatch",
    prompt:
      `Transaction "${input.description}" on ${input.date} books its ${side} side to ` +
      `"${accountId}", whose ledger "${ledger}" does not exist here. Opening a ledger is a ` +
      `deliberate act, never an ingest side effect: ${repair} Nothing was posted.`,
    context: {
      side,
      account_id: accountId,
      ledger,
      date: input.date,
      description: input.description,
    },
  });
}
