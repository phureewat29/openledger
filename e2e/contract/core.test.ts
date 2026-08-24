import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { isDeepStrictEqual } from "node:util";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  createSandbox,
  makeRunCLI,
  parseNdjson,
  parseOne,
  type CLIRunner,
  type Sandbox,
} from "../../fixtures/sandbox.js";
import type { CommandContract } from "../../src/contract/kind.js";
import { EXIT } from "../../src/contract/exit.js";
import { ErrorEnvelope } from "../../src/contract/error.js";
import { STATUS_CONTRACTS } from "../../src/contract/status.js";
import { DOCTOR_CONTRACTS } from "../../src/contract/doctor.js";
import { CONFIG_CONTRACTS } from "../../src/contract/config.js";
import { SETUP_CONTRACTS } from "../../src/contract/setup.js";
import { OPEN_CONTRACTS } from "../../src/contract/open.js";
import { DATASETS_CONTRACTS } from "../../src/contract/datasets.js";
import { REPORT_CONTRACTS } from "../../src/contract/report.js";

/**
 * Every line these seven commands can emit under `--json`, checked against the
 * exact schemas `COMMAND_CONTRACTS` publishes for them: a schema that no longer
 * matches live output is a broken promise to `@aquartier/openledger/contract`
 * consumers, not just an internal type error.
 */

// Not `schema.parse`: `lines` holds every shape a command MAY emit, and a line can
// parse under a narrower sibling by having its extra keys stripped (a converge result
// parses as the bare read view, minus `created`). So a line matches only when SOME
// schema both parses it and reproduces it key-for-key; parse success alone proves nothing.
function assertMatchesContract(parsed: unknown, contract: CommandContract): void {
  let stripped: unknown;
  for (const schema of contract.lines) {
    const result = schema.safeParse(parsed);
    if (!result.success) continue;
    // z.object silently strips unknown keys on success, so equality (not just
    // success) is what catches a field the emitter added but the schema never declared.
    if (isDeepStrictEqual(result.data, parsed)) return;
    stripped ??= result.data;
  }
  if (stripped !== undefined) {
    expect(stripped).toEqual(parsed);
    return;
  }
  expect.fail(`no schema in this command's contract matched: ${JSON.stringify(parsed)}`);
}

function assertOneLineMatches(stdout: string, contract: CommandContract): void {
  assertMatchesContract(parseOne(stdout), contract);
}

function assertEveryLineMatches(stdout: string, contract: CommandContract): void {
  const lines = parseNdjson(stdout);
  expect(lines.length, "expected at least one NDJSON line").toBeGreaterThan(0);
  for (const line of lines) assertMatchesContract(line, contract);
}

/** Stubs the platform opener so `open --json` never pops a real file-manager window
 *  under a CI run: a no-op script wins the PATH lookup ahead of the real binary. */
function stubOpenerEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  const bin = join(sandbox.root, "fake-opener-bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["open", "xdg-open"]) {
    const script = join(bin, name);
    writeFileSync(script, "#!/bin/sh\nexit 0\n");
    chmodSync(script, 0o755);
  }
  return { ...sandbox.env, PATH: `${bin}:${sandbox.env.PATH ?? ""}` };
}

