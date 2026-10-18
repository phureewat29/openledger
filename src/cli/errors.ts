import type { Command } from "commander";
import { ValidationError } from "../lib/validate.js";
import { errorMessage } from "../lib/result.js";
import { DBBusyError, DBNotReadyError, isBusyError, sqliteErrorCode } from "../db/errors.js";
import type { AccountFailure } from "../accounts/accounts.js";
import type { ExitCode } from "../contract/exit.js";

// Not exported: outside this module, fail() is the only construction site for CLIError.
class CLIError extends Error {
  readonly code: ExitCode;
  readonly hint?: string;
  readonly details?: unknown;
  constructor(
    code: ExitCode,
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
  code: ExitCode,
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

// Page-body damage never reaches the open pragma; it surfaces at the query that reads the page.
const DAMAGED_DB_CODES = ["SQLITE_CORRUPT", "SQLITE_NOTADB"];

export function toCLIError(err: unknown, cmd?: Command): CLIError {
  if (err instanceof CLIError) return err;
  if (err instanceof ValidationError) {
    return new CLIError("USAGE", err.message, {
      hint: cmd
        ? `run \`${commandPath(cmd)} --help\` for its flags and usage`
        : "append --help to the command for its flags and usage",
    });
  }
  if (err instanceof DBNotReadyError) {
    return new CLIError("NOT_READY", err.message, {
      hint: "run `oled config --init` to configure the harness",
    });
  }
  if (err instanceof DBBusyError) return new CLIError("BUSY", err.message, { hint: BUSY_HINT });
  // A lock lost past the open (a write that waited out its busy timeout) says the same thing.
  if (isBusyError(err)) {
    return new CLIError("BUSY", "The ledger is in use by another process.", { hint: BUSY_HINT });
  }
  const sqliteCode = sqliteErrorCode(err);
  if (DAMAGED_DB_CODES.includes(sqliteCode)) {
    return new CLIError(
      "NOT_READY",
      `The ledger file is damaged (${sqliteCode}): ${errorMessage(err)}`,
      { hint: "restore the newest `<db>.<stamp>.bak` beside it, or move the file aside and re-ingest" },
    );
  }
  return new CLIError("GENERIC", errorMessage(err));
}

// Record<Union, ExitCode> fails the build if a reason case is unhandled.
export const REASON_EXIT: Record<AccountFailure, ExitCode> = {
  account_exists: "INVALID",
  parent_not_found: "NOT_FOUND",
  invalid_hierarchy: "INVALID",
};

export function failReason(
  failure: { reason: AccountFailure; message: string },
  hint?: string,
): never {
  fail(REASON_EXIT[failure.reason], failure.message, hint === undefined ? undefined : { hint });
}

// Matches error message text, for throw sites that use a plain `Error` instead of a typed reason.
export function mapNotFoundError(err: unknown): never {
  const message = errorMessage(err);
  if (/not found|does not exist/i.test(message)) {
    fail("NOT_FOUND", message);
  }
  fail("INVALID", message);
}
