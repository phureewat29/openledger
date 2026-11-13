import type Database from "libsql";
import { newQuestionId } from "../lib/ids.js";
import { parseJSONOrNull } from "../lib/json.js";
import { clampLimit, clampOffset } from "../lib/limit.js";
import { ISO_NOW_SQL, ISO_SHIFTED_SQL } from "../db/timestamps.js";
import { inTransaction } from "../db/transaction.js";
import { clause, whereSQL, type Clause, type Filter } from "../db/where.js";

interface RecordQuestionInput {
  transaction_id?: string | null;
  account_id: string | null;
  file_id: string | null;
  batch_id?: string | null;
  kind?: string | null;
  prompt: string;
  /** Kind-specific structured context (e.g. partner ids for similar_accounts). */
  context?: Record<string, unknown> | null;
}

export interface QuestionRow {
  id: string;
  batch_id: string | null;
  file_id: string | null;
  transaction_id: string | null;
  account_id: string | null;
  kind: string | null;
  prompt: string;
  context_json: string | null;
  deferred_until: string | null;
  created_at: string;
}

const ROW_COLUMNS =
  "id, batch_id, file_id, transaction_id, account_id, kind, prompt, context_json, deferred_until, created_at";

interface ClosedQuestion {
  prompt: string;
  kind: string | null;
  answer: string;
  /** Stable signature from context_json the rule synthesizer keys a learned rule on; null learns nothing. */
  rule_key: string | null;
}

export function recordQuestion(db: Database.Database, input: RecordQuestionInput): string {
  const id = newQuestionId();
  db.prepare(
    `INSERT INTO questions (id, batch_id, file_id, transaction_id, account_id, kind, prompt, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.batch_id ?? null,
    input.file_id,
    input.transaction_id ?? null,
    input.account_id,
    input.kind ?? null,
    input.prompt,
    input.context ? JSON.stringify(input.context) : null,
  );
  return id;
}

export function findQuestionById(db: Database.Database, id: string): QuestionRow | null {
  return (
    (db.prepare(`SELECT ${ROW_COLUMNS} FROM questions WHERE id = ?`).get(id) as
      | QuestionRow
      | undefined) ?? null
  );
}

/** Hard-deletes the row rather than marking it closed. */
export function closeQuestion(
  db: Database.Database,
  id: string,
  answer: string,
): ClosedQuestion | null {
  return inTransaction(db, () => {
    const row = findQuestionById(db, id);
    if (!row) return null;
    db.prepare(`DELETE FROM questions WHERE id = ?`).run(id);
    return {
      prompt: row.prompt,
      kind: row.kind,
      answer,
      rule_key: extractRuleKey(row.context_json),
    };
  });
}

function extractRuleKey(contextJSON: string | null): string | null {
  const parsed = parseJSONOrNull(contextJSON) as { rule_key?: unknown } | null;
  return typeof parsed?.rule_key === "string" ? parsed.rule_key : null;
}

/**
 * The source row a question is about; unlike `rule_key`, never a signature to learn from.
 * questions_row_key_idx (migration 0003) serves only this exact expression.
 */
const ROW_KEY_SQL = "json_extract(context_json, '$.row_key')";

/** Deferred rows count: a deferred question is still open, so re-raising it
 *  would leave the row asking twice. */
export function findQuestionByRowKey(db: Database.Database, rowKey: string): QuestionRow | null {
  return (
    (db.prepare(`SELECT ${ROW_COLUMNS} FROM questions WHERE ${ROW_KEY_SQL} = ?`).get(rowKey) as
      | QuestionRow
      | undefined) ?? null
  );
}

export function deleteQuestionsByRowKey(db: Database.Database, rowKey: string): void {
  db.prepare(`DELETE FROM questions WHERE ${ROW_KEY_SQL} = ?`).run(rowKey);
}

interface QuestionScope {
  file_id?: string;
  transaction_id?: string;
  account_id?: string;
  kind?: string;
  batch_id?: string;
  includeDeferred?: boolean;
}

const SCOPE_COLUMNS = ["file_id", "transaction_id", "account_id", "kind", "batch_id"] as const;

const ACTIVE_DEFERRED_CLAUSE = clause(`(deferred_until IS NULL OR deferred_until <= ${ISO_NOW_SQL})`);

const QUESTION_FILTERS: Filter<QuestionScope>[] = [
  ...SCOPE_COLUMNS.map(
    (column): Filter<QuestionScope> =>
      (scope) => (scope[column] ? clause(`${column} = ?`, scope[column]) : null),
  ),
  (scope) => (scope.includeDeferred ? null : ACTIVE_DEFERRED_CLAUSE),
];

/** Shared by listQuestions/countQuestions so a filtered count matches the list. */
function questionWhere(scope: QuestionScope): Clause {
  return whereSQL(QUESTION_FILTERS.map((filter) => filter(scope)));
}

export function countQuestions(db: Database.Database, scope: QuestionScope = {}): number {
  const where = questionWhere(scope);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM questions ${where.sql}`)
    .get(...where.params) as { n: number };
  return row.n;
}

interface ListQuestionsOptions extends QuestionScope {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIST_LIMIT = 200;
const MAX_LIST_LIMIT = 1000;

export function clampQuestionsLimit(limit?: number): number {
  return clampLimit(limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
}

/** Oldest first; same-millisecond rows in insertion order, since random ids can't break that tie stably. */
export function listQuestions(
  db: Database.Database,
  opts: ListQuestionsOptions = {},
): QuestionRow[] {
  const where = questionWhere(opts);
  return db.prepare(
    `SELECT ${ROW_COLUMNS}
     FROM questions
     ${where.sql}
     ORDER BY created_at ASC, rowid ASC
     LIMIT ? OFFSET ?`,
  ).all(...where.params, clampQuestionsLimit(opts.limit), clampOffset(opts.offset)) as QuestionRow[];
}

/** Returns false when no row matched `id`. */
export function deferQuestion(
  db: Database.Database,
  id: string,
  days: number,
): boolean {
  const safeDays = Math.max(1, Math.floor(days));
  const result = db
    .prepare(`UPDATE questions SET deferred_until = ${ISO_SHIFTED_SQL} WHERE id = ?`)
    .run(`+${safeDays} days`, id);
  return result.changes > 0;
}