describe("contract-core: live --json output matches the published contract", () => {
  let sandbox: Sandbox;
  let runCLI: CLIRunner;

  beforeAll(async () => {
    sandbox = createSandbox("oled-e2e-contract-core-");
    runCLI = makeRunCLI(sandbox, "dist");

    const init = await runCLI(["config", "--init", "--currency", "THB", "--country", "TH", "--json"]);
    if (init.code !== 0) throw new Error(`config --init failed: ${init.stderr}`);
    // Covers the write-path shape (ConfigConvergeResult); the read-path shape has its own case below.
    assertOneLineMatches(init.stdout, CONFIG_CONTRACTS.config);

    // No --file: these post as rows with no source file, the simplest way to give
    // `report` real income/expense totals without a full ingest/prepare/commit lifecycle.
    const rows = [
      {
        date: "2026-02-01",
        description: "Salary",
        debit_account: "thb:asset:bank:kasibank",
        credit_account: "thb:income:salary",
        amount: 1000,
        row_index: 0,
      },
      {
        date: "2026-02-02",
        description: "Groceries",
        debit_account: "thb:expense:food",
        credit_account: "thb:asset:bank:kasibank",
        amount: 200,
        row_index: 1,
      },
    ];
    const commit = await runCLI(["ingest", "commit", "--json"], {
      stdin: rows.map((row) => JSON.stringify(row)).join("\n"),
    });
    if (commit.code !== 0) throw new Error(`ingest commit failed: ${commit.stderr}`);
  }, 30000);

  afterAll(() => {
    sandbox.cleanup();
  });

  it("status --json matches STATUS_CONTRACTS", async () => {
    const res = await runCLI(["status", "--json"]);
    expect(res.code, res.stderr).toBe(0);
    assertOneLineMatches(res.stdout, STATUS_CONTRACTS.status);
  });

  it("doctor --json matches DOCTOR_CONTRACTS", async () => {
    const res = await runCLI(["doctor", "--json"]);
    expect(res.code, res.stderr).toBe(0);
    assertOneLineMatches(res.stdout, DOCTOR_CONTRACTS.doctor);
  });

  it("config --json (bare read) matches CONFIG_CONTRACTS", async () => {
    const res = await runCLI(["config", "--json"]);
    expect(res.code, res.stderr).toBe(0);
    assertOneLineMatches(res.stdout, CONFIG_CONTRACTS.config);
  });

  it("setup --dir <target> --json matches SETUP_CONTRACTS", async () => {
    const target = join(sandbox.root, "setup-target");
    const res = await runCLI(["setup", "--dir", target, "--json"]);
    expect(res.code, res.stderr).toBe(0);
    assertOneLineMatches(res.stdout, SETUP_CONTRACTS.setup);
  });

  it("open --json matches OPEN_CONTRACTS", async () => {
    const res = await runCLI(["open", "--json"], { env: stubOpenerEnv(sandbox) });
    expect(res.code, res.stderr).toBe(0);
    assertOneLineMatches(res.stdout, OPEN_CONTRACTS.open);
  });

  it("datasets --json (bare list) matches DATASETS_CONTRACTS", async () => {
    const res = await runCLI(["datasets", "--json"]);
    expect(res.code, res.stderr).toBe(0);
    assertEveryLineMatches(res.stdout, DATASETS_CONTRACTS.datasets);
  });

  const namedDatasetArgs = [
    ["institutions", "--country", "th", "--json"],
    ["defaults", "--json"],
    ["noise", "--country", "th", "--json"],
  ] as const;

  for (const args of namedDatasetArgs) {
    it(`datasets ${args[0]} --json matches DATASETS_CONTRACTS`, async () => {
      const res = await runCLI(["datasets", ...args]);
      expect(res.code, res.stderr).toBe(0);
      assertEveryLineMatches(res.stdout, DATASETS_CONTRACTS.datasets);
    });
  }

  it("report --json matches REPORT_CONTRACTS", async () => {
    const res = await runCLI(["report", "--from", "2020-01-01", "--to", "2030-01-01", "--json"]);
    expect(res.code, res.stderr).toBe(0);
    assertOneLineMatches(res.stdout, REPORT_CONTRACTS.report);
  });

  it("report --json with no dates exits USAGE with an ErrorEnvelope on stderr", async () => {
    const res = await runCLI(["report", "--json"]);
    expect(res.code).toBe(EXIT.USAGE);
    expect(res.stdout).toBe("");
    const envelope: unknown = JSON.parse(res.stderr.trim());
    const parsed = ErrorEnvelope.safeParse(envelope);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(parsed.success && parsed.data).toEqual(envelope);
  });
});
