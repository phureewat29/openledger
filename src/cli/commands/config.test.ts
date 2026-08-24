import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { EXIT } from "../output.js";
import { inspectConfig, requireConfig } from "./config.js";

interface ThrownCLIError {
  code: keyof typeof EXIT;
  message: string;
  hint?: string;
}

// CLIError is unexported; catching what fail() throws is the only way to inspect it.
function thrownBy(run: () => unknown): ThrownCLIError {
  try {
    run();
  } catch (err) {
    return err as ThrownCLIError;
  }
  throw new Error("unreachable: run() was expected to throw");
}

/** Mirrors program.ts's per-level `--config <path>` registration, enough for
 *  resolveConfigPath's ancestor walk. Omitting `path` simulates no --config anywhere. */
function commandWithConfig(path?: string): Command {
  const program = new Command();
  program.option("--config <path>");
  program.parse(path !== undefined ? ["--config", path] : [], { from: "user" });
  return program;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "oled-config-cmd-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("requireConfig (unchanged by the assertUsable extraction)", () => {
  it("fails NOT_READY when the named file does not exist", () => {
    const missing = join(dir, "nope.json");
    const thrown = thrownBy(() => requireConfig(commandWithConfig(missing)));
    expect(thrown.code).toBe("NOT_READY");
    expect(EXIT[thrown.code]).toBe(3);
    expect(thrown.message).toBe(`no config file at ${missing}`);
    expect(thrown.hint).toBe("run `oled config --init`, or pass --config <path>");
  });

  it("fails NOT_READY when the named file exists but does not parse", () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "not json\n");
    const thrown = thrownBy(() => requireConfig(commandWithConfig(broken)));
    expect(thrown.code).toBe("NOT_READY");
    expect(thrown.message).toContain(`config file ${broken} is unusable`);
    expect(thrown.hint).toBe("fix or remove it, then run `oled config --init`");
  });

  it("returns the resolved config when the named file exists and parses", () => {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ displayCurrency: "USD" }));
    const cfg = requireConfig(commandWithConfig(good));
    expect(cfg.exists).toBe(true);
    expect(cfg.displayCurrency).toBe("USD");
  });
});

describe("inspectConfig: a named --config must still resolve", () => {
  it("fails NOT_READY when the named path does not exist", () => {
    const missing = join(dir, "nope.json");
    const thrown = thrownBy(() => inspectConfig(commandWithConfig(missing)));
    expect(thrown.code).toBe("NOT_READY");
    expect(thrown.message).toBe(`no config file at ${missing}`);
  });

  it("fails NOT_READY when the named path exists but is unusable", () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "not json\n");
    const thrown = thrownBy(() => inspectConfig(commandWithConfig(broken)));
    expect(thrown.code).toBe("NOT_READY");
    expect(thrown.message).toContain(`config file ${broken} is unusable`);
  });

  it("returns the resolved config when the named path exists and parses", () => {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ displayCurrency: "USD" }));
    const loaded = inspectConfig(commandWithConfig(good));
    expect(loaded.problem).toBeNull();
    expect(loaded.config.exists).toBe(true);
    expect(loaded.config.displayCurrency).toBe("USD");
  });
});

describe("inspectConfig: no --config stays lenient about the default profile", () => {
  // loadConfig resolves the default path from homedir(), which reads process.env.HOME on
  // every call; overriding it for the test body, then restoring it, keeps this off the
  // real ~/.oled without needing to touch any global state permanently.
  function withSandboxHome<T>(fn: (home: string) => T): T {
    const home = mkdtempSync(resolve(tmpdir(), "oled-config-home-"));
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      return fn(home);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("with no default file, reports exists:false instead of failing", () => {
    withSandboxHome(() => {
      const loaded = inspectConfig(commandWithConfig());
      expect(loaded.config.exists).toBe(false);
      expect(loaded.problem).toBeNull();
    });
  });

  it("with a broken default file, reports the problem instead of failing", () => {
    withSandboxHome((home) => {
      const oledDir = join(home, ".oled");
      mkdirSync(oledDir, { recursive: true });
      writeFileSync(join(oledDir, "config.json"), "not json\n");

      const loaded = inspectConfig(commandWithConfig());
      expect(loaded.config.exists).toBe(true);
      expect(loaded.problem).toBeTruthy();
    });
  });
});
