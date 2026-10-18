import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { EXIT, runAction } from "./output.js";
import { fail } from "./errors.js";

// Reset so a failing-exit-code assertion in one test can't leak into vitest's own exit code.
afterEach(() => {
  process.exitCode = undefined;
});

interface ThrownCLIError {
  code: keyof typeof EXIT;
  message: string;
  hint?: string;
  details?: unknown;
}

// CLIError is unexported; fail()/failReason() are its only construction sites.
function thrownBy(raise: () => never): ThrownCLIError {
  try {
    raise();
  } catch (err) {
    return err as ThrownCLIError;
  }
  throw new Error("unreachable: raise() always throws");
}

function makeCLIError(...args: Parameters<typeof fail>): ThrownCLIError {
  return thrownBy(() => fail(...args));
}

function jsonCommand(): Command {
  const program = new Command();
  program.option("--json");
  program.parse(["--json"], { from: "user" });
  return program;
}

// --json on an ancestor, action receiving the leaf: pins the parent-chain walk in resolveMode.
function nestedJsonLeaf(): Command {
  const program = new Command();
  program.option("--json");
  const leaf = program.command("list");
  program.parse(["--json", "list"], { from: "user" });
  return leaf;
}

async function captureReport(
  err: unknown,
  cmd?: Command,
): Promise<{ exitCode: typeof process.exitCode; stderrLines: string[] }> {
  const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    const action = runAction((_cmd?: Command): never => {
      throw err;
    });
    await action(cmd);
    const stderrLines = writeSpy.mock.calls.map((call) => String(call[0]));
    return { exitCode: process.exitCode, stderrLines };
  } finally {
    writeSpy.mockRestore();
  }
}

describe("reportError: rendering (via runAction)", () => {
  it("json mode emits one NDJSON line to stderr with hint and details when present", async () => {
    const err = makeCLIError("NOT_FOUND", "widget:1 not found", {
      hint: "check the id",
      details: { id: "widget:1" },
    });
    const { exitCode, stderrLines } = await captureReport(err, jsonCommand());
    expect(exitCode).toBe(EXIT.NOT_FOUND);
    expect(stderrLines).toHaveLength(1);
    expect(JSON.parse(stderrLines[0])).toEqual({
      error: {
        code: "E_NOT_FOUND",
        message: "widget:1 not found",
        hint: "check the id",
        details: { id: "widget:1" },
      },
    });
  });

  it("json mode omits hint and details keys entirely when absent", async () => {
    const { exitCode, stderrLines } = await captureReport(new Error("boom"), jsonCommand());
    expect(exitCode).toBe(EXIT.GENERIC);
    // An exact toEqual is already the key-set check the title asks for.
    expect(JSON.parse(stderrLines[0]).error).toEqual({ code: "E_GENERIC", message: "boom" });
  });

  it("json mode is honored when --json sits on an ancestor command", async () => {
    const { exitCode, stderrLines } = await captureReport(new Error("boom"), nestedJsonLeaf());
    expect(exitCode).toBe(EXIT.GENERIC);
    expect(stderrLines).toHaveLength(1);
    expect(JSON.parse(stderrLines[0])).toEqual({
      error: { code: "E_GENERIC", message: "boom" },
    });
  });

  it("plain mode writes error: and hint: lines", async () => {
    const err = makeCLIError("USAGE", "bad flag", { hint: "see --help" });
    const { exitCode, stderrLines } = await captureReport(err);
    expect(exitCode).toBe(EXIT.USAGE);
    expect(stderrLines).toEqual(["error: bad flag\n", "hint: see --help\n"]);
  });

  it("plain mode omits the hint line when absent", async () => {
    const { exitCode, stderrLines } = await captureReport(new Error("boom"));
    expect(exitCode).toBe(EXIT.GENERIC);
    expect(stderrLines).toEqual(["error: boom\n"]);
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
