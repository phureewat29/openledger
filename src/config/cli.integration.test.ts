import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSandbox,
  makeRunCLI,
  parseOne,
  writeConfig,
  type CLIRunner,
  type Sandbox,
} from "../../fixtures/sandbox.js";
import { keyFingerprint } from "./config.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;

// Deliberately left without a config.json: every case sharing it asserts virgin-setup behaviour.
beforeAll(() => {
  sandbox = createSandbox("oled-config-it-");
  runCLI = makeRunCLI(sandbox);
});

afterAll(() => {
  sandbox.cleanup();
});

describe("bare config shows (subprocess)", () => {
  it("answers on a virgin setup with the defaults, typhoon among them", async () => {
    // `config` is exempt from the config-file gate (it reaches loadConfig directly rather
    // than requireConfig), so an absent file must read as defaults, never as E_NOT_READY.
    expect(existsSync(sandbox.configPath)).toBe(false);

    const { stdout, code } = await runCLI(["config", "--json"]);
    expect(code).toBe(0);
    const shown = parseOne(stdout);
    expect(shown).toMatchObject({ ocrModel: "typhoon-ocr1.5", config_path: sandbox.configPath });
    // The resolution fields render as their own snake_case rows; the internal ones never ship.
    expect(shown).not.toHaveProperty("configPath");
    expect(shown).not.toHaveProperty("exists");
    // Showing defaults must not bring the file it defaulted for into existence.
    expect(existsSync(sandbox.configPath)).toBe(false);
  }, 30000);
});

describe("config --currency (subprocess)", () => {
  it("refuses a code that could never name a ledger, before anything is persisted", async () => {
    const { stderr, code } = await runCLI(["config", "--init", "--currency", "us", "--json"]);
    expect(code).toBe(2);

    const { error } = JSON.parse(stderr.trim());
    expect(error.code).toBe("E_USAGE");
    expect(error.message).toBe("--currency must be a 3-letter currency code, e.g. THB");
    // Persisting it would abort every later converge on `us:expense:uncategorized`, an id the CHECK rejects.
    expect(existsSync(sandbox.configPath)).toBe(false);
  }, 30000);
});

describe("config --locale (subprocess)", () => {
  it("refuses a tag Intl cannot format with, before anything is persisted", async () => {
    const { stderr, code } = await runCLI(["config", "--init", "--locale", "xx_!!", "--json"]);
    expect(code).toBe(2);

    const { error } = JSON.parse(stderr.trim());
    expect(error.code).toBe("E_USAGE");
    expect(error.message).toBe("--locale must be a BCP 47 locale, e.g. th-TH");
    // Persisting it would make every later `oled status` on a terminal throw while formatting money.
    expect(existsSync(sandbox.configPath)).toBe(false);
  }, 30000);
});

describe("relative path flags (subprocess)", () => {
  it("persist absolute, resolved from the invoking cwd, so another cwd reaches the same ledger", async () => {
    const isolated = createSandbox("oled-config-relative-it-");
    try {
      const run = makeRunCLI(isolated);
      const work = join(isolated.root, "work");
      mkdirSync(work);
      const init = await run(
        ["config", "--init", "--db", "ledger.sqlite", "--data-dir", "statements", "--cache-dir", "cache", "--json"],
        { cwd: work },
      );
      expect(init.code, init.stderr).toBe(0);

      // The child's cwd is the physical path (macOS tmpdir sits behind a symlink).
      const base = realpathSync(work);
      expect(JSON.parse(readFileSync(isolated.configPath, "utf8"))).toMatchObject({
        dbPath: join(base, "ledger.sqlite"),
        dataDir: join(base, "statements"),
        cacheDir: join(base, "cache"),
      });
      expect(existsSync(join(base, "ledger.sqlite"))).toBe(true);

      const elsewhere = await run(["status", "--json"], { cwd: isolated.root });
      expect(elsewhere.code).toBe(0);
      expect(parseOne(elsewhere.stdout).db.reachable).toBe(true);
      // The old bug: a relative path re-resolved here and silently opened a fresh, empty ledger.
      expect(existsSync(join(isolated.root, "ledger.sqlite"))).toBe(false);
    } finally {
      isolated.cleanup();
    }
  }, 30000);
});

