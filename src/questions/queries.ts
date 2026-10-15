import type Database from "libsql";
import { randomUUID } from "crypto";
import { parseJsonOrNull } from "../lib/json.js";
import { clampLimit, clampOffset } from "../lib/limit.js";
import { ISO_NOW_SQL, ISO_SHIFTED_SQL } from "../db/timestamps.js";

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

/** The `cn:` id prefix is opaque - nothing else parses it. */
export function recordQuestion(db: Database.Database, input: RecordQuestionInput): string {
  const id = `cn:${randomUUID()}`;
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
  const row = findQuestionById(db, id);
  if (!row) return null;
  db.prepare(`DELETE FROM questions WHERE id = ?`).run(id);
  return {
    prompt: row.prompt,
    kind: row.kind,
    answer,
    rule_key: extractRuleKey(row.context_json),
  };
}

function extractRuleKey(contextJson: string | null): string | null {
  const parsed = parseJsonOrNull(contextJson) as { rule_key?: unknown } | null;
  return typeof parsed?.rule_key === "string" ? parsed.rule_key : null;
}

/**
 * A question's `row_key` is the source row it is about, not a signature to learn
 * a rule from — that is `rule_key`'s job, and a one-off row address would teach
 * it nothing. `json_extract` yields NULL for a null context, which never equals
 * a bound key, so questions carrying neither are untouched by both queries.
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

/** Closing is deletion here as in `closeQuestion`; a row that posted has nothing
 *  left to answer, and no answer worth recording. */
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

// listQuestions/countQuestions hide deferred rows by default until the timestamp passes (includeDeferred: true shows all).
const ACTIVE_DEFERRED_CLAUSE =
  `(deferred_until IS NULL OR deferred_until <= ${ISO_NOW_SQL})`;

// Shared by listQuestions/countQuestions so a filtered count matches the list.
function buildQuestionWhere(scope: QuestionScope): { whereSql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (scope.file_id)        { conditions.push("file_id = ?");        params.push(scope.file_id); }
  if (scope.transaction_id) { conditions.push("transaction_id = ?"); params.push(scope.transaction_id); }
  if (scope.account_id)     { conditions.push("account_id = ?");     params.push(scope.account_id); }
  if (scope.kind)           { conditions.push("kind = ?");           params.push(scope.kind); }
  if (scope.batch_id)       { conditions.push("batch_id = ?");       params.push(scope.batch_id); }
  if (!scope.includeDeferred) conditions.push(ACTIVE_DEFERRED_CLAUSE);
  const whereSql = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  return { whereSql, params };
}

export function countQuestions(db: Database.Database, scope: QuestionScope = {}): number {
  const { whereSql, params } = buildQuestionWhere(scope);
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM questions ${whereSql}`)
    .get(...params) as { n: number };
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

export function listQuestions(
  db: Database.Database,
  opts: ListQuestionsOptions = {},
): QuestionRow[] {
  const capped = clampQuestionsLimit(opts.limit);
  const { whereSql, params } = buildQuestionWhere(opts);
  params.push(capped, clampOffset(opts.offset));
  return db.prepare(
    `SELECT ${ROW_COLUMNS}
     FROM questions
     ${whereSql}
     ORDER BY created_at ASC, id ASC
     LIMIT ? OFFSET ?`,
  ).all(...params) as QuestionRow[];
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
