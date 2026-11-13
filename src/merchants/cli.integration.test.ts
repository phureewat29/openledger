import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "libsql";
import { migrate } from "../db/schema.js";
import { createAccount } from "../accounts/accounts.js";
import { upsertMerchant } from "./queries.js";
import {
  createSandbox,
  makeRunCLI,
  writeConfig,
  type CLIRunner,
  type Sandbox,
} from "../../fixtures/sandbox.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;
let merchantId: string;

beforeAll(() => {
  sandbox = createSandbox("oled-merchants-it-");
  runCLI = makeRunCLI(sandbox);
  writeConfig(sandbox, {});

  // Closed before the CLI runs so the subprocess owns the writer.
  const db = new Database(sandbox.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  createAccount(db, { id: "thb:expense:food", name: "Food", type: "expense", parent_id: "thb:expense" });
  merchantId = upsertMerchant(db, { canonical_name: "Starbucks", default_account_id: "thb:expense:food" }, []).id;
  db.close();
});

afterAll(() => sandbox.cleanup());

function stderrError(stderr: string): { code: string; message: string } {
  return JSON.parse(stderr.trim()).error;
}

describe("merchants update", () => {
  it("refuses a call that names the merchant but no change (USAGE)", async () => {
    const result = await runCLI(["merchants", "update", "--merchant", merchantId, "--json"]);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(stderrError(result.stderr)).toMatchObject({
      code: "E_USAGE",
      message: "at least one of --name, --alias, --default-account is required",
    });
  }, 30000);

  it("reports a missing merchant before a missing default account", async () => {
    const result = await runCLI([
      "merchants", "update", "--merchant", "m:missing", "--default-account", "thb:expense:nope", "--json",
    ]);
    expect(result.code).toBe(5);
    expect(stderrError(result.stderr).message).toBe('merchant "m:missing" not found');
  }, 30000);
});

describe("merchants set-default", () => {
  it("reports a missing merchant before a missing account", async () => {
    const result = await runCLI([
      "merchants", "set-default", "--merchant", "m:missing", "--account", "thb:expense:nope", "--json",
    ]);
    expect(result.code).toBe(5);
    expect(stderrError(result.stderr).message).toBe('merchant "m:missing" not found');
  }, 30000);

  it("reports the default it replaced", async () => {
    const result = await runCLI(["merchants", "set-default", "--merchant", merchantId, "--clear", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      merchant_id: merchantId,
      before: "thb:expense:food",
      after: null,
    });
  }, 30000);
});
