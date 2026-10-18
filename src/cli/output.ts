import chalk from "chalk";
import { omit } from "es-toolkit";
import { Command } from "commander";
import { visibleLength, ANSI_RE } from "./format.js";
import { toCLIError } from "./errors.js";
import { EXIT, type ExitCode } from "../contract/exit.js";

export { EXIT };
export type { ExitCode };

export interface OutputMode {
  /** --json was set anywhere in the command chain. */
  json: boolean;
  tty: boolean;
  color: boolean;
  kind: "json" | "tty" | "plain";
}

function deriveKind(json: boolean, tty: boolean): OutputMode["kind"] {
  return json ? "json" : tty ? "tty" : "plain";
}

// Defensive walk: commander binds a global flag's value on the root, not the
// subcommand that declared it, but nothing in its API guarantees that.
function resolveMode(cmd?: Command): OutputMode {
  let json = false;
  let noColorFlag = false;
  let c: Command | undefined = cmd;
  while (c) {
    const o = c.opts();
    if (o.json) json = true;
    if (o.color === false) noColorFlag = true;
    c = c.parent ?? undefined;
  }
  const tty = !!process.stdout.isTTY;
  const envNoColor = !!process.env.NO_COLOR;
  const noColor = json || noColorFlag || envNoColor || !tty;
  return { json, tty, color: !noColor, kind: deriveKind(json, tty) };
}

let current: OutputMode | null = null;

function getOutputMode(cmd?: Command): OutputMode {
  current = resolveMode(cmd);
  return current;
}

export function currentMode(): OutputMode {
  if (!current) current = resolveMode(undefined);
  return current;
}

// libsql attaches `_metadata: { duration }` to every `.get()` row; stripped once here.
// `.all()` rows carry no `_metadata`, so nested arrays don't need it.
function stripMetadata<T>(value: T): T {
  if (value === null || typeof value !== "object" || !("_metadata" in value)) return value;
  return omit(value as Record<string, unknown>, ["_metadata"]) as T;
}

function writeLine(stream: NodeJS.WriteStream, obj: unknown): void {
  stream.write(JSON.stringify(stripMetadata(obj)) + "\n");
}

/** emit()/emitSummary() no-op outside --json; use emitObject() for a single result instead. */
export function emit(obj: unknown): void {
  if (currentMode().json) writeLine(process.stdout, obj);
}

/** Terminal `{"type":"summary",...}` for a streaming command. */
export function emitSummary(fields: Record<string, unknown> = {}): void {
  if (currentMode().json) writeLine(process.stdout, { type: "summary", ...fields });
}

/** The summary a capped list ends with; the fields a pager loops on. */
export function emitCappedSummary(
  total: number,
  returned: number,
  limit: number,
  offset: number,
): void {
  emitSummary({ total, returned, has_more: offset + returned < total, limit, offset });
}

export interface Column<T = unknown> {
  header: string;
  value: (row: T) => string;
  align?: "left" | "right";
}

export function renderByMode(handlers: Record<OutputMode["kind"], () => void>): void {
  handlers[currentMode().kind]();
}

export function emitList<T>(rows: T[], columns: Column<T>[]): void {
  const m = currentMode();
  renderByMode({
    json: () => {
      for (const row of rows) writeLine(process.stdout, row);
    },
    tty: () => renderTable(rows, columns, m.color),
    plain: () => renderPlain(rows, columns),
  });
}

/** Human/plain output is tab-separated key/value lines, ANSI-free so it stays stable when piped. */
export function emitObject(obj: Record<string, unknown>): void {
  const row = stripMetadata(obj);
  if (currentMode().json) {
    emit(row);
    return;
  }
  for (const [k, v] of Object.entries(row)) {
    const s = v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
    process.stdout.write(`${k}\t${s}\n`);
  }
}

function renderPlain<T>(rows: T[], columns: Column<T>[]): void {
  const lines = rows.map((row) =>
    columns.map((c) => c.value(row).replace(ANSI_RE, "")).join("\t"),
  );
  if (lines.length) process.stdout.write(lines.join("\n") + "\n");
}

function renderTable<T>(rows: T[], columns: Column<T>[], color: boolean): void {
  const cells = rows.map((row) => columns.map((c) => c.value(row)));
  const widths = columns.map((c, i) =>
    Math.max(visibleLength(c.header), ...cells.map((r) => visibleLength(r[i]))),
  );
  const pad = (s: string, width: number, align: Column<T>["align"]): string => {
    const gap = " ".repeat(Math.max(0, width - visibleLength(s)));
    return align === "right" ? gap + s : s + gap;
  };
  const header = columns
    .map((c, i) => pad(color ? chalk.bold(c.header) : c.header, widths[i], c.align))
    .join("  ")
    .trimEnd();
  const out = [header];
  for (const r of cells) {
    out.push(columns.map((c, i) => pad(r[i], widths[i], c.align)).join("  ").trimEnd());
  }
  process.stdout.write(out.join("\n") + "\n");
}

function reportError(err: unknown, cmd?: Command): number {
  const cliErr = toCLIError(err, cmd);
  if (currentMode().json) {
    const payload: Record<string, unknown> = {
      code: `E_${cliErr.code}`,
      message: cliErr.message,
    };
    if (cliErr.hint !== undefined) payload.hint = cliErr.hint;
    if (cliErr.details !== undefined) payload.details = cliErr.details;
    process.stderr.write(JSON.stringify({ error: payload }) + "\n");
  } else {
    process.stderr.write(`error: ${cliErr.message}\n`);
    if (cliErr.hint) process.stderr.write(`hint: ${cliErr.hint}\n`);
  }
  return EXIT[cliErr.code];
}

// Commander aborts at parse before any action runs, so `--json` may still be unparsed here; argv is the only signal left.
export function jsonRequested(): boolean {
  return process.argv.includes("--json");
}

export function reportParseError(err: unknown): void {
  const json = jsonRequested();
  const tty = !!process.stdout.isTTY;
  current = { json, tty, color: false, kind: deriveKind(json, tty) };
  process.exitCode = reportError(err);
}

// Sets process.exitCode rather than calling process.exit so buffered stdout/stderr flush before exit.
export function runAction<A extends unknown[]>(
  fn: (...args: A) => unknown | Promise<unknown>,
): (...args: A) => Promise<void> {
  return async (...args: A): Promise<void> => {
    const last = args[args.length - 1];
    const cmd = last instanceof Command ? last : undefined;
    getOutputMode(cmd);
    try {
      await fn(...args);
    } catch (err) {
      process.exitCode = reportError(err, cmd);
    }
  };
}
