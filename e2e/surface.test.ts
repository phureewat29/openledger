import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createSandbox,
  makeRunCLI,
  parseNdjson,
  type CLIResult,
  type CLIRunner,
  type Sandbox,
} from "../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;

// One sandbox for every case below: they only read, against a ledger seeded by one `config --init`.
beforeAll(async () => {
  sandbox = createSandbox("oled-e2e-read-");
  runCLI = makeRunCLI(sandbox, "dist");
  const init = await runCLI(["config", "--init", "--json"]);
  if (init.code !== 0) throw new Error(`config --init failed: ${init.stderr}`);
}, 30000);

afterAll(() => {
  sandbox.cleanup();
});

const ESC = /\x1b/;

interface SurfaceCase {
  label: string;
  args: string[];
  exit: number;
  /** A list read: its last stdout line must be the summary row. */
  list?: boolean;
}

// The whole surface an agent can reach before anything is ingested; per-command payloads are
// pinned under src/, this table pins only the uniform wire contract across all of them.
const SURFACE_CASES: SurfaceCase[] = [
  { label: "status", args: ["status"], exit: 0 },
  { label: "doctor", args: ["doctor"], exit: 0 },
  { label: "config", args: ["config"], exit: 0 },
  { label: "ingest list", args: ["ingest", "list"], exit: 0, list: true },
  { label: "files list", args: ["files", "list"], exit: 0, list: true },
  { label: "transactions list", args: ["transactions", "list"], exit: 0, list: true },
  { label: "transactions list --group", args: ["transactions", "list", "--group"], exit: 0, list: true },
  { label: "transactions dedupe", args: ["transactions", "dedupe"], exit: 0, list: true },
  { label: "accounts list", args: ["accounts", "list"], exit: 0, list: true },
  { label: "accounts tree", args: ["accounts", "tree"], exit: 0, list: true },
  { label: "merchants list", args: ["merchants", "list"], exit: 0, list: true },
  { label: "questions list", args: ["questions", "list"], exit: 0, list: true },
  { label: "report", args: ["report", "--from", "2026-01-01", "--to", "2026-01-31"], exit: 0 },
  { label: "notes list", args: ["notes", "list"], exit: 0, list: true },
  { label: "datasets", args: ["datasets"], exit: 0, list: true },
  {
    label: "datasets institutions --country th",
    args: ["datasets", "institutions", "--country", "th"],
    exit: 0,
    list: true,
  },
  {
    label: "transactions show tx:nonexistent",
    args: ["transactions", "show", "tx:nonexistent"],
    exit: 5, // EXIT.NOT_FOUND
  },
  {
    label: "transactions delete tx:nonexistent",
    args: ["transactions", "delete", "tx:nonexistent", "--yes"],
    exit: 5, // EXIT.NOT_FOUND
  },
];

// Blank lines carry nothing; every other line must parse to one JSON object. A top-level
// array or scalar is a contract breach even though it would JSON.parse.
function nonObjectLines(stream: string): string[] {
  return stream.split("\n").filter((line) => {
    if (line.trim().length === 0) return false;
    try {
      const value = JSON.parse(line);
      return value === null || typeof value !== "object" || Array.isArray(value);
    } catch {
      return true;
    }
  });
}

function lastLine(stream: string): string {
  const lines = stream.split("\n").filter((line) => line.trim().length > 0);
  return lines[lines.length - 1] ?? "";
}

/** The same uniform wire contract SURFACE_CASES asserts, for a case that had to be driven by hand. */
function expectListShape(label: string, result: CLIResult): void {
  expect(result.code, `${label} stderr: ${result.stderr}`).toBe(0);
  expect(nonObjectLines(result.stdout), `${label}: stdout lines that are not one JSON object`).toEqual([]);
  expect(nonObjectLines(result.stderr), `${label}: stderr lines that are not one JSON object`).toEqual([]);
  expect(result.stdout, `${label}: ANSI escape bytes on stdout`).not.toMatch(ESC);
  expect(JSON.parse(lastLine(result.stdout)).type, `${label}: last stdout line`).toBe("summary");
}

