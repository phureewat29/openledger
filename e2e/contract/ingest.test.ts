import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ZodType } from "zod";
import {
  createSandbox,
  makeRunCLI,
  parseNDJSON,
  type CLIRunner,
  type Sandbox,
} from "../../fixtures/sandbox.js";
import { pdfOf, textPDF } from "../../fixtures/pdf.js";
import { COMMAND_CONTRACTS, ErrorEnvelope } from "../../src/contract/index.js";

type CommandPath = keyof typeof COMMAND_CONTRACTS;

let sandbox: Sandbox;
let runCLI: CLIRunner;

// Threaded by the steps below, in the order the steps run.
let statementFileId = "";
let secondFileId = "";

// Its own sandbox: this file posts to the ledger from its first step.
beforeAll(() => {
  sandbox = createSandbox("oled-e2e-contract-ingest-");
  runCLI = makeRunCLI(sandbox, "dist");
});

afterAll(() => sandbox.cleanup());

// One ledger, one chain: a mid-chain failure would cascade into unrelated steps.
let stepFailed = false;

beforeEach((ctx) => ctx.skip(stepFailed, "an earlier contract step failed"));

afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") stepFailed = true;
});

function issueText(issue: { path: PropertyKey[]; message: string }): string {
  return issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message;
}

/**
 * null when one of the command's declared schemas parses the line AND hands it
 * back whole. `z.object` strips what it does not declare, so a field the
 * contract never mentions survives `parse` and dies on the identity compare,
 * which is the drift this whole suite exists to catch.
 */
function lineProblem(path: CommandPath, raw: unknown): string | null {
  const lines: readonly ZodType[] = COMMAND_CONTRACTS[path].lines;
  const why: string[] = [];
  for (const schema of lines) {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      why.push(parsed.error.issues.map(issueText).join("; "));
      continue;
    }
    if (isDeepStrictEqual(parsed.data, raw)) return null;
    why.push(`parsed to ${JSON.stringify(parsed.data)}`);
  }
  return `${path}: ${JSON.stringify(raw)} :: ${why.join(" | ")}`;
}

/** Later steps thread ids out of earlier output, so a missing row has to stop the chain. */
function requireRow(
  rows: Record<string, any>[],
  match: (row: Record<string, any>) => boolean,
): Record<string, any> {
  const row = rows.find(match);
  if (!row) throw new Error(`no matching row among: ${JSON.stringify(rows)}`);
  return row;
}

interface RunOpts {
  exit?: number;
  stdin?: string;
}

/** Appends `--json`, asserts the exit code, then holds every stdout line to the contract. */
async function contractRun(
  path: CommandPath,
  args: string[],
  opts: RunOpts = {},
): Promise<Record<string, any>[]> {
  const result = await runCLI([...args, "--json"], { stdin: opts.stdin });
  expect(result.code, `oled ${args.join(" ")} failed: ${result.stderr}`).toBe(opts.exit ?? 0);
  const rows = parseNDJSON(result.stdout);
  const problems = rows.map((raw) => lineProblem(path, raw)).filter((p) => p !== null);
  expect(problems, `oled ${args.join(" ")}`).toEqual([]);
  return rows;
}

/** A non-zero exit writes nothing to stdout and one envelope to stderr. */
async function contractError(args: string[], exit: number): Promise<Record<string, any>> {
  const result = await runCLI([...args, "--json"]);
  expect(result.code, `oled ${args.join(" ")} stdout: ${result.stdout}`).toBe(exit);
  expect(result.stdout.trim(), `oled ${args.join(" ")} wrote to stdout`).toBe("");
  const raw = JSON.parse(result.stderr.trim());
  expect(ErrorEnvelope.parse(raw)).toEqual(raw);
  return raw;
}

