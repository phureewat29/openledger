import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Chalk } from "chalk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LoadedConfig } from "../../config/config.js";
import { buildReport, renderTTY } from "./status.js";
import { ANSI_RE } from "../format.js";
import type { StatusReport } from "../../contract/status.js";
import { CONTRACT_VERSION } from "../../contract/version.js";
import { getVersion } from "../../lib/version.js";
import { removeTree } from "../../../fixtures/sandbox.js";

const PLAIN = new Chalk({ level: 0 });

function report(over: Partial<StatusReport> = {}): StatusReport {
  return {
    type: "status",
    contract_version: CONTRACT_VERSION,
    version: getVersion(),
    configured: true,
    config_path: "/tmp/none/config.json",
    config_problem: null,
    data_dir: "/tmp/none/data",
    locale: "th-TH",
    currency: "THB",
    user_name: "User",
    db: { path: "/tmp/none/db.sqlite", reachable: true, error: null },
    counts: { accounts: 1, transactions: 1, merchants: 0, notes: 0 },
    files: { new: 0, ingested: 0, pending: 0, failed: 0 },
    questions: null,
    net_worth: { assets: {}, liabilities: { JPY: 1500 }, net_worth: { JPY: -1500 } },
    ...over,
  };
}

describe("renderTTY (the only surface that formats money for humans)", () => {
  it("renders a negative net worth signed, in the currency's own fraction digits", () => {
    const out = renderTTY(report({ locale: "ja-JP", currency: "JPY" }), PLAIN);

    // JPY has no minor unit: 1,500 exactly, never 1,500.00.
    expect(out).toContain("1,500");
    expect(out).not.toMatch(/1,500\.0/);
    // A ledger in net debt must read as debt.
    expect(out).toMatch(/-[^\d]*1,500/);
  });

  it("gives every ledger its own labelled rows, each in its own currency", () => {
    // The display currency is THB; the JPY figures must not borrow its exponent.
    const out = renderTTY(
      report({
        locale: "en-US",
        currency: "THB",
        net_worth: {
          assets: { JPY: 1500, THB: 20.5 },
          liabilities: {},
          net_worth: { JPY: 1500, THB: 20.5 },
        },
      }),
      PLAIN,
    );

    expect(out).toMatch(/JPY net worth\s+¥1,500\n/);
    expect(out).toMatch(/THB net worth\s+THB\s20\.50\n/);
    // Ledgers sort by ISO code, and neither total is folded into the other.
    expect(out.indexOf("JPY net worth")).toBeLessThan(out.indexOf("THB net worth"));
    expect(out).not.toContain("1,520");
  });

  it("badges waiting statements beside the ingested count", () => {
    const out = renderTTY(report({ files: { new: 2, ingested: 1, pending: 0, failed: 0 } }), PLAIN);
    expect(out).toMatch(/Files\s+1\s+\(2 new\)/);
  });

  it("points a missing ledger at config --init, and an unopenable one at doctor", () => {
    const unreachable = report({
      db: { path: "/tmp/none/db.sqlite", reachable: false, error: "no ledger yet" },
      counts: null,
      net_worth: null,
    });

    const missing = renderTTY(unreachable, PLAIN, true);
    expect(missing).toContain("oled config --init");

    // An existing-but-unopenable db is a diagnosis job, not an init job.
    const corrupt = renderTTY(unreachable, PLAIN, false);
    expect(corrupt).toContain("oled doctor");
  });

  it("colours through the given paint without moving a column", () => {
    const colored = renderTTY(report({ config_problem: "broken" }), new Chalk({ level: 1 }));
    expect(colored).toMatch(ANSI_RE);
    expect(colored.replace(ANSI_RE, "")).toBe(renderTTY(report({ config_problem: "broken" }), PLAIN));
  });

  it("shows a dim unusable-config line only when the default profile's file is broken", () => {
    const clean = renderTTY(report(), PLAIN);
    expect(clean).not.toContain("unusable");

    const broken = renderTTY(
      report({ config_problem: "it is not valid JSON at line 1, column 2" }),
      PLAIN,
    );
    expect(broken).toContain("unusable: it is not valid JSON at line 1, column 2");
  });
});

describe("buildReport: the default profile's own problem", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(resolve(tmpdir(), "oled-status-report-"));
  });

  afterAll(() => removeTree(dir));

  // Paths deliberately point at nothing under `dir`: buildReport must thread `problem`
  // through on its no-ledger-yet path without needing a reachable db.
  function fixtureConfig(): LoadedConfig["config"] {
    return {
      country: "TH",
      displayLocale: "th-TH",
      displayCurrency: "THB",
      dbPath: join(dir, "db.sqlite"),
      dataDir: join(dir, "data"),
      cacheDir: join(dir, "cache"),
      userName: "User",
      ocrBaseUrl: "",
      ocrModel: "test-model",
      ocrApiKey: "",
      configPath: join(dir, "config.json"),
      contextPath: join(dir, "context.md"),
      exists: true,
      home: join(dir, "home"),
    };
  }

  it("carries a broken default file's problem into the report without failing", () => {
    const loaded: LoadedConfig = {
      config: fixtureConfig(),
      fileValues: {},
      problem: "it does not hold a JSON object",
    };

    const built = buildReport(loaded, { state: "missing" });
    expect(built.config_problem).toBe("it does not hold a JSON object");
    // A broken file still resolves to defaults, so `configured` reads the same as any other run.
    expect(built.configured).toBe(true);
  });

  it("carries config_problem:null when the file is fine", () => {
    const loaded: LoadedConfig = { config: fixtureConfig(), fileValues: {}, problem: null };
    const built = buildReport(loaded, { state: "missing" });
    expect(built.config_problem).toBeNull();
  });

  it("reports an unreachable ledger's error as given, with no counts", () => {
    const loaded: LoadedConfig = { config: fixtureConfig(), fileValues: {}, problem: null };
    const built = buildReport(loaded, { state: "unreachable", error: "Cannot open database at ~/x" });
    expect(built.db).toEqual({ path: join(dir, "db.sqlite"), reachable: false, error: "Cannot open database at ~/x" });
    expect(built.counts).toBeNull();
  });
});
