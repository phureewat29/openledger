import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "libsql";
import { migrate } from "../../db/schema.js";
import { createAccount } from "../../accounts/accounts.js";
import {
  createSandbox,
  makeRunCLI,
  parseNdjson,
  writeConfig,
  type CLIRunner,
  type Sandbox,
} from "../../../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;
let dbPath: string;

beforeAll(() => {
  sandbox = createSandbox("oled-questions-it-");
  runCLI = makeRunCLI(sandbox);
  dbPath = sandbox.dbPath;
  writeConfig(sandbox, {});

  // Closed before the CLI runs so the subprocess owns the writer.
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "thb:asset:cash", name: "Cash", type: "asset", parent_id: "thb:asset" });
  db.close();
});

afterAll(() => {
  sandbox.cleanup();
});

function readDb(): Database.Database {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  return db;
}

// A raw (colon-free) debit account can't resolve to a placeholder, so the row
// posts to uncategorized and raises exactly one question: the same path any
// agent hits while triaging `ingest commit` output.
async function raiseQuestion(): Promise<string> {
  const row = JSON.stringify({
    date: "2026-02-01",
    description: "needs categorization",
    debit_account: "mysterious",
    credit_account: "thb:asset:cash",
    amount: 10,
  });
  const { stdout, code } = await runCLI(["ingest", "commit", "--json"], { stdin: row });
  expect(code).toBe(0);
  const result = parseNdjson(stdout).find((o) => o.type === "result");
  expect(result.raised_questions).toBe(1);

  const db = readDb();
  try {
    const question = db
      .prepare(`SELECT id FROM questions WHERE transaction_id = ?`)
      .get(result.transaction_id) as { id: string } | undefined;
    if (!question) throw new Error(`no question raised for transaction ${result.transaction_id}`);
    return question.id;
  } finally {
    db.close();
  }
}

describe("questions answer --also (subprocess)", () => {
  it("validates every id before deleting any: a bogus --also id leaves the real ones intact", async () => {
    const good1 = await raiseQuestion();
    const good2 = await raiseQuestion();
    const bogus = "cn:00000000-0000-0000-0000-000000000000";

    const result = await runCLI([
      "questions", "answer", good1,
      "--also", `${good2},${bogus}`,
      "--answer", "thb:expense:groceries",
      "--json",
    ]);
    expect(result.code).toBe(5); // EXIT.NOT_FOUND
    expect(result.stdout.trim()).toBe("");
    const err = JSON.parse(result.stderr.trim());
    expect(err.error.code).toBe("E_NOT_FOUND");
    expect(err.error.message).toContain(bogus);

    const db = readDb();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM questions WHERE id IN (?, ?)`)
      .get(good1, good2) as { n: number };
    db.close();
    expect(remaining.n).toBe(2);
  }, 30000);

  it("answers every id in one call when all of them exist", async () => {
    const good1 = await raiseQuestion();
    const good2 = await raiseQuestion();

    const result = await runCLI([
      "questions", "answer", good1,
      "--also", good2,
      "--answer", "thb:expense:groceries",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const rows = parseNdjson(result.stdout);
    expect(rows.map((r) => r.id)).toEqual([good1, good2]);
    expect(rows.every((r) => r.answer === "thb:expense:groceries")).toBe(true);

    const db = readDb();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM questions WHERE id IN (?, ?)`)
      .get(good1, good2) as { n: number };
    db.close();
    expect(remaining.n).toBe(0);
  }, 30000);

  it("a single bogus id (no --also) still fails NOT_FOUND naming it", async () => {
    const bogus = "cn:not-here-at-all";
    const result = await runCLI(["questions", "answer", bogus, "--answer", "x", "--json"]);
    expect(result.code).toBe(5);
    expect(JSON.parse(result.stderr.trim()).error.message).toContain(bogus);
  }, 30000);

  it("dedupes a repeated id across the primary arg and --also: answers once, exit 0", async () => {
    const good1 = await raiseQuestion();
    const good2 = await raiseQuestion();

    // An agent that copies the full id set into --also repeats the primary id;
    // the repeat must not read as a second, now-already-deleted question.
    const result = await runCLI([
      "questions", "answer", good1,
      "--also", `${good1},${good2}`,
      "--answer", "thb:expense:groceries",
      "--json",
    ]);
    expect(result.code).toBe(0);
    const rows = parseNdjson(result.stdout);
    expect(rows.map((r) => r.id)).toEqual([good1, good2]);

    const db = readDb();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM questions WHERE id IN (?, ?)`)
      .get(good1, good2) as { n: number };
    db.close();
    expect(remaining.n).toBe(0);
  }, 30000);
});