describe("the config-file gate (subprocess)", () => {
  it("a data command on a virgin setup exits NOT_READY and points at config --init", async () => {
    const isolated = createSandbox("oled-config-gate-it-");
    try {
      const { stderr, code } = await runCLI(["transactions", "list", "--json"], {
        env: isolated.env,
        cwd: isolated.root,
      });
      expect(code).toBe(3);
      const { error } = JSON.parse(stderr.trim());
      expect(error.code).toBe("E_NOT_READY");
      expect(error.message).toContain("no config file at");
      expect(error.hint).toContain("oled config --init");
    } finally {
      isolated.cleanup();
    }
  }, 30000);

  it("--config pointing at a missing file gates the same before and after the subcommand", async () => {
    // Both spellings in one run: they only read, so nothing serializes them.
    const [after, before] = await Promise.all([
      runCLI(["notes", "list", "--config", "/nonexistent/profile.json", "--json"]),
      runCLI(["--config", "/nonexistent/profile.json", "notes", "list", "--json"]),
    ]);
    for (const { stderr, code } of [after, before]) {
      expect(code).toBe(3);
      const { error } = JSON.parse(stderr.trim());
      expect(error.code).toBe("E_NOT_READY");
      expect(error.message).toContain("/nonexistent/profile.json");
    }
  }, 30000);

  it("the config command refuses the --config flag in every spelling: positional only", async () => {
    const named = `${sandbox.root}/flagged.json`;
    const forms = await Promise.all([
      runCLI(["config", "--config", named, "--json"]),
      runCLI(["--config", named, "config", "--json"]),
      // Inline form plus a setting flag: a broken guard would write, not just answer.
      runCLI(["config", `--config=${named}`, "--user-name", "Bob", "--json"]),
    ]);
    for (const { stderr, code } of forms) {
      expect(code).toBe(2);
      const { error } = JSON.parse(stderr.trim());
      expect(error.code).toBe("E_USAGE");
      expect(error.message).toContain("positional");
    }
    // Refused means refused: nothing was written anywhere on the way out.
    expect(existsSync(named)).toBe(false);
    expect(existsSync(sandbox.configPath)).toBe(false);
  }, 30000);

  it("showing an explicitly named file that does not exist is NOT_FOUND, never a defaults dump", async () => {
    // Pins the `config show` muscle-memory case: "show" must not read as a filename silently.
    const { stderr, code } = await runCLI(["config", "show", "--json"]);
    expect(code).toBe(5);
    const { error } = JSON.parse(stderr.trim());
    expect(error.code).toBe("E_NOT_FOUND");
    expect(error.message).toMatch(/no config file at .*show$/);
  }, 30000);

  it("a positional path runs an independent profile beside the default one", async () => {
    const isolated = createSandbox("oled-config-profile-it-");
    const profile = `${isolated.root}/profile.json`;
    try {
      const run = makeRunCLI(isolated);
      const init = await run(["config", profile, "--init", "--currency", "USD", "--json"]);
      expect(init.code).toBe(0);
      expect(parseOne(init.stdout).displayCurrency).toBe("USD");
      expect(existsSync(profile)).toBe(true);
      // The default location stays untouched: the profile is a whole separate config.
      expect(existsSync(isolated.configPath)).toBe(false);

      const show = await run(["config", profile, "--json"]);
      expect(parseOne(show.stdout).config_path).toBe(profile);
    } finally {
      isolated.cleanup();
    }
  }, 30000);

  it("two profiles initialized without --db each keep their own ledger beside their config", async () => {
    const isolated = createSandbox("oled-config-profiles-it-");
    try {
      const run = makeRunCLI(isolated);
      const dbs: string[] = [];
      for (const name of ["p1", "p2"]) {
        const dir = join(isolated.root, name);
        const init = await run(["config", join(dir, "conf.json"), "--init", "--json"]);
        expect(init.code, init.stderr).toBe(0);
        const shown = parseOne(init.stdout);
        expect(shown.dbPath).toBe(join(dir, "db.sqlite"));
        expect(shown.dataDir).toBe(join(dir, "data"));
        expect(shown.cacheDir).toBe(join(dir, "cache"));
        expect(existsSync(join(dir, "db.sqlite"))).toBe(true);
        dbs.push(shown.dbPath as string);
      }
      expect(new Set(dbs).size).toBe(2);
      // The default profile keeps its historical locations.
      const def = await run(["config", "--json"]);
      expect(parseOne(def.stdout)).toMatchObject({
        dbPath: join(isolated.oledDir, "db.sqlite"),
        dataDir: join(isolated.oledDir, "data"),
        cacheDir: join(isolated.oledDir, "cache"),
      });
    } finally {
      isolated.cleanup();
    }
  }, 30000);

  it("--init refuses a fully initialized setup, and rebuilds a deleted ledger", async () => {
    const isolated = createSandbox("oled-config-reinit-it-");
    try {
      const run = makeRunCLI(isolated);
      const first = await run(["config", "--init", "--json"]);
      expect(first.code).toBe(0);

      const again = await run(["config", "--init", "--json"]);
      expect(again.code).toBe(6);
      const { error } = JSON.parse(again.stderr.trim());
      expect(error.code).toBe("E_INVALID");
      expect(error.message).toContain("already initialized");

      // Without --init the same file keeps accepting settings.
      const update = await run(["config", "--user-name", "Somebody", "--json"]);
      expect(update.code).toBe(0);
      expect(parseOne(update.stdout).userName).toBe("Somebody");

      // A deleted ledger is a recovery case --init may rebuild, per doctor's own hint.
      rmSync(isolated.dbPath);
      const recover = await run(["config", "--init", "--json"]);
      expect(recover.code).toBe(0);
      expect(existsSync(isolated.dbPath)).toBe(true);
    } finally {
      isolated.cleanup();
    }
  }, 30000);
});