/** Setup, not assertion: these must exist before the batch can post exactly. */
async function seedAccounts(): Promise<void> {
  const accounts: [string, string, string][] = [
    ["thb:asset:cash", "Cash", "asset"],
    ["thb:expense:food", "Food", "expense"],
    ["thb:liability:card", "Card", "liability"],
    ["thb:income:salary", "Salary", "income"],
    ["thb:expense:tax", "Tax", "expense"],
  ];
  for (const [id, name, type] of accounts) {
    const created = await runCLI([
      "accounts", "create",
      "--id", id, "--name", name, "--type", type,
      "--parent", `thb:${type}`,
      "--json",
    ]);
    expect(created.code, `seeding ${id}: ${created.stderr}`).toBe(0);
  }
}

function ndjson(items: Record<string, unknown>[]): string {
  return items.map((item) => JSON.stringify(item)).join("\n");
}

/**
 * One batch covering every branch of the three commit result shapes: each
 * `how` a side can report, each `how` a merchant can report, a compound row,
 * and both failure reasons; the second carries `unopened_ledger`.
 * Fresh objects each call, since the duplicate step re-pipes them verbatim.
 */
function statementRows(): Record<string, unknown>[] {
  return [
    {
      date: "2026-06-01", description: "Groceries", row_index: 0, source_page: 1,
      debit_account: "thb:expense:food", credit_account: "thb:liability:card", amount: 250,
    },
    {
      date: "2026-06-02", description: "Card payment", row_index: 1, source_page: 1,
      debit_account: "thb:liability:card", credit_account: "thb:asset:cash", amount: 50,
    },
    // A well-formed path inside an existing ledger: created silently, no question.
    {
      date: "2026-06-03", description: "New category", row_index: 2, source_page: 1,
      debit_account: "thb:expense:pet:grooming", credit_account: "thb:asset:cash", amount: 120,
    },
    // No usable prefix: falls into the other side's uncategorized, with a question.
    {
      date: "2026-06-04", description: "Unplaceable", row_index: 3, source_page: 1,
      debit_account: "mysterious", credit_account: "thb:asset:cash", amount: 30,
    },
    {
      date: "2026-06-05", description: "Pet Paradise", row_index: 4, source_page: 1,
      debit_account: "thb:expense:food", credit_account: "thb:asset:cash", amount: 45,
      raw_descriptor: "POS PET PARADISE 4821",
      merchant: { canonical_name: "Pet Paradise", alias: "POS PET PARADISE" },
    },
    {
      date: "2026-06-06", description: "Mystery merchant", row_index: 5, source_page: 1,
      debit_account: "thb:expense:food", credit_account: "thb:asset:cash", amount: 15,
      merchant_id: "m:does-not-exist",
    },
    {
      date: "2026-06-07", description: "Salary", row_index: 6, source_page: 1,
      linked: [
        { debit_account: "thb:asset:cash", credit_account: "thb:income:salary", amount: 4500, description: "Net pay" },
        { debit_account: "thb:expense:tax", credit_account: "thb:income:salary", amount: 500, description: "Withholding" },
      ],
    },
    // Posts as asked; the lookalike rides along as similar_to.
    {
      date: "2026-06-08", description: "Food delivery", row_index: 7, source_page: 1,
      debit_account: "thb:expense:food-delivery", credit_account: "thb:asset:cash", amount: 60,
    },
    {
      description: "Missing date", row_index: 8, source_page: 1,
      debit_account: "thb:expense:food", credit_account: "thb:asset:cash", amount: 20,
    },
    {
      date: "2026-06-09", description: "Unopened ledger", row_index: 9, source_page: 1,
      debit_account: "thb:asset:cash", credit_account: "eur:income:salary", amount: 10,
    },
  ];
}

const EXIT_PARTIAL = 7;

