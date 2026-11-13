import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createSandbox,
  distEntry,
  makeRunCLI,
  parseNDJSON,
  parseOne,
  type CLIRunner,
  type Sandbox,
} from "../fixtures/sandbox.js";
import { createTestSandbox } from "../fixtures/test-cleanup.js";

// A --config that is missing, unusable, or a directory must gate status/doctor exactly like
// every other command: exit NOT_READY, nothing on stdout. Bare status/doctor (no --config)
// keep answering from the default profile even when it has no file at all. Both halves are pinned here.
describe("the config gate on status and doctor", () => {
  let sandbox: Sandbox;
  let runCLI: CLIRunner;

  // One real, initialized default profile shared by every case below: they only read it (or
  // deliberately fail before reaching it), so nothing here needs its own sandbox.
  beforeAll(async () => {
    sandbox = createSandbox("oled-e2e-config-gate-");
    runCLI = makeRunCLI(sandbox, "dist");
    const init = await runCLI(["config", "--init", "--json"]);
    if (init.code !== 0) throw new Error(`config --init failed: ${init.stderr}`);
  }, 30000);

  afterAll(() => sandbox.cleanup());

  it.each(["status", "doctor"])(
    "%s --config <missing path> exits NOT_READY with nothing on stdout",
    async (command) => {
      const bogus = join(sandbox.root, `${command}-missing.json`);
      const { stdout, stderr, code } = await runCLI([command, "--config", bogus, "--json"]);
      expect(code).toBe(3);
      expect(stdout).toBe("");
      const { error } = JSON.parse(stderr.trim());
      expect(error.code).toBe("E_NOT_READY");
      expect(error.message).toContain(bogus);
    },
    20000,
  );

  it.each(["status", "doctor"])(
    "%s --config <malformed file> exits NOT_READY with nothing on stdout",
    async (command) => {
      const broken = join(sandbox.root, `${command}-broken.json`);
      writeFileSync(broken, "not json\n");
      const { stdout, stderr, code } = await runCLI([command, "--config", broken, "--json"]);
      expect(code).toBe(3);
      expect(stdout).toBe("");
      const { error } = JSON.parse(stderr.trim());
      expect(error.code).toBe("E_NOT_READY");
      expect(error.message).toContain("is unusable");
    },
    20000,
  );

  it.each(["status", "doctor"])(
    "%s --config <directory> exits NOT_READY with nothing on stdout",
    async (command) => {
      const asDir = join(sandbox.root, `${command}-a-directory.json`);
      mkdirSync(asDir, { recursive: true });
      const { stdout, stderr, code } = await runCLI([command, "--config", asDir, "--json"]);
      expect(code).toBe(3);
      expect(stdout).toBe("");
      const { error } = JSON.parse(stderr.trim());
      expect(error.code).toBe("E_NOT_READY");
    },
    20000,
  );

  it("never answers from the default profile: a bogus --config leaks no seeded counts", async () => {
    // The shared sandbox's default profile is real: config --init in beforeAll seeded its
    // structural accounts, so a leak back to the old defaulting behavior would show up here
    // as a non-empty report instead of the gate's usual empty stdout.
    const baseline = await runCLI(["status", "--json"]);
    expect(baseline.code).toBe(0);
    expect(parseOne(baseline.stdout).counts.accounts).toBeGreaterThan(0);

    const bogus = join(sandbox.root, "leak-probe.json");
    const leaked = await runCLI(["status", "--config", bogus, "--json"]);
    expect(leaked.code).toBe(3);
    // The decisive assertion: nothing reaches stdout at all, not a redacted or partial report.
    expect(leaked.stdout).toBe("");
  }, 20000);

  it.skipIf(process.platform === "win32")(
    "status and a data command still run from a deleted cwd when --config is absolute",
    async () => {
      // A spawn into a missing cwd fails, so the shell removes the dir after entering it.
      const fromDeletedCwd = async (args: string[]): Promise<string> => {
        const gone = mkdtempSync(join(sandbox.root, "gone-"));
        const script = 'cd "$1" && rmdir "$1" && shift && exec "$@"';
        const argv = ["-c", script, "sh", gone, process.execPath, distEntry, ...args];
        const { stdout } = await promisify(execFile)("/bin/sh", argv, { env: sandbox.env });
        return stdout;
      };
      const config = ["--config", sandbox.configPath, "--json"];
      expect(parseOne(await fromDeletedCwd(["status", ...config])).db.reachable).toBe(true);
      const accounts = parseNDJSON(await fromDeletedCwd(["accounts", "list", ...config]));
      expect(accounts.length).toBeGreaterThan(0);
    },
    20000,
  );

  // Doctor's probe file is not asserted absent: dataDirWritableCheck self-cleans it inside one
  // tryExecute, so absence proves nothing; the missing-path case above already pins this exit.
});

describe("bare status/doctor keep today's lenient behavior (no --config)", () => {
  it("bare status on a virgin setup exits 0 with configured:false and null counts", async () => {
    const isolated = createTestSandbox("oled-e2e-config-gate-bare-");
    const runIsolated = makeRunCLI(isolated, "dist");
    const { stdout, code } = await runIsolated(["status", "--json"]);
    expect(code).toBe(0);
    const report = parseOne(stdout);
    expect(report.configured).toBe(false);
    expect(report.counts).toBeNull();
  }, 20000);
});