describe("a broken config file (subprocess)", () => {
  it("shows defaults with the problem named, and refuses to write over it", async () => {
    const isolated = createSandbox("oled-config-broken-it-");
    try {
      const run = makeRunCLI(isolated);
      writeFileSync(isolated.configPath, "not json\n");

      const show = await run(["config", "--json"]);
      expect(show.code).toBe(0);
      expect(parseOne(show.stdout).problem).toBeTruthy();

      const write = await run(["config", "--user-name", "Bob", "--json"]);
      expect(write.code).toBe(3);
      expect(JSON.parse(write.stderr.trim()).error.code).toBe("E_NOT_READY");
      // The hand-edited bytes survive untouched.
      expect(readFileSync(isolated.configPath, "utf8")).toBe("not json\n");
    } finally {
      isolated.cleanup();
    }
  }, 30000);
});

describe("a malformed config file never echoes its content (subprocess)", () => {
  it("no surface shows a fragment of the half-typed API key in it", async () => {
    const isolated = createSandbox("oled-config-leak-it-");
    try {
      const run = makeRunCLI(isolated);
      // Unquoted, so V8's own parse message would quote the bytes around the bad token.
      writeFileSync(isolated.configPath, '{"ocrApiKey": sk-live-SECRET123}\n');

      const [show, showHuman, status, statusVerbatim, doctor, gated, converge] = await Promise.all([
        run(["config", "--json"]),
        run(["config"]),
        run(["status", "--json"]),
        run(["status", "--no-redact", "--json"]),
        run(["doctor", "--json"]),
        run(["notes", "list", "--json"]),
        run(["config", "--user-name", "Bob", "--json"]),
      ]);
      for (const { stdout, stderr } of [show, showHuman, status, statusVerbatim, doctor, gated, converge]) {
        expect(stdout + stderr).not.toMatch(/sk-live|SECRET/);
      }

      expect(parseOne(show.stdout).problem).toBe("it is not valid JSON");
      expect(parseOne(status.stdout).config_problem).toBe("it is not valid JSON");
      expect(JSON.parse(gated.stderr.trim()).error.code).toBe("E_NOT_READY");
      const readable = parseOne(doctor.stdout).checks.find(
        (c: { name: string }) => c.name === "config_readable",
      );
      // Home-relative, like every other path status and doctor print.
      expect(readable.detail).toBe(
        "~/.oled/config.json is unusable, so defaults are in use: it is not valid JSON",
      );
    } finally {
      isolated.cleanup();
    }
  }, 30000);
});

