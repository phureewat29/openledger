import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as z from "zod";
import {
  createSandbox,
  makeRunCLI,
  parseNDJSON,
  parseOne,
  type CLIResult,
  type CLIRunner,
  type Sandbox,
} from "../../fixtures/sandbox.js";
import { EXIT } from "../../src/contract/exit.js";
import { ErrorEnvelope } from "../../src/contract/error.js";
import {
  Account,
  AccountDetail,
  AccountMatch,
  AccountTreeNode,
  ListAccountsSummary,
  TreeAccountsSummary,
  MatchAccountsSummary,
  CreateAccountResult,
  MergeAccountsResult,
  DeleteAccountResult,
  AdjustAccountResult,
  UpdateAccountResult,
} from "../../src/contract/accounts.js";

// Pins src/contract/accounts.ts against the real `accounts` CLI surface: every line of
// every invocation below must both `parse` against its schema and strip-compare equal to
// the raw JSON (undeclared fields would otherwise parse silently and go unnoticed).

let sandbox: Sandbox;
let runCLI: CLIRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-e2e-contract-accounts-");
  runCLI = makeRunCLI(sandbox, "dist");
});

afterAll(() => sandbox.cleanup());

// One ledger, one chain: a mid-chain failure would cascade into unrelated steps.
let stepFailed = false;
beforeEach((ctx) => ctx.skip(stepFailed, "an earlier step in this file failed"));
afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") stepFailed = true;
});

function oled(args: string[]): Promise<CLIResult> {
  return runCLI([...args, "--json"]);
}

async function ok(args: string[]): Promise<CLIResult> {
  const result = await oled(args);
  expect(result.code, `oled ${args.join(" ")} failed: ${result.stderr}`).toBe(0);
  return result;
}

/** `schema.parse` must succeed, and the parsed value must strip-compare equal to the raw
 *  line: a schema too loose (an undeclared field silently stripped) would still fail here. */
function assertLine<T>(schema: z.ZodType<T>, raw: unknown): void {
  const parsed = schema.parse(raw);
  expect(parsed).toEqual(raw);
}

function assertLines<T>(schema: z.ZodType<T>, raws: unknown[]): void {
  for (const raw of raws) assertLine(schema, raw);
}

/** For a streaming read (list/tree/match): every line but the last is a row, the last is
 *  the terminal summary, the same split `emitList`/`emitSummary` guarantee on the wire. */
function splitSummary(objs: unknown[]): { rows: unknown[]; summary: unknown } {
  const summary = objs[objs.length - 1] as { type?: string } | undefined;
  expect(summary?.type, "last stdout line must be the summary").toBe("summary");
  return { rows: objs.slice(0, -1), summary };
}

let leafId = "";
let secondId = "";

