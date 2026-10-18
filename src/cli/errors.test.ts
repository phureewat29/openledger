import { describe, expect, it } from "vitest";
import { ValidationError } from "../lib/validate.js";
import { DBBusyError, DBNotReadyError } from "../db/errors.js";
import type { AccountFailure } from "../accounts/accounts.js";
import { EXIT } from "../contract/exit.js";
import { REASON_EXIT, fail, failReason, mapNotFoundError, toCLIError } from "./errors.js";

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


describe("toCLIError: classification", () => {
  it("passes a CLIError through unchanged", () => {
    const original = makeCLIError("NOT_FOUND", "widget:1 not found", { hint: "check the id" });
    expect(toCLIError(original)).toBe(original);
  });

  it("maps a ValidationError to USAGE (exit 2) with its message", () => {
    const result = toCLIError(new ValidationError("--id required"));
    expect(result.code).toBe("USAGE");
    expect(EXIT[result.code]).toBe(2);
    expect(result.message).toBe("--id required");
    expect(result.hint).toBe("append --help to the command for its flags and usage");
  });

  it("maps an unknown Error to GENERIC (exit 1)", () => {
    const result = toCLIError(new Error("boom"));
    expect(result.code).toBe("GENERIC");
    expect(EXIT[result.code]).toBe(1);
    expect(result.message).toBe("boom");
    expect(result.hint).toBeUndefined();
  });

  const NON_ERROR_CASES: [unknown, string][] = [
    [42, "42"],
    ["plain string", "plain string"],
    [{ weird: true }, "[object Object]"],
    [null, "null"],
    [undefined, "undefined"],
  ];

  it.each(NON_ERROR_CASES)(
    "maps a non-Error thrown value %p to GENERIC with String(value) => %s",
    (thrown, expected) => {
      const result = toCLIError(thrown);
      expect(result.code).toBe("GENERIC");
      expect(EXIT[result.code]).toBe(1);
      expect(result.message).toBe(expected);
    },
  );

  it("maps a DBNotReadyError to NOT_READY (exit 3) with the init hint", () => {
    const message = "This database is not an OpenLedger database.";
    const result = toCLIError(new DBNotReadyError(message));
    expect(result.code).toBe("NOT_READY");
    expect(EXIT[result.code]).toBe(3);
    expect(result.message).toBe(message);
    expect(result.hint).toBe("run `oled config --init` to configure the harness");
  });

  const BUSY_HINT = "another oled process is using the ledger; re-run the same command in a moment";

  it("maps a DBBusyError to BUSY (exit 8) with the re-run hint", () => {
    const message = "The ledger at /tmp/db.sqlite is in use by another process and did not free up in time.";
    const result = toCLIError(new DBBusyError(message));
    expect(result.code).toBe("BUSY");
    expect(EXIT[result.code]).toBe(8);
    expect(result.message).toBe(message);
    expect(result.hint).toBe(BUSY_HINT);
  });

  // A lock lost after the open arrives as libsql's own error; only `code` tells it apart.
  const BUSY_CODES = ["SQLITE_BUSY", "SQLITE_BUSY_RECOVERY", "SQLITE_BUSY_SNAPSHOT"];

  it.each(BUSY_CODES)("maps a %s-coded error to BUSY (exit 8)", (code) => {
    const result = toCLIError(Object.assign(new Error("database is locked"), { code }));
    expect(result.code).toBe("BUSY");
    expect(EXIT[result.code]).toBe(8);
    expect(result.hint).toBe(BUSY_HINT);
  });

  const DAMAGED_CODES = ["SQLITE_CORRUPT", "SQLITE_NOTADB"];

  it.each(DAMAGED_CODES)("maps a %s-coded error to NOT_READY (exit 3) with the restore hint", (code) => {
    const result = toCLIError(Object.assign(new Error("file is not a database"), { code }));
    expect(result.code).toBe("NOT_READY");
    expect(EXIT[result.code]).toBe(3);
    expect(result.message).toBe(`The ledger file is damaged (${code}): file is not a database`);
    expect(result.hint).toContain(".bak");
  });

  // Matching by wording would let a reword silently move an exit code; the type is the only signal.
  const FORMER_NOT_READY_WORDINGS = [
    "failed to open database",
    "corrupt database",
    "not a database",
    "file is encrypted",
    "not configured",
    "not an openledger database",
  ];

  it.each(FORMER_NOT_READY_WORDINGS)(
    "leaves a plain Error saying %j as GENERIC (exit 1)",
    (wording) => {
      const result = toCLIError(new Error(`sqlite: ${wording}`));
      expect(result.code).toBe("GENERIC");
      expect(EXIT[result.code]).toBe(1);
    },
  );
});

interface ReasonCase {
  reason: AccountFailure;
  code: keyof typeof EXIT;
  exitCode: number;
}

/** Pinned as data, not read off REASON_EXIT: a re-pointed reason must fail here. */
const REASON_CASES: ReasonCase[] = [
  { reason: "account_exists", code: "INVALID", exitCode: 6 },
  { reason: "parent_not_found", code: "NOT_FOUND", exitCode: 5 },
  { reason: "invalid_hierarchy", code: "INVALID", exitCode: 6 },
];

describe("failReason", () => {
  it.each(REASON_CASES)("$reason exits $code ($exitCode)", ({ reason, code, exitCode }) => {
    const thrown = thrownBy(() => failReason({ reason, message: "refused" }));
    expect(thrown.code).toBe(code);
    expect(EXIT[thrown.code]).toBe(exitCode);
    expect(thrown.message).toBe("refused");
    expect(thrown.hint).toBeUndefined();
  });

  it("carries a hint only when one is given", () => {
    const thrown = thrownBy(() =>
      failReason({ reason: "parent_not_found", message: "no parent" }, "create it first"),
    );
    expect(thrown.hint).toBe("create it first");
  });

  it("assigns an exit code to every reason arm", () => {
    expect(Object.keys(REASON_EXIT).sort()).toEqual(REASON_CASES.map((c) => c.reason).sort());
  });
});

interface NotFoundCase {
  desc: string;
  message: string;
  code: "NOT_FOUND" | "INVALID";
  exitCode: number;
}

const NOT_FOUND_CASES: NotFoundCase[] = [
  {
    desc: "a message matching /not found/i",
    message: "account:1 not found",
    code: "NOT_FOUND",
    exitCode: 5,
  },
  {
    desc: "a message matching /does not exist/i",
    message: "merchant does not exist",
    code: "NOT_FOUND",
    exitCode: 5,
  },
  {
    desc: "anything else",
    message: "currency mismatch",
    code: "INVALID",
    exitCode: 6,
  },
];

describe("mapNotFoundError", () => {
  it.each(NOT_FOUND_CASES)("throws $code for $desc", ({ message, code, exitCode }) => {
    const err = new Error(message);
    let thrown: unknown;
    try {
      mapNotFoundError(err);
    } catch (caught) {
      thrown = caught;
    }
    // toCLIError's identity passthrough doubles as the CLIError instance check.
    expect(thrown).toBeDefined();
    expect(toCLIError(thrown)).toBe(thrown);
    const cliErr = thrown as ThrownCLIError;
    expect(cliErr.code).toBe(code);
    expect(EXIT[cliErr.code]).toBe(exitCode);
    expect(cliErr.message).toBe(message);
  });
});
