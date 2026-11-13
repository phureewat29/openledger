import type { Command } from "commander";
import { ValidationError } from "../lib/validate.js";
import { err, errorMessage, ok, type Result } from "../lib/result.js";
import {
  ContextUnreadableError,
  DBBusyError,
  DBNotReadyError,
  isBusyError,
  isDamagedDBError,
  sqliteErrorCode,
} from "../db/errors.js";
import type { ExitCode } from "../contract/exit.js";

export type FailureCode = Exclude<ExitCode, "OK">;

/** Not exported: outside this module, fail() is the only construction site for CLIError. */
class CLIError extends Error {
  readonly code: FailureCode;
  readonly hint?: string;
  readonly details?: unknown;
  constructor(
    code: FailureCode,
    message: string,
    opts?: { hint?: string; details?: unknown },
  ) {
    super(message);
    this.name = "CLIError";
    this.code = code;
    this.hint = opts?.hint;
    this.details = opts?.details;
  }
}

export function fail(
  code: FailureCode,
  message: string,
  opts?: { hint?: string; details?: unknown },
): never {
  throw new CLIError(code, message, opts);
}

/** `oled ingest commit` for the `commit` sub-command of `ingest`. */
export function commandPath(cmd: Command): string {
  const names: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) names.unshift(c.name());
  return names.join(" ");
}

const BUSY_HINT = "another oled process is using the ledger; re-run the same command in a moment";

export function toCLIError(thrown: unknown, cmd?: Command): CLIError {
  if (thrown instanceof CLIError) return thrown;
  if (thrown instanceof ValidationError) {
    return new CLIError("USAGE", thrown.message, {
      hint: cmd
        ? `run \`${commandPath(cmd)} --help\` for its flags and usage`
        : "append --help to the command for its flags and usage",
    });
  }
  if (thrown instanceof DBNotReadyError) {
    return new CLIError("NOT_READY", thrown.message, {
      hint: "run `oled config --init` to configure the harness",
    });
  }
  if (thrown instanceof ContextUnreadableError) {
    // Bare `oled` runs status but takes no --no-redact of its own.
    const bypass = cmd && !cmd.parent ? "run `oled status --no-redact`" : "pass --no-redact";
    return new CLIError("NOT_READY", thrown.message, { hint: `fix the file, or ${bypass}` });
  }
  if (thrown instanceof DBBusyError) return new CLIError("BUSY", thrown.message, { hint: BUSY_HINT });
  // A lock lost past the open (a write that waited out its busy timeout) says the same thing.
  if (isBusyError(thrown)) {
    return new CLIError("BUSY", "The ledger is in use by another process.", { hint: BUSY_HINT });
  }
  // Page-body damage never reaches the open pragma; it surfaces at the query that reads the page.
  if (isDamagedDBError(thrown)) {
    return new CLIError(
      "NOT_READY",
      `The ledger file is damaged (${sqliteErrorCode(thrown)}): ${errorMessage(thrown)}`,
      { hint: "restore the newest `<db>.<stamp>.bak` beside it, or move the file aside and re-ingest" },
    );
  }
  return new CLIError("GENERIC", errorMessage(thrown));
}

/** Declare `table` as `Record<Reason, FailureCode>` so a reason nobody assigned a code fails the build. */
export function failReason<R extends string>(
  table: Record<R, FailureCode>,
  failure: { reason: NoInfer<R>; message: string },
  hint?: string,
): never {
  fail(table[failure.reason], failure.message, hint === undefined ? undefined : { hint });
}

/** Failures of the ledger itself, not of one item: every later item would hit them too. */
const LEDGER_FAILURES: FailureCode[] = ["BUSY", "NOT_READY"];

/**
 * A batch item's throw becomes that item's failure, except a ledger failure, which
 * propagates so the boundary exits BUSY or NOT_READY instead of PARTIAL.
 */
export function tryBatchItem<T>(fn: () => T): Result<T> {
  try {
    return ok(fn());
  } catch (thrown) {
    if (LEDGER_FAILURES.includes(toCLIError(thrown).code)) throw thrown;
    return err(errorMessage(thrown));
  }
}
