import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, saveConfig } from "./config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), "oled-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig hardening", () => {
  it("parses a config.json carrying a UTF-8 BOM (Windows editors and redirects)", () => {
    const path = resolve(dir, "bom.json");
    writeFileSync(path, "﻿" + JSON.stringify({ displayCurrency: "USD" }));
    const { config, problem } = loadConfig(path, dir);
    expect(problem).toBeNull();
    expect(config.displayCurrency).toBe("USD");
  });

  it("expands `~/` in persisted path fields instead of resolving them under the cwd", () => {
    const path = resolve(dir, "tilde.json");
    writeFileSync(path, JSON.stringify({ dataDir: "~/statements" }));
    const { config } = loadConfig(path, dir);
    expect(config.dataDir).toBe(resolve(homedir(), "statements"));
  });

  it("resolves a hand-edited relative path against the config file's dir, not the cwd", () => {
    const profileDir = join(dir, "profile");
    mkdirSync(profileDir);
    const path = join(profileDir, "config.json");
    writeFileSync(path, JSON.stringify({ dbPath: "ledger.sqlite", dataDir: "../statements" }));
    const { config } = loadConfig(path, dir);
    expect(config.dbPath).toBe(join(profileDir, "ledger.sqlite"));
    expect(config.dataDir).toBe(join(dir, "statements"));
  });

  it("puts the default config file and every default location under the given home", () => {
    const { config } = loadConfig(undefined, dir);
    expect(config.configPath).toBe(join(dir, ".oled", "config.json"));
    expect(config.dbPath).toBe(join(dir, ".oled", "db.sqlite"));
    expect(config.dataDir).toBe(join(dir, ".oled", "data"));
    expect(config.cacheDir).toBe(join(dir, ".oled", "cache"));
    expect(config.exists).toBe(false);
  });

  it("defaults the db, data and cache beside whichever config file is loaded", () => {
    for (const profile of ["p1", "p2"]) {
      const { config } = loadConfig(join(dir, profile, "conf.json"), dir);
      expect(config.dbPath).toBe(join(dir, profile, "db.sqlite"));
      expect(config.dataDir).toBe(join(dir, profile, "data"));
      expect(config.cacheDir).toBe(join(dir, profile, "cache"));
    }
  });
});

describe("loadConfig: a malformed file never echoes its content", () => {
  const SECRET = "sk-live-SECRET123";

  // Every shape V8 reports differently: an unexpected token (which V8 quotes), a
  // positioned error, a truncated file, and a value that is not an object.
  const MALFORMED: [string, string, string][] = [
    ["an unquoted value", `{"ocrApiKey": ${SECRET}}`, "it is not valid JSON"],
    [
      "a missing comma",
      `{\n  "ocrApiKey": "${SECRET}"\n  "userName": "Bob"\n}`,
      "it is not valid JSON at line 3, column 3",
    ],
    ["a trailing comma", `{"ocrApiKey": "${SECRET}",}`, "it is not valid JSON at line 1, column 35"],
    ["a truncated file", `{"ocrApiKey": "${SECRET}`, "it is not valid JSON at line 1, column 33"],
    ["a bare word", "sk-live-SECRET123", "it is not valid JSON"],
    ["a string instead of an object", `"${SECRET}"`, "it does not hold a JSON object"],
  ];

  it.each(MALFORMED)("%s yields a fixed problem with at most a line and column", (_, text, expected) => {
    const path = join(dir, "config.json");
    writeFileSync(path, text);
    const { problem, config } = loadConfig(path, dir);
    expect(problem).toBe(expected);
    // A broken file degrades to defaults; nothing from it survives into the values either.
    expect(config.ocrApiKey).toBe("");
  });
});

describe("saveConfig", () => {
  it("tightens a pre-existing default config dir to 0700", () => {
    const oledDir = join(dir, ".oled");
    mkdirSync(oledDir);
    chmodSync(oledDir, 0o755);
    saveConfig(join(oledDir, "config.json"), { userName: "Bob" }, dir);
    expect(statSync(oledDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(oledDir, "config.json")).mode & 0o777).toBe(0o600);
  });

  it("leaves a profile's own pre-existing dir alone: it is the caller's, and may be shared", () => {
    const shared = join(dir, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o755);
    saveConfig(join(shared, "config.json"), { userName: "Bob" }, dir);
    expect(statSync(shared).mode & 0o777).toBe(0o755);
  });

  it("creates a missing config dir 0700", () => {
    const fresh = join(dir, "fresh", "nested");
    saveConfig(join(fresh, "config.json"), { userName: "Bob" }, dir);
    expect(statSync(fresh).mode & 0o777).toBe(0o700);
  });
});
