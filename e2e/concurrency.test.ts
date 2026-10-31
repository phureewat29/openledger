import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "libsql";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { rmSync } from "node:fs";
import {
  createSandbox,
  makeRunCLI,
  type CLIRunner,
  type Sandbox,
} from "../fixtures/sandbox.js";
import { MIGRATIONS } from "../src/db/migrations/index.js";

/** Nothing here may run against a real ledger: every path below is under the sandbox HOME. */
async function initSandbox(prefix: string): Promise<[Sandbox, CLIRunner]> {
  const sandbox = createSandbox(prefix);
  const runCLI = makeRunCLI(sandbox, "dist");
  const init = await runCLI([
    "config",
    "--init",
    "--db",
    sandbox.dbPath,
    "--data-dir",
    sandbox.dataDir,
    "--json",
  ]);
  if (init.code !== 0) throw new Error(`config --init failed: ${init.stderr}`);
  return [sandbox, runCLI];
}

function appliedVersions(dbPath: string): number[] {
  const db = new Database(dbPath);
  try {
    return (
      db.prepare(`SELECT version FROM schema_migrations ORDER BY version`).all() as {
        version: number;
      }[]
    ).map((row) => row.version);
  } finally {
    db.close();
  }
}

describe("six openers racing to create one ledger", () => {
  let sandbox: Sandbox;
  let runCLI: CLIRunner;

  beforeAll(async () => {
    [sandbox, runCLI] = await initSandbox("oled-e2e-race-");
  }, 60_000);

  afterAll(() => sandbox.cleanup());

  it("lets every one of them through, and applies each migration exactly once", async () => {
    // Deleting the ledger puts all six on the first-ever-open path: journal conversion
    // and migration at once, the collision an embedder measured at roughly one open in seven.
    for (const path of [sandbox.dbPath, `${sandbox.dbPath}-wal`, `${sandbox.dbPath}-shm`]) {
      rmSync(path, { force: true });
    }

    const results = await Promise.all(
      Array.from({ length: 6 }, () => runCLI(["accounts", "list", "--json"])),
    );

    for (const [index, result] of results.entries()) {
      expect(result.code, `opener ${index} failed: ${result.stderr}`).toBe(0);
      // Both refusals that used to win this race tell the user to move a healthy ledger aside.
      expect(result.stderr).not.toMatch(/not a database|not an OpenLedger database/i);
    }

    expect(appliedVersions(sandbox.dbPath)).toEqual(
      MIGRATIONS.map((_migration, index) => index + 1),
    );
  }, 60_000);
});

const HOLD_MS = 15_000;

/** Holds the ledger's write lock from outside the CLI, the way a second `oled` would. */
function spawnLockHolder(dbPath: string): ChildProcess {
  const libsqlEntry = createRequire(import.meta.url).resolve("libsql");
  const script = `
    const Database = require(${JSON.stringify(libsqlEntry)});
    const db = new Database(process.env.HOLD_DB);
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("INSERT INTO notes (content, category) VALUES (?, ?)").run("lock holder", "fact");
    process.stdout.write("ready\\n");
    setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, ${HOLD_MS});
  `;
  return spawn(process.execPath, ["-e", script], {
    env: { ...process.env, HOLD_DB: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function whenHolding(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
      if (out.includes("ready")) resolve();
    });
    child.stderr?.on("data", (chunk) => reject(new Error(`lock holder failed: ${String(chunk)}`)));
    child.on("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
}

describe("a write against a ledger another process holds", () => {
  let sandbox: Sandbox;
  let runCLI: CLIRunner;

  beforeAll(async () => {
    [sandbox, runCLI] = await initSandbox("oled-e2e-busy-");
  }, 60_000);

  afterAll(() => sandbox.cleanup());

  // `notes add` takes the lock at BEGIN IMMEDIATE, where SQLite's busy handler runs; a deferred
  // transaction would fail its later lock upgrade at once and prove nothing about the timeout.
  it("waits out its busy timeout, then exits BUSY (8) with a re-run hint", async () => {
    const holder = spawnLockHolder(sandbox.dbPath);
    await whenHolding(holder);

    const startedAt = Date.now();
    const result = await runCLI(["notes", "add", "--content", "contended", "--category", "fact", "--json"]);
    const elapsed = Date.now() - startedAt;
    holder.kill();

    expect(result.code, `expected BUSY, got: ${result.stderr}`).toBe(8);
    const payload = JSON.parse(result.stderr.trim()) as { error: { code: string; hint?: string } };
    expect(payload.error.code).toBe("E_BUSY");
    expect(payload.error.hint).toContain("re-run");
    // A busy_timeout of 0 (libsql's default) would have failed in milliseconds instead.
    expect(elapsed).toBeGreaterThan(3000);
  }, 20_000);
});