describe("money aggregates on a virgin ledger (dist subprocess)", () => {
  // Every aggregate is a map keyed by ISO currency code, never a scalar to add across
  // currencies; a virgin ledger has no postings at all, which is what an empty map means.
  it("status and report carry currency-keyed maps, empty before anything is posted", async () => {
    const status = await runCLI(["status", "--json"]);
    expect(status.code, `stderr: ${status.stderr}`).toBe(0);
    expect(JSON.parse(status.stdout.trim()).net_worth).toEqual({
      assets: {},
      liabilities: {},
      net_worth: {},
    });

    const args = ["report", "--from", "2026-01-01", "--to", "2026-01-31", "--json"];
    const report = await runCLI(args);
    expect(report.code, `stderr: ${report.stderr}`).toBe(0);
    expect(JSON.parse(report.stdout.trim())).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
      income: {},
      expenses: {},
      net: {},
    });
  }, 20000);

  it("every accounts tree node carries its currency and a keyed rollup", async () => {
    const tree = await runCLI(["accounts", "tree", "--json"]);
    expect(tree.code, `stderr: ${tree.stderr}`).toBe(0);

    const nodes = tree.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line))
      .filter((node) => node.type !== "summary");

    // config --init seeds the display-currency ledger's structural accounts: exactly the
    // expense and equity type roots.
    expect(nodes.map((n) => n.id).sort()).toEqual(["thb:equity", "thb:expense"]);
    expect(nodes.find((n) => n.id === "thb:expense")).toEqual({
      id: "thb:expense",
      name: "Expenses (THB)",
      type: "expense",
      currency: "THB",
      balance: 0,
      rollup: { THB: 0 },
      children: [
        {
          id: "thb:expense:uncategorized",
          name: "Uncategorized (THB)",
          type: "expense",
          currency: "THB",
          balance: 0,
          rollup: { THB: 0 },
          children: [],
        },
      ],
    });
  }, 20000);
});

describe("CLI surface on a virgin ledger (dist subprocess)", () => {
  it.each(SURFACE_CASES)(
    "oled $label exits $exit with NDJSON-only, ANSI-free output on both streams",
    async ({ args, exit, list }) => {
      const { stdout, stderr, code } = await runCLI([...args, "--json"]);

      expect(code, `stderr: ${stderr}`).toBe(exit);
      expect(nonObjectLines(stdout), "stdout lines that are not one JSON object").toEqual([]);
      expect(nonObjectLines(stderr), "stderr lines that are not one JSON object").toEqual([]);
      expect(stdout, "ANSI escape bytes on stdout").not.toMatch(ESC);
      expect(stderr, "ANSI escape bytes on stderr").not.toMatch(ESC);

      // A list read always ends with its summary, so an empty result is one
      // summary line, never zero bytes.
      if (list) {
        expect(JSON.parse(lastLine(stdout)).type, "last stdout line").toBe("summary");
      }
    },
    20000,
  );
});

/**
 * The four writes that stream rows the same way a list read does. They need a
 * row to act on, so they take their own ledger: the sweep above asserts a
 * virgin one and must stay that way.
 */
describe("row-streaming writes end with a summary too (dist subprocess)", () => {
  let writeSandbox: Sandbox;
  let runWrite: CLIRunner;
  let questionIds: string[] = [];

  beforeAll(async () => {
    writeSandbox = createSandbox("oled-e2e-write-");
    runWrite = makeRunCLI(writeSandbox, "dist");
    const init = await runWrite(["config", "--init", "--json"]);
    if (init.code !== 0) throw new Error(`config --init failed: ${init.stderr}`);

    // Neither row names a placeable debit account, so each lands in
    // uncategorized and opens exactly one question about it.
    const rows = [0, 1]
      .map((i) =>
        JSON.stringify({
          date: `2026-05-0${i + 1}`,
          description: `Needs a category ${i}`,
          debit_account: "mysterious",
          credit_account: "thb:equity:opening",
          amount: 10 + i,
        }),
      )
      .join("\n");
    const committed = await runWrite(["ingest", "commit", "--json"], { stdin: rows });
    if (committed.code !== 0) throw new Error(`seeding commit failed: ${committed.stderr}`);

    const listed = await runWrite(["questions", "list", "--json"]);
    questionIds = parseNdjson(listed.stdout)
      .filter((row) => row.type !== "summary")
      .map((row) => row.id as string);
    if (questionIds.length < 2) {
      throw new Error(`seeding raised ${questionIds.length} questions, needed 2`);
    }
  }, 60000);

  afterAll(() => {
    writeSandbox.cleanup();
  });

  it("oled questions defer exits 0 with NDJSON-only, ANSI-free output on both streams", async () => {
    expectListShape(
      "questions defer",
      await runWrite(["questions", "defer", questionIds[0], "--days", "3", "--json"]),
    );
  }, 20000);

  it("oled questions answer exits 0 with NDJSON-only, ANSI-free output on both streams", async () => {
    expectListShape(
      "questions answer",
      await runWrite(["questions", "answer", questionIds[1], "--answer", "confirmed", "--json"]),
    );
  }, 20000);

  it("oled notes add exits 0 with NDJSON-only, ANSI-free output on both streams", async () => {
    expectListShape(
      "notes add",
      await runWrite(["notes", "add", "--content", "surface probe", "--json"]),
    );
  }, 20000);

  it("oled notes rm exits 0 with NDJSON-only, ANSI-free output on both streams", async () => {
    const listed = await runWrite(["notes", "list", "--json"]);
    const noteId = parseNdjson(listed.stdout).find((row) => row.type !== "summary")?.id;
    expectListShape("notes rm", await runWrite(["notes", "rm", String(noteId), "--yes", "--json"]));
  }, 20000);
});