describe("config --ocr-api-key (subprocess)", () => {
  const readConfigFile = (box: Sandbox): Record<string, unknown> =>
    JSON.parse(readFileSync(box.configPath, "utf8"));

  it("persists the key 0600 and prints only its fingerprint", async () => {
    const isolated = createSandbox("oled-config-key-it-");
    try {
      const run = makeRunCLI(isolated);
      const res = await run(["config", "--init", "--ocr-api-key", "sk-flag-secret", "--json"]);
      expect(res.code).toBe(0);
      const fingerprinted = { set: true, fingerprint: keyFingerprint("sk-flag-secret") };
      expect(parseOne(res.stdout).ocrApiKey).toEqual(fingerprinted);
      expect(res.stdout).not.toContain("sk-flag-secret");
      expect(readConfigFile(isolated).ocrApiKey).toBe("sk-flag-secret");
      expect(statSync(isolated.configPath).mode & 0o777).toBe(0o600);

      // Reading it back is the other half: the show path fingerprints a persisted key too.
      const show = await run(["config", "--json"]);
      expect(show.code).toBe(0);
      expect(parseOne(show.stdout).ocrApiKey).toEqual(fingerprinted);
      expect(show.stdout).not.toContain("sk-flag-secret");
    } finally {
      isolated.cleanup();
    }
  }, 30000);

  it("a converge with an unrelated flag leaves the persisted key alone", async () => {
    const isolated = createSandbox("oled-config-key-it-");
    try {
      const run = makeRunCLI(isolated);
      // Seeded by hand: the write path is `--ocr-api-key`'s own test, not this one's.
      writeConfig(isolated, { ocrApiKey: "sk-keep-me" });

      // Guards saveConfig's drop-undefined merge: a patch without the key must not clear it.
      const converge = await run(["config", "--user-name", "Somebody", "--json"]);
      expect(converge.code).toBe(0);
      expect(readConfigFile(isolated).ocrApiKey).toBe("sk-keep-me");
    } finally {
      isolated.cleanup();
    }
  }, 30000);

  it('--ocr-api-key "" clears the persisted key', async () => {
    const isolated = createSandbox("oled-config-key-it-");
    try {
      const run = makeRunCLI(isolated);
      writeConfig(isolated, { ocrApiKey: "sk-old" });

      const cleared = await run(["config", "--ocr-api-key", "", "--json"]);
      expect(cleared.code).toBe(0);
      expect(parseOne(cleared.stdout).ocrApiKey).toEqual({ set: false });
      expect(readConfigFile(isolated).ocrApiKey).toBe("");

      const show = await run(["config", "--json"]);
      expect(show.code).toBe(0);
      expect(parseOne(show.stdout).ocrApiKey).toEqual({ set: false });
      expect(show.stdout).not.toContain("sk-old");
    } finally {
      isolated.cleanup();
    }
  }, 30000);
});