describe("every ingest-lane line matches its COMMAND_CONTRACTS schema (dist subprocess)", () => {
  it("config --init and the seeded accounts bootstrap the ledger the steps below post to", async () => {
    const init = await runCLI(["config", "--init", "--json"]);
    expect(init.code, `config --init failed: ${init.stderr}`).toBe(0);
    await seedAccounts();

    const statement = join(sandbox.dataDir, "bank", "statement.pdf");
    mkdirSync(dirname(statement), { recursive: true });
    writeFileSync(statement, textPDF());
    // Different bytes, so it registers as its own file: `ingest fail` needs one to fail.
    writeFileSync(join(sandbox.dataDir, "bank", "statement-2.pdf"), pdfOf(["text", "text"]));
  });

  it("ingest list streams one file row per staged statement, then its status counts", async () => {
    const rows = await contractRun("ingest list", ["ingest", "list"]);
    const files = rows.filter((r) => r.type === "file");
    expect(files.map((f) => f.rel_path).sort()).toEqual(["bank/statement-2.pdf", "bank/statement.pdf"]);
    expect(rows.at(-1)).toMatchObject({ type: "summary", new: 2, total: 2 });
  });

  it("ingest prepare returns the text route for a PDF carrying its own text layer", async () => {
    const [prepared] = await contractRun("ingest prepare", [
      "ingest", "prepare", "bank/statement.pdf",
    ]);
    expect(prepared).toMatchObject({ kind: "text", source: "text-layer", page_count: 1 });
    // The two conditional keys stay absent off the OCR route.
    expect(prepared).not.toHaveProperty("ocr_model");
    expect(prepared).not.toHaveProperty("failed_pages");
    statementFileId = prepared.file_id;

    const [second] = await contractRun("ingest prepare", ["ingest", "prepare", "bank/statement-2.pdf"]);
    secondFileId = second.file_id;
  });

  it("ingest commit reports all three result shapes, and a summary carrying the file facts", async () => {
    const rows = await contractRun(
      "ingest commit",
      ["ingest", "commit", "--file", statementFileId],
      { stdin: ndjson(statementRows()), exit: EXIT_PARTIAL },
    );
    const results = rows.filter((r) => r.type === "result");
    expect(results).toHaveLength(10);

    // Every branch the contract's union has to cover actually appeared in this batch.
    const hows = results.flatMap((r) => (r.sides ?? []).map((s: { how: string }) => s.how));
    expect([...new Set(hows)].sort()).toEqual([
      "exact",
      "placeholder_created",
      "similar_account",
      "uncategorized_fallback",
    ]);
    // A refused row reports no merchant at all, so only the successes carry one.
    expect([...new Set(results.filter((r) => r.ok).map((r) => r.merchant.how))].sort()).toEqual([
      "linked",
      "none",
      "unknown",
    ]);
    expect(results.filter((r) => r.ok === false).map((r) => r.reason)).toEqual([
      "dirty_input",
      "currency_mismatch",
    ]);
    expect(results.find((r) => r.unopened_ledger)).toMatchObject({ unopened_ledger: "eur" });
    expect(results.find((r) => r.group_id)?.legs).toHaveLength(2);

    expect(rows.at(-1)).toMatchObject({
      type: "summary",
      posted: 8,
      duplicates: 0,
      failed: 2,
      file_id: statementFileId,
      file_status: "pending",
    });
  });

  it("re-piping the batch reports as_committed sides and duplicate legs", async () => {
    const rows = await contractRun(
      "ingest commit",
      ["ingest", "commit", "--file", statementFileId],
      { stdin: ndjson(statementRows()), exit: EXIT_PARTIAL },
    );
    const results = rows.filter((r) => r.type === "result");
    const hows = results.flatMap((r) => (r.sides ?? []).map((s: { how: string }) => s.how));
    expect([...new Set(hows)]).toEqual(["as_committed"]);
    expect(rows.at(-1)).toMatchObject({ type: "summary", posted: 0, duplicates: 8 });
  });

  it("a commit with no --file takes its rows off stdin, and its summary carries no file keys", async () => {
    const rows = await contractRun("ingest commit", ["ingest", "commit"], {
      stdin: ndjson([
        {
          date: "2026-07-01", description: "Row with no source file",
          debit_account: "thb:expense:food", credit_account: "thb:asset:cash", amount: 12,
        },
      ]),
    });
    // No file hash means no derived id: the row lands on a fresh UUID instead.
    expect(rows[0].transaction_id).toMatch(/^tx:[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(rows.at(-1)).not.toHaveProperty("file_id");
    expect(rows.at(-1)).not.toHaveProperty("hint");
  });

  it("files list and files show describe the registered statements", async () => {
    const rows = await contractRun("files list", ["files", "list"]);
    expect(rows.filter((r) => r.type !== "summary")).toHaveLength(2);
    expect(rows.at(-1)).toMatchObject({ type: "summary", total: 2, returned: 2 });

    const [detail] = await contractRun("files show", ["files", "show", statementFileId]);
    expect(detail).toMatchObject({ type: "file_detail", id: statementFileId, status: "pending" });
    expect(detail.transaction_count).toBeGreaterThan(0);
  });

  it("merchants list, resolve, upsert, update, set-default and merge all match their shapes", async () => {
    const listed = await contractRun("merchants list", ["merchants", "list"]);
    const petMerchantId: string = requireRow(listed, (m) => m.canonical_name === "Pet Paradise").id;
    expect(listed.at(-1)).toMatchObject({ type: "summary", has_more: false, limit: 200 });

    const [miss] = await contractRun("merchants resolve", [
      "merchants", "resolve", "--descriptor", "POS NOBODY HERE",
    ]);
    expect(miss).toEqual({ found: false });

    const [hit] = await contractRun("merchants resolve", [
      "merchants", "resolve", "--descriptor", "POS PET PARADISE 9999",
    ]);
    expect(hit).toMatchObject({ found: true, merchant_id: petMerchantId });

    const [shop] = await contractRun("merchants upsert", [
      "merchants", "upsert", "--name", "Contract Shop", "--alias", "CONTRACT SHOP",
    ]);
    const shopMerchantId: string = shop.id;
    expect(shop).not.toHaveProperty("alias_conflict");

    // Normalizes onto a pattern Pet Paradise already holds, so the alias stays put.
    const [rival] = await contractRun("merchants upsert", [
      "merchants", "upsert", "--name", "Alias Rival", "--alias", "POS PET PARADISE 77",
    ]);
    const rivalMerchantId: string = rival.id;
    expect(rival.alias_conflict).toMatchObject({ held_by: petMerchantId });

    const [updated] = await contractRun("merchants update", [
      "merchants", "update", "--merchant", shopMerchantId,
      "--name", "Contract Shop Renamed",
      "--alias", "CONTRACT SHOP ONLINE",
      "--default-account", "thb:expense:food",
    ]);
    expect(updated).toMatchObject({
      merchant_id: shopMerchantId,
      before: "Contract Shop",
      after: "Contract Shop Renamed",
      alias_added: "CONTRACT SHOP ONLINE",
      default_account: "thb:expense:food",
    });

    const [set] = await contractRun("merchants set-default", [
      "merchants", "set-default", "--merchant", petMerchantId, "--account", "thb:expense:food",
    ]);
    expect(set).toEqual({
      merchant_id: petMerchantId,
      before: null,
      after: "thb:expense:food",
    });

    const [cleared] = await contractRun("merchants set-default", [
      "merchants", "set-default", "--merchant", petMerchantId, "--clear",
    ]);
    expect(cleared).toMatchObject({ after: null });

    // The destination holds no default account, so it adopts the source's.
    const [merged] = await contractRun("merchants merge", [
      "merchants", "merge", "--from", shopMerchantId, "--to", rivalMerchantId, "--yes",
    ]);
    expect(merged).toMatchObject({
      from: shopMerchantId,
      to: rivalMerchantId,
      adopted_default_account: "thb:expense:food",
    });
  });

  it("questions list, defer and answer match their shapes, and both writes end with a summary", async () => {
    const listed = await contractRun("questions list", ["questions", "list"]);
    const open = listed.filter((r) => r.type !== "summary");
    expect(open.length).toBeGreaterThanOrEqual(3);
    expect(listed.at(-1)).toMatchObject({ type: "summary", has_more: false, offset: 0 });

    const deferred = await contractRun("questions defer", [
      "questions", "defer", open[0].id, "--days", "3",
    ]);
    expect(deferred).toEqual([
      { id: open[0].id, days: 3 },
      { type: "summary", deferred: 1 },
    ]);

    const answered = await contractRun("questions answer", [
      "questions", "answer", open[1].id,
      "--also", open[2].id,
      "--answer", "booked to thb:expense:food",
    ]);
    expect(answered.filter((r) => r.type !== "summary").map((r) => r.id)).toEqual([
      open[1].id,
      open[2].id,
    ]);
    expect(answered.at(-1)).toEqual({ type: "summary", answered: 2, closed_siblings: 1 });
  });

  it("notes add, list and rm each end their row stream with a summary", async () => {
    const added = await contractRun("notes add", [
      "notes", "add", "--content", "Statements land in bank/", "--category", "rule",
    ]);
    expect(added.at(-1)).toEqual({ type: "summary", added: 1 });
    const noteId = added[0].id;

    const listed = await contractRun("notes list", ["notes", "list"]);
    expect(listed.at(-1)).toEqual({ type: "summary", total: 1, returned: 1 });

    const removed = await contractRun("notes rm", ["notes", "rm", String(noteId), "--yes"]);
    expect(removed[0]).toMatchObject({ id: noteId, category: "rule" });
    expect(removed.at(-1)).toEqual({ type: "summary", removed: 1 });
  });

  it("ingest done closes the statement and reconciles the card it charged", async () => {
    // 250.00 charged to the card, 50.00 paid off, so the ledger holds 200.00.
    const [done] = await contractRun("ingest done", [
      "ingest", "done", statementFileId,
      "--agent", "contract-e2e",
      "--account", "thb:liability:card",
      "--closing-balance", "200",
    ]);
    expect(done).toMatchObject({
      file_id: statementFileId,
      status: "ingested",
      reconciliation: { account: "thb:liability:card", closing: 200, balance: 200 },
    });
    expect(done.cache_removed).toEqual([join(sandbox.cacheDir, statementFileId)]);
  });

  it("ingest fail records the failure and purges the file's cache", async () => {
    const [failed] = await contractRun("ingest fail", [
      "ingest", "fail", secondFileId, "--agent", "contract-e2e", "--error", "unreadable scan",
    ]);
    expect(failed).toMatchObject({ file_id: secondFileId, status: "failed" });
  });

  it("a refused command writes one error envelope to stderr and nothing to stdout", async () => {
    const missing = await contractError(["ingest", "prepare", "no/such/statement.pdf"], 5);
    expect(missing.error.code).toBe("E_NOT_FOUND");

    const noReason = await contractError(["ingest", "fail", statementFileId], 2);
    expect(noReason.error.code).toBe("E_USAGE");
  });

  it("files drop removes the statement's rows and reports what the cascade touched", async () => {
    const [dropped] = await contractRun("files drop", ["files", "drop", statementFileId, "--yes"]);
    expect(dropped).toMatchObject({ file_id: statementFileId, unvoided: 0 });
    expect(dropped.removed_transactions).toBeGreaterThan(0);
    // The batch raised five questions and two were answered; the rest go with the file.
    expect(dropped.removed_questions).toBe(3);
    // `ingest done` already took the cache dir, so there is none left to remove.
    expect(dropped.cache_removed).toEqual([]);
  });
});