describe("accounts contract schemas match the real CLI surface (dist subprocess)", () => {
  it(
    "config --init bootstraps the ledger every later step reads",
    async () => {
      await ok([
        "config",
        "--init",
        "--data-dir",
        sandbox.dataDir,
        "--db",
        sandbox.dbPath,
        "--user-name",
        "Contract Tester",
        "--currency",
        "THB",
        "--locale",
        "th-TH",
      ]);
    },
    20000,
  );

  it(
    "accounts create (single mode) builds a parent+leaf chain and matches CreateAccountResult",
    async () => {
      // thb:expense already exists (config --init seeds it), so this auto-creates only
      // the intermediate "thb:expense:pet" parent.
      const res = await ok([
        "accounts", "create", "--id", "thb:expense:pet:food", "--name", "Food", "--type", "expense",
      ]);
      const line = parseOne(res.stdout);
      assertLine(CreateAccountResult, line);
      expect(line).toEqual({
        id: "thb:expense:pet:food",
        created: true,
        created_parents: ["thb:expense:pet"],
      });
      leafId = line.id;
    },
    20000,
  );

  it(
    "accounts create adds a second, sibling account under the same parent",
    async () => {
      const res = await ok([
        "accounts", "create", "--id", "thb:expense:pet:toys", "--name", "Toys", "--type", "expense",
      ]);
      const line = parseOne(res.stdout);
      assertLine(CreateAccountResult, line);
      // The parent was created by the previous step, so this time there is none to create.
      expect(line.created_parents).toEqual([]);
      secondId = line.id;
    },
    20000,
  );

  it(
    "accounts merge folds the second account into the leaf and matches MergeAccountsResult",
    async () => {
      const res = await ok(["accounts", "merge", "--from", secondId, "--to", leafId, "--yes"]);
      const line = parseOne(res.stdout);
      assertLine(MergeAccountsResult, line);
      expect(line).toMatchObject({ from: secondId, to: leafId, deleted_self_transactions: 0 });
    },
    20000,
  );

  it(
    "accounts adjust books a balancing transaction and matches AdjustAccountResult",
    async () => {
      const res = await ok(["accounts", "adjust", leafId, "--to", "500", "--reason", "opening balance"]);
      const line = parseOne(res.stdout);
      assertLine(AdjustAccountResult, line);
      expect(line.transaction_id).toMatch(/^tx:/);
      expect(line.delta).toBe(500);
    },
    20000,
  );

  it(
    "accounts match finds the leaf by a fuzzy query and matches AccountMatch/MatchAccountsSummary",
    async () => {
      const res = await ok(["accounts", "match", "--query", "food"]);
      const { rows, summary } = splitSummary(parseNDJSON(res.stdout));
      expect(rows.length).toBeGreaterThan(0);
      assertLines(AccountMatch, rows);
      assertLine(MatchAccountsSummary, summary);
      expect((rows as { account: { id: string } }[]).some((r) => r.account.id === leafId)).toBe(true);
    },
    20000,
  );

  it(
    "accounts update renames the leaf and matches UpdateAccountResult",
    async () => {
      const res = await ok(["accounts", "update", leafId, "--name", "Pet Food"]);
      const line = parseOne(res.stdout);
      assertLine(UpdateAccountResult, line);
      expect(line).toEqual({ id: leafId, name: "Pet Food", renamed: true });
    },
    20000,
  );

  it(
    "accounts tree emits every node against the recursive AccountTreeNode schema, then TreeAccountsSummary",
    async () => {
      const res = await ok(["accounts", "tree"]);
      const { rows, summary } = splitSummary(parseNDJSON(res.stdout));
      expect(rows.length).toBeGreaterThan(0);
      assertLines(AccountTreeNode, rows);
      assertLine(TreeAccountsSummary, summary);
    },
    20000,
  );

  it(
    "accounts list emits every account against the Account schema, then ListAccountsSummary",
    async () => {
      const res = await ok(["accounts", "list"]);
      const { rows, summary } = splitSummary(parseNDJSON(res.stdout));
      expect(rows.length).toBeGreaterThan(0);
      assertLines(Account, rows);
      assertLine(ListAccountsSummary, summary);
    },
    20000,
  );

  it(
    "accounts show returns the full detail shape and matches AccountDetail",
    async () => {
      const res = await ok(["accounts", "show", leafId]);
      const line = parseOne(res.stdout);
      assertLine(AccountDetail, line);
      expect(line).toMatchObject({ id: leafId, name: "Pet Food", balance: 500, children: [] });
    },
    20000,
  );

  it(
    "accounts delete removes a fresh empty account and matches DeleteAccountResult",
    async () => {
      const created = await ok([
        "accounts", "create", "--id", "thb:expense:pet:accessories", "--name", "Accessories", "--type", "expense",
      ]);
      assertLine(CreateAccountResult, parseOne(created.stdout));

      const res = await ok(["accounts", "delete", "thb:expense:pet:accessories", "--yes"]);
      const line = parseOne(res.stdout);
      assertLine(DeleteAccountResult, line);
      expect(line).toEqual({ id: "thb:expense:pet:accessories", deleted: true });
    },
    20000,
  );

  it(
    "accounts show on a missing id exits NOT_FOUND with a contract-shaped error envelope",
    async () => {
      const res = await oled(["accounts", "show", "thb:expense:does-not-exist"]);
      expect(res.code).toBe(EXIT.NOT_FOUND);
      expect(res.stdout).toBe("");
      const envelope = JSON.parse(res.stderr.trim());
      assertLine(ErrorEnvelope, envelope);
      expect(envelope.error.code).toBe("E_NOT_FOUND");
    },
    20000,
  );
});
