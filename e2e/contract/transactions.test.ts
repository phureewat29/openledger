import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { isEqual } from "es-toolkit";
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
import { TRANSACTIONS_CONTRACTS } from "../../src/contract/transactions.js";
import { ErrorEnvelope } from "../../src/contract/error.js";
import { EXIT } from "../../src/contract/exit.js";

/**
 * Drives the real `transactions` CLI surface (subprocess, built dist) and
 * checks every NDJSON line it emits against `TRANSACTIONS_CONTRACTS`: the
 * schema that matches a line must both parse it and reproduce it verbatim,
 * so a silently dropped or renamed field fails here, not just at read time.
 */

let sandbox: Sandbox;
let runCLI: CLIRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-e2e-contract-transactions-");
  runCLI = makeRunCLI(sandbox, "dist");
});

afterAll(() => sandbox.cleanup());

// One ledger, one chain: a mid-chain failure would cascade into unrelated steps.
let stepFailed = false;

beforeEach((ctx) => ctx.skip(stepFailed, "an earlier step in this chain failed"));

afterEach((ctx) => {
  if (ctx.task.result?.state === "fail") stepFailed = true;
});

/** Appends `--json`: every case here asserts the machine surface. */
function oled(args: string[], stdin?: string): Promise<CLIResult> {
  return runCLI([...args, "--json"], { stdin });
}

/** Exit 0 is the precondition of the next step, so it is asserted with the stderr that explains a failure. */
async function ok(args: string[], stdin?: string): Promise<CLIResult> {
  const result = await oled(args, stdin);
  expect(result.code, `oled ${args.join(" ")} failed: ${result.stderr}`).toBe(0);
  return result;
}

/** The schema in `lines` whose parse both succeeds and reproduces `line` verbatim, if any. */
function matchingSchema(line: unknown, schemas: readonly z.ZodType[]): z.ZodType | undefined {
  return schemas.find((schema) => {
    const result = schema.safeParse(line);
    return result.success && isEqual(result.data, line);
  });
}

function expectContractLine(contractKey: keyof typeof TRANSACTIONS_CONTRACTS, line: unknown): void {
  const schema = matchingSchema(line, TRANSACTIONS_CONTRACTS[contractKey].lines);
  expect(schema, `${contractKey}: no schema in lines matched ${JSON.stringify(line)}`).toBeDefined();
  expect(schema!.parse(line)).toEqual(line);
}

function expectContractLines(contractKey: keyof typeof TRANSACTIONS_CONTRACTS, lines: unknown[]): void {
  for (const line of lines) expectContractLine(contractKey, line);
}

// Threaded by the steps below, in the order the steps run.
let strictAddId = "";
let resolveAddId = "";
let merchantAddId = "";
let linkedLegAId = "";
let mirrorAId = "";
let mirrorBId = "";

