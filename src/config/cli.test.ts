import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EXIT } from "../contract/exit.js";
import { inspectConfig, requireConfig } from "./cli.js";
import { removeTree } from "../../fixtures/sandbox.js";

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

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "oled-config-cmd-"));
});

afterEach(() => removeTree(dir));

describe("requireConfig (unchanged by the assertUsable extraction)", () => {
  it("fails NOT_READY when the named file does not exist", () => {
    const missing = join(dir, "nope.json");
    const thrown = thrownBy(() => requireConfig(missing, { cwd: dir, home: dir }));
    expect(thrown.code).toBe("NOT_READY");
    expect(EXIT[thrown.code]).toBe(3);
    expect(thrown.message).toBe(`no config file at ${missing}`);
    expect(thrown.hint).toBe("run `oled config --init`, or pass --config <path>");
  });

  it("fails NOT_READY when the named file exists but does not parse", () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "not json\n");
    const thrown = thrownBy(() => requireConfig(broken, { cwd: dir, home: dir }));
    expect(thrown.code).toBe("NOT_READY");
    expect(thrown.message).toContain(`config file ${broken} is unusable`);
    expect(thrown.hint).toBe("fix or remove it, then run `oled config --init`");
  });

  it("returns the resolved config when the named file exists and parses", () => {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ displayCurrency: "USD" }));
    const cfg = requireConfig(good, { cwd: dir, home: dir });
    expect(cfg.exists).toBe(true);
    expect(cfg.displayCurrency).toBe("USD");
  });
});

describe("inspectConfig: a named --config must still resolve", () => {
  it("fails NOT_READY when the named path does not exist", () => {
    const missing = join(dir, "nope.json");
    const thrown = thrownBy(() => inspectConfig(missing, { cwd: dir, home: dir }));
    expect(thrown.code).toBe("NOT_READY");
    expect(thrown.message).toBe(`no config file at ${missing}`);
  });

  it("fails NOT_READY when the named path exists but is unusable", () => {
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "not json\n");
    const thrown = thrownBy(() => inspectConfig(broken, { cwd: dir, home: dir }));
    expect(thrown.code).toBe("NOT_READY");
    expect(thrown.message).toContain(`config file ${broken} is unusable`);
  });

  it("returns the resolved config when the named path exists and parses", () => {
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ displayCurrency: "USD" }));
    const loaded = inspectConfig(good, { cwd: dir, home: dir });
    expect(loaded.problem).toBeNull();
    expect(loaded.config.exists).toBe(true);
    expect(loaded.config.displayCurrency).toBe("USD");
  });
});

describe("inspectConfig: no --config stays lenient about the default profile", () => {
  it("with no default file, reports exists:false instead of failing", () => {
    const loaded = inspectConfig(undefined, { cwd: dir, home: dir });
    expect(loaded.config.exists).toBe(false);
    expect(loaded.problem).toBeNull();
  });

  it("with a broken default file, reports the problem instead of failing", () => {
    const oledDir = join(dir, ".oled");
    mkdirSync(oledDir, { recursive: true });
    writeFileSync(join(oledDir, "config.json"), "not json\n");

    const loaded = inspectConfig(undefined, { cwd: dir, home: dir });
    expect(loaded.config.exists).toBe(true);
    expect(loaded.problem).toBe("it is not valid JSON");
  });
});
