import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "libsql";

import {
  recordQuestion,
  listQuestions,
  closeQuestion,
  countQuestions,
  deferQuestion,
  deleteQuestionsByRowKey,
  findQuestionByRowKey,
} from "./queries.js";
import { freshDb, seedAccount } from "../../fixtures/db.js";

const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function seedExpenseAccounts(db: Database.Database): void {
  seedAccount(db, { id: "thb:expense:food" });
}

function insertFile(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES (?, ?, ?, ?, 'ingested')`,
  ).run(id, `/tmp/${id}.pdf`, `hash-${id}`, "application/pdf");
}

describe("questions table", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedExpenseAccounts);
  });

  it("accepts arbitrary free-text kinds", () => {
    const kinds = ["uncategorized", "duplicate", "correlation", "recurrence_candidate", "similar_accounts", "file_password", "acme.tax_th__refund"];
    for (const k of kinds) {
      expect(() => recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: k, prompt: k })).not.toThrow();
    }
    expect(listQuestions(db, { limit: 100 })).toHaveLength(kinds.length);
  });

  it("closeQuestion deletes the row and returns the captured tuple", () => {
    recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "Which category?" });
    const open = listQuestions(db);
    expect(open).toHaveLength(1);
    const closed = closeQuestion(db, open[0].id, "thb:expense:food:groceries");
    expect(closed).toEqual({ prompt: "Which category?", kind: "uncategorized", answer: "thb:expense:food:groceries", rule_key: null });
    expect(listQuestions(db)).toHaveLength(0);
    expect(countQuestions(db)).toBe(0);
  });

  it("listQuestions scopes by batch_id when supplied", () => {
    recordQuestion(db, { file_id: null, batch_id: "ib:a", account_id: "thb:expense:food", kind: "uncategorized", prompt: "a" });
    recordQuestion(db, { file_id: null, batch_id: "ib:b", account_id: "thb:expense:food", kind: "uncategorized", prompt: "b" });
    recordQuestion(db, { file_id: null, batch_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "c" });
    expect(listQuestions(db, { batch_id: "ib:a" }).map(r => r.prompt)).toEqual(["a"]);
    expect(listQuestions(db, { batch_id: "ib:b" }).map(r => r.prompt)).toEqual(["b"]);
    expect(listQuestions(db).map(r => r.prompt).sort()).toEqual(["a", "b", "c"]);
  });

  it("orders by id when created_at ties, not by insertion/rowid order", () => {
    // Insert out of lexicographic id order so an ORDER BY that dropped the
    // `id ASC` tiebreak and fell back to rowid/insertion order would return
    // e, c, a, d, b instead of the sorted a..e this asserts.
    const insertOrder = ["cn:e", "cn:c", "cn:a", "cn:d", "cn:b"];
    const tiedCreatedAt = "2026-01-01T00:00:00.000Z";
    for (const id of insertOrder) {
      db.prepare(
        `INSERT INTO questions (id, account_id, prompt, created_at) VALUES (?, ?, ?, ?)`,
      ).run(id, "thb:expense:food", id, tiedCreatedAt);
    }
    expect(listQuestions(db, { limit: 5 }).map((r) => r.id)).toEqual(
      [...insertOrder].sort(),
    );
  });

  it("pages tied created_at rows without skip or repeat", () => {
    const ids = ["a", "b", "c", "d", "e"].map((k) =>
      recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: k }),
    );
    db.prepare(`UPDATE questions SET created_at = '2026-01-01T00:00:00.000Z'`).run();

    const seen: string[] = [];
    for (let offset = 0; offset < ids.length; offset++) {
      seen.push(...listQuestions(db, { limit: 1, offset }).map((r) => r.id));
    }
    expect(seen.sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(ids.length);
  });

  it("countQuestions scopes by kind and file_id", () => {
    insertFile(db, "sf-a");
    insertFile(db, "sf-b");
    recordQuestion(db, { file_id: "sf-a", account_id: "thb:expense:food", kind: "uncategorized", prompt: "a" });
    recordQuestion(db, { file_id: "sf-b", account_id: "thb:expense:food", kind: "duplicate", prompt: "b" });
    expect(countQuestions(db, { kind: "uncategorized" })).toBe(1);
    expect(countQuestions(db, { file_id: "sf-a" })).toBe(1);
    expect(countQuestions(db, { kind: "duplicate", file_id: "sf-b" })).toBe(1);
    expect(countQuestions(db, { kind: "duplicate", file_id: "sf-a" })).toBe(0);
  });
});

describe("row_key lookups", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedExpenseAccounts);
  });

  function record(prompt: string, context: Record<string, unknown> | null): string {
    return recordQuestion(db, {
      file_id: null,
      account_id: "thb:expense:food",
      kind: "dirty_input",
      prompt,
      context,
    });
  }

  it("matches on the row_key alone, blind to rows carrying a rule_key or no context", () => {
    const addressed = record("bad row", { row_key: "refusal:sf-a:1:3", reason: "amount" });
    record("other row", { row_key: "refusal:sf-a:1:4" });
    record("learnable", { rule_key: "refusal:sf-a:1:3" });
    record("contextless", null);

    expect(findQuestionByRowKey(db, "refusal:sf-a:1:3")?.id).toBe(addressed);
    expect(findQuestionByRowKey(db, "refusal:sf-a:1:9")).toBeNull();
  });

  it("finds a deferred row: still open, so re-raising it would ask twice", () => {
    const id = record("bad row", { row_key: "refusal:sf-a:1:3" });
    deferQuestion(db, id, 7);
    expect(listQuestions(db)).toHaveLength(0);
    expect(findQuestionByRowKey(db, "refusal:sf-a:1:3")?.id).toBe(id);
  });

  it("deletes only the addressed row, leaving every other question standing", () => {
    record("bad row", { row_key: "refusal:sf-a:1:3" });
    const neighbour = record("other row", { row_key: "refusal:sf-a:1:4" });
    const lookalike = record("learnable", { rule_key: "refusal:sf-a:1:3" });
    const contextless = record("contextless", null);

    deleteQuestionsByRowKey(db, "refusal:sf-a:1:3");

    expect(listQuestions(db).map((q) => q.id).sort()).toEqual(
      [neighbour, lookalike, contextless].sort(),
    );
  });

  it("is a silent no-op when no row carries the key", () => {
    const id = record("bad row", { row_key: "refusal:sf-a:1:3" });
    expect(() => deleteQuestionsByRowKey(db, "refusal:sf-a:1:9")).not.toThrow();
    expect(listQuestions(db).map((q) => q.id)).toEqual([id]);
  });

  it("searches questions_row_key_idx instead of scanning every question's JSON", () => {
    const prepare = vi.spyOn(db, "prepare");
    findQuestionByRowKey(db, "refusal:sf-a:1:3");
    deleteQuestionsByRowKey(db, "refusal:sf-a:1:3");
    const statements = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();

    expect(statements).toHaveLength(2);
    for (const sql of statements) {
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("refusal:sf-a:1:3") as { detail: string }[];
      expect(plan.map((step) => step.detail), sql).toEqual([
        expect.stringContaining("USING INDEX questions_row_key_idx"),
      ]);
    }
  });
});

describe("deferQuestion", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = freshDb(seedExpenseAccounts);
  });

  it("hides a deferred row from listQuestions and countQuestions by default", () => {
    const id = recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "snooze me" });
    expect(listQuestions(db)).toHaveLength(1);
    expect(countQuestions(db)).toBe(1);

    expect(deferQuestion(db, id, 7)).toBe(true);

    expect(listQuestions(db)).toHaveLength(0);
    expect(countQuestions(db)).toBe(0);
  });

  it("surfaces deferred rows when includeDeferred is true", () => {
    const id = recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "snooze me" });
    deferQuestion(db, id, 7);

    expect(listQuestions(db, { includeDeferred: true })).toHaveLength(1);
    expect(countQuestions(db, { includeDeferred: true })).toBe(1);
  });

  it("re-surfaces a row whose deferred_until has passed", () => {
    const id = recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "stale defer" });
    deferQuestion(db, id, 7);
    expect(listQuestions(db)).toHaveLength(0);

    db.prepare(`UPDATE questions SET deferred_until = strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') WHERE id = ?`).run(id);
    expect(listQuestions(db)).toHaveLength(1);
    expect(countQuestions(db)).toBe(1);
  });

  it("returns false when the id doesn't exist", () => {
    expect(deferQuestion(db, "cn:nope", 7)).toBe(false);
  });

  it("floors fractional days and clamps to >= 1", () => {
    const id = recordQuestion(db, { file_id: null, account_id: "thb:expense:food", kind: "uncategorized", prompt: "x" });
    expect(deferQuestion(db, id, 0)).toBe(true);
    const row = db.prepare(`SELECT deferred_until FROM questions WHERE id = ?`).get(id) as { deferred_until: string };
    expect(row.deferred_until).toMatch(ISO_TIMESTAMP_RE);
    expect(Date.parse(row.deferred_until)).toBeGreaterThan(Date.now() - 60_000);
  });
});
