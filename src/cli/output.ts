import type { Command } from "commander";
import { omit } from "es-toolkit";
import { renderPlain, renderTable, type Column } from "./format.js";
import { toCLIError } from "./errors.js";
import { EXIT, type ExitCode } from "../contract/exit.js";
import type { ErrorEnvelope } from "../contract/error.js";
import type { CappedSummary } from "../contract/primitives.js";

export interface OutputMode {
  json: boolean;
  tty: boolean;
  color: boolean;
  kind: "json" | "tty" | "plain";
}

export interface Output {
  readonly mode: OutputMode;
  /** No-op outside --json; a single result goes through emitObject() instead. */
  emit(obj: unknown): void;
  /** The terminal `{"type":"summary",...}` line of a streaming command. */
  emitSummary(fields: Record<string, unknown>): void;
  emitList<T>(rows: readonly T[], columns: Column<T>[]): void;
  /** Human output is tab-separated key/value lines, ANSI-free so it stays stable when piped. */
  emitObject(obj: Record<string, unknown>): void;
  write(text: string): void;
  render(byKind: Record<OutputMode["kind"], () => void>): void;
}

export interface Invocation {
  readonly out: Output;
  readonly configPath: string | undefined;
}

interface Globals {
  json: boolean;
  noColor: boolean;
  config: string | undefined;
}

// The root consumes these flags anywhere in argv, so every level but the root holds only defaults.
export function readGlobals(cmd: Command): Globals {
  const { json, color, config } = cmd.optsWithGlobals<{
    json?: boolean;
    color?: boolean;
    config?: string;
  }>();
  return { json: !!json, noColor: color === false, config };
}

function outputMode(
  { json, noColor }: Globals,
  { tty, noColorEnv }: { tty: boolean; noColorEnv: boolean },
): OutputMode {
  const color = !(json || noColor || noColorEnv || !tty);
  return { json, tty, color, kind: json ? "json" : tty ? "tty" : "plain" };
}

// libsql attaches `_metadata: { duration }` to every `.get()` row; stripped once here.
// `.all()` rows carry no `_metadata`, so nested arrays don't need it.
function stripMetadata<T>(value: T): T {
  if (value === null || typeof value !== "object" || !("_metadata" in value)) return value;
  return omit(value as Record<string, unknown>, ["_metadata"]) as T;
}

function plainValue(v: unknown): string {
  return v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function createOutput(mode: OutputMode, write: (chunk: string) => void): Output {
  const writeLine = (obj: unknown): void => write(JSON.stringify(stripMetadata(obj)) + "\n");
  const render = (byKind: Record<OutputMode["kind"], () => void>): void => byKind[mode.kind]();
  const emit = (obj: unknown): void => {
    if (mode.json) writeLine(obj);
  };
  return {
    mode,
    emit,
    emitSummary: (fields) => emit({ type: "summary", ...fields }),
    emitList: (rows, columns) =>
      render({
        json: () => {
          for (const row of rows) writeLine(row);
        },
        tty: () => write(renderTable(rows, columns, mode.color)),
        plain: () => write(renderPlain(rows, columns)),
      }),
    emitObject: (obj) => {
      const row = stripMetadata(obj);
      if (mode.json) {
        writeLine(row);
        return;
      }
      write(Object.entries(row).map(([k, v]) => `${k}\t${plainValue(v)}\n`).join(""));
    },
    write,
    render,
  };
}

/** The summary a capped list ends with; the fields a pager loops on. */
export function cappedSummary(
  total: number,
  returned: number,
  limit: number,
  offset: number,
): Omit<CappedSummary, "type"> {
  return { total, returned, has_more: offset + returned < total, limit, offset };
}

/** The stderr bytes a failure reports, and the exit code it maps to. */
export function describeFailure(
  err: unknown,
  json: boolean,
  cmd?: Command,
): { stderr: string; exitCode: number } {
  const cliErr = toCLIError(err, cmd);
  const exitCode = EXIT[cliErr.code];
  if (json) {
    const error: ErrorEnvelope["error"] = { code: `E_${cliErr.code}`, message: cliErr.message };
    if (cliErr.hint !== undefined) error.hint = cliErr.hint;
    if (cliErr.details !== undefined) error.details = cliErr.details;
    return { stderr: JSON.stringify({ error }) + "\n", exitCode };
  }
  const hint = cliErr.hint ? `hint: ${cliErr.hint}\n` : "";
  return { stderr: `error: ${cliErr.message}\n${hint}`, exitCode };
}

function reportError(err: unknown, json: boolean, cmd?: Command): number {
  const { stderr, exitCode } = describeFailure(err, json, cmd);
  process.stderr.write(stderr);
  return exitCode;
}

// A parse failure precedes option binding, so argv is the only `--json` signal left.
export function reportParseError(err: unknown, argv: readonly string[]): void {
  process.exitCode = reportError(err, argv.includes("--json"));
}

type Handler<A extends unknown[]> = (
  ctx: Invocation,
  ...args: A
) => Promise<ExitCode | void> | ExitCode | void;

// Sets process.exitCode rather than calling process.exit so buffered stdout/stderr flush before exit.
export function runAction<A extends unknown[]>(
  handler: Handler<A>,
): (...args: [...A, Command]) => Promise<void> {
  return async (...args) => {
    const cmd = args.at(-1) as Command;
    const globals = readGlobals(cmd);
    const mode = outputMode(globals, {
      tty: !!process.stdout.isTTY,
      noColorEnv: !!process.env.NO_COLOR,
    });
    const out = createOutput(mode, (chunk) => process.stdout.write(chunk));
    try {
      const exit = await handler({ out, configPath: globals.config }, ...(args.slice(0, -1) as A));
      if (exit) process.exitCode = EXIT[exit];
    } catch (err) {
      process.exitCode = reportError(err, mode.json, cmd);
    }
  };
}