describe("transactions contract (e2e, dist subprocess)", () => {
  it(
    "config --init and accounts create seed the ledger",
    async () => {
      await ok([
        "config", "--init",
        "--data-dir", sandbox.dataDir,
        "--db", sandbox.dbPath,
        "--user-name", "Contract Tester",
        "--currency", "THB",
        "--locale", "th-TH",
      ]);

      for (const [id, name, type, parent] of [
        ["thb:asset:bank:main", "Main Bank", "asset", "thb:asset"],
        ["thb:expense:groceries", "Groceries", "expense", "thb:expense"],
        ["thb:expense:coffee", "Coffee", "expense", "thb:expense"],
        ["thb:expense:mirror", "Mirror", "expense", "thb:expense"],
        ["thb:expense:linked-a", "LinkedA", "expense", "thb:expense"],
        ["thb:expense:linked-b", "LinkedB", "expense", "thb:expense"],
      ]) {
        await ok(["accounts", "create", "--id", id, "--name", name, "--type", type, "--parent", parent]);
      }
    },
    30000,
  );

  it(
    "transactions add: the strict, --resolve, and merchant-linking variants all match the contract",
    async () => {
      const strict = parseOne(
        (
          await ok([
            "transactions", "add",
            "--debit-account", "thb:expense:groceries",
            "--credit-account", "thb:asset:bank:main",
            "--amount", "42.50",
            "--date", "2026-01-05",
            "--description", "Grocery run",
          ])
        ).stdout,
      );
      expectContractLine("transactions add", strict);
      strictAddId = strict.transaction_id;

      // --resolve routes through commitTransaction (src/ingest/commit.ts) but `add` builds its
      // own 4-field result, not the ingest per-row shape; both variants share the "transactions
      // add" leaf key, so both lines get checked against the same contract entry.
      const resolved = parseOne(
        (
          await ok([
            "transactions", "add", "--resolve",
            "--debit-account", "thb:expense:new-cat",
            "--credit-account", "thb:asset:bank:main",
            "--amount", "15",
            "--date", "2026-01-06",
            "--description", "Resolve path test",
          ])
        ).stdout,
      );
      expectContractLine("transactions add", resolved);
      resolveAddId = resolved.transaction_id;

      const withMerchant = parseOne(
        (
          await ok([
            "transactions", "add",
            "--debit-account", "thb:expense:coffee",
            "--credit-account", "thb:asset:bank:main",
            "--amount", "5.75",
            "--date", "2026-01-07",
            "--description", "Coffee run",
            "--merchant-name", "Starbucks",
          ])
        ).stdout,
      );
      expectContractLine("transactions add", withMerchant);
      merchantAddId = withMerchant.transaction_id;
    },
    30000,
  );

  it(
    "ingest commit seeds a linked pair (transactions add has no flag of its own for grouping)",
    async () => {
      const linkedRow = {
        date: "2026-01-08",
        description: "Linked pair test",
        linked: [
          { debit_account_id: "thb:expense:linked-a", credit_account_id: "thb:asset:bank:main", amount: 100 },
          { debit_account_id: "thb:expense:linked-b", credit_account_id: "thb:asset:bank:main", amount: 50 },
        ],
      };
      const objs = parseNDJSON((await ok(["ingest", "commit"], JSON.stringify(linkedRow))).stdout);
      const result = objs.find((o) => o.type === "result");
      expect(result?.ok, `ingest commit failed: ${JSON.stringify(result)}`).toBe(true);
      linkedLegAId = result.legs[0].transaction_id;
    },
    30000,
  );

  it(
    "transactions add seeds a deliberate mirror pair for dedupe/merge",
    async () => {
      const first = parseOne(
        (
          await ok([
            "transactions", "add",
            "--debit-account", "thb:expense:mirror",
            "--credit-account", "thb:asset:bank:main",
            "--amount", "88",
            "--date", "2026-01-09",
            "--description", "cross-statement payment",
          ])
        ).stdout,
      );
      expectContractLine("transactions add", first);
      mirrorAId = first.transaction_id;

      const second = parseOne(
        (
          await ok([
            "transactions", "add",
            "--debit-account", "thb:expense:mirror",
            "--credit-account", "thb:asset:bank:main",
            "--amount", "88",
            "--date", "2026-01-09",
            "--description", "cross-statement payment",
          ])
        ).stdout,
      );
      expectContractLine("transactions add", second);
      mirrorBId = second.transaction_id;
    },
    30000,
  );

  it(
    "transactions list: every flat row and the terminal capped summary match the contract",
    async () => {
      const lines = parseNDJSON((await ok(["transactions", "list"])).stdout);
      expectContractLines("transactions list", lines);
      expect(lines.some((l) => l.id === strictAddId)).toBe(true);
      expect(lines.find((l) => l.type === "summary")).toMatchObject({ type: "summary" });
    },
    30000,
  );

  it(
    "transactions list --group: cluster lines (including the linked pair) and the summary match the contract",
    async () => {
      const lines = parseNDJSON((await ok(["transactions", "list", "--group"])).stdout);
      expectContractLines("transactions list", lines);

      const linkedCluster = lines.find(
        (l) => Array.isArray(l.transactions) && l.transactions.some((t: { id: string }) => t.id === linkedLegAId),
      );
      expect(linkedCluster?.transactions).toHaveLength(2);
      expect(linkedCluster?.group_id).toMatch(/^tg:/);
    },
    30000,
  );

  it(
    "transactions show: the grouped line (carrying `group`) and a plain line both match the contract",
    async () => {
      const grouped = parseOne((await ok(["transactions", "show", linkedLegAId])).stdout);
      expectContractLine("transactions show", grouped);
      expect(grouped.group).toHaveLength(2);

      const plain = parseOne((await ok(["transactions", "show", strictAddId])).stdout);
      expectContractLine("transactions show", plain);
      expect(plain.group).toBeUndefined();
    },
    30000,
  );

  it(
    "transactions update matches the contract",
    async () => {
      const updated = parseOne(
        (
          await ok([
            "transactions", "update", resolveAddId,
            "--description", "Resolve path test (updated)",
          ])
        ).stdout,
      );
      expectContractLine("transactions update", updated);
    },
    30000,
  );

  it(
    "transactions recategorize matches the contract",
    async () => {
      const result = parseOne(
        (
          await ok([
            "transactions", "recategorize",
            "--filter-account", "thb:expense:coffee",
            "--set-account", "thb:expense:groceries",
          ])
        ).stdout,
      );
      expectContractLine("transactions recategorize", result);
    },
    30000,
  );

  it(
    "transactions dedupe: the mirror pair's rows and the summary match the contract",
    async () => {
      const lines = parseNDJSON((await ok(["transactions", "dedupe"])).stdout);
      expectContractLines("transactions dedupe", lines);

      const rows = lines.filter((l) => l.type !== "summary");
      expect(rows.map((r) => r.id).sort()).toEqual([mirrorAId, mirrorBId].sort());
    },
    30000,
  );

  it(
    "transactions merge: voiding a mirror, then re-merging the already-void mirror, both match the contract",
    async () => {
      const merged = parseOne(
        (await ok(["transactions", "merge", "--from", mirrorBId, "--to", mirrorAId, "--yes"])).stdout,
      );
      expectContractLine("transactions merge", merged);
      expect(merged).toEqual({ from: mirrorBId, to: mirrorAId, voided: true });

      const again = parseOne(
        (await ok(["transactions", "merge", "--from", mirrorBId, "--to", mirrorAId, "--yes"])).stdout,
      );
      expectContractLine("transactions merge", again);
      expect(again).toEqual({ from: mirrorBId, to: mirrorAId, voided: false, already_void: true });
    },
    30000,
  );

  it(
    "transactions delete matches the contract",
    async () => {
      const deleted = parseOne((await ok(["transactions", "delete", merchantAddId, "--yes"])).stdout);
      expectContractLine("transactions delete", deleted);
    },
    30000,
  );

  it(
    "transactions show on a missing id is a NOT_FOUND ErrorEnvelope",
    async () => {
      const result = await oled(["transactions", "show", "tx:00000000-0000-0000-0000-000000000000"]);
      expect(result.code).toBe(EXIT.NOT_FOUND);
      expect(result.stdout.trim()).toBe("");

      const err = JSON.parse(result.stderr.trim());
      expect(ErrorEnvelope.parse(err)).toEqual(err);
      expect(err.error.code).toBe("E_NOT_FOUND");
    },
    30000,
  );
});
