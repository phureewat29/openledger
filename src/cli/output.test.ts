import { describe, expect, it, onTestFinished } from "vitest";
import { Command } from "commander";
import chalk from "chalk";
import { createOutput, describeFailure, readGlobals, type OutputMode } from "./output.js";
import { fail } from "./errors.js";
import { EXIT } from "../contract/exit.js";

// CLIError is unexported; fail() is its only construction site.
function thrownBy(...args: Parameters<typeof fail>): unknown {
  try {
    fail(...args);
  } catch (err) {
    return err;
  }
  throw new Error("unreachable: fail() always throws");
}

// Global flags on the root, action receiving the leaf: the shape commander produces.
function parsedLeaf(argv: string[]): Command {
  const program = new Command();
  program.option("--json").option("--no-color").option("--config <path>");
  const leaf = program.command("list").option("--no-color");
  program.parse([...argv, "list"], { from: "user" });
  return leaf;
}

describe("readGlobals", () => {
  it("reads --json, --no-color and --config bound on an ancestor, past the leaf's own defaults", () => {
    expect(readGlobals(parsedLeaf(["--json", "--no-color", "--config", "c.json"]))).toEqual({
      json: true,
      noColor: true,
      config: "c.json",
    });
  });

  it("keeps an explicit empty --config distinct from no --config", () => {
    expect(readGlobals(parsedLeaf(["--config", ""])).config).toBe("");
    expect(readGlobals(parsedLeaf([]))).toEqual({ json: false, noColor: false, config: undefined });
  });
});

describe("describeFailure", () => {
  it("json mode is one NDJSON line with hint and details when present", () => {
    const err = thrownBy("NOT_FOUND", "widget:1 not found", {
      hint: "check the id",
      details: { id: "widget:1" },
    });
    const { stderr, exitCode } = describeFailure(err, true);
    expect(exitCode).toBe(EXIT.NOT_FOUND);
    expect(stderr.endsWith("\n")).toBe(true);
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(JSON.parse(stderr)).toEqual({
      error: {
        code: "E_NOT_FOUND",
        message: "widget:1 not found",
        hint: "check the id",
        details: { id: "widget:1" },
      },
    });
  });

  it("json mode omits hint and details keys entirely when absent", () => {
    const { stderr, exitCode } = describeFailure(new Error("boom"), true);
    expect(exitCode).toBe(EXIT.GENERIC);
    expect(JSON.parse(stderr).error).toEqual({ code: "E_GENERIC", message: "boom" });
  });

  it("human mode writes error: and hint: lines, the hint only when present", () => {
    const err = thrownBy("USAGE", "bad flag", { hint: "see --help" });
    expect(describeFailure(err, false)).toEqual({
      stderr: "error: bad flag\nhint: see --help\n",
      exitCode: EXIT.USAGE,
    });
    expect(describeFailure(new Error("boom"), false).stderr).toBe("error: boom\n");
  });
});

function captured(mode: Partial<OutputMode>): { out: ReturnType<typeof createOutput>; text: () => string } {
  const chunks: string[] = [];
  const full: OutputMode = { tty: false, color: false, kind: "plain", ...mode };
  return { out: createOutput(full, (s) => chunks.push(s)), text: () => chunks.join("") };
}

describe("createOutput", () => {
  it("emit and emitSummary write nothing outside --json, so a stray call can't corrupt human output", () => {
    const { out, text } = captured({});
    out.emit({ a: 1 });
    out.emitSummary({ total: 1 });
    expect(text()).toBe("");
  });

  it("strips libsql's top-level _metadata in both modes", () => {
    const json = captured({ kind: "json" });
    json.out.emitObject({ id: "x", _metadata: { duration: 1 } });
    json.out.emitSummary({ total: 1 });
    expect(json.text()).toBe('{"id":"x"}\n{"type":"summary","total":1}\n');

    const plain = captured({});
    plain.out.emitObject({ id: "x", nested: { a: 1 }, _metadata: { duration: 1 } });
    expect(plain.text()).toBe('id\tx\nnested\t{"a":1}\n');
  });

  it("emitRecord writes one JSON line, or one flattened key/value line per entry", () => {
    const record = { from: "2026-01-01", net: { THB: 1.5, USD: -2 } };
    const json = captured({ kind: "json" });
    json.out.emitRecord(record);
    expect(json.text()).toBe('{"from":"2026-01-01","net":{"THB":1.5,"USD":-2}}\n');

    const plain = captured({});
    plain.out.emitRecord(record, { boldKeys: true });
    expect(plain.text()).toBe("from\t2026-01-01\nnet.THB\t1.5\nnet.USD\t-2\n");

    const tty = captured({ kind: "tty", tty: true });
    tty.out.emitRecord(record, { boldKeys: true });
    expect(tty.text()).toBe("from     2026-01-01\nnet.THB  1.5\nnet.USD  -2\n");
  });

  it("paints only while colour is on, so NO_COLOR reaches every renderer", () => {
    // A vitest worker's stdout is no TTY, so chalk starts at level 0 and would paint nothing either way.
    const level = chalk.level;
    onTestFinished(() => {
      chalk.level = level;
    });
    chalk.level = 1;
    const paint = (color: boolean) => captured({ kind: "tty", tty: true, color }).out.paint;
    expect(paint(true).bold.yellow("x")).toBe("\u001b[1m\u001b[33mx\u001b[39m\u001b[22m");
    expect(paint(false).bold.yellow("x")).toBe("x");
  });
});

const EXIT_TABLE: [keyof typeof EXIT, number][] = [
  ["OK", 0],
  ["GENERIC", 1],
  ["USAGE", 2],
  ["NOT_READY", 3],
  ["INPUT_REQUIRED", 4],
  ["NOT_FOUND", 5],
  ["INVALID", 6],
  ["PARTIAL", 7],
  ["BUSY", 8],
];

describe("EXIT table", () => {
  it.each(EXIT_TABLE)("%s maps to exit code %i", (name, code) => {
    expect(EXIT[name]).toBe(code);
  });

  it("contains exactly the nine documented codes", () => {
    expect(Object.keys(EXIT)).toEqual(EXIT_TABLE.map(([name]) => name));
  });
});
