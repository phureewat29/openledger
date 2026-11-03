import chalk from "chalk";
import { isPlainObject } from "es-toolkit";
import { EXIT, type ExitCode } from "../contract/exit.js";

// eslint-disable-next-line no-control-regex
export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export const TAGLINE = "A reliable, deterministic ledger for your AI";

export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}

export interface Column<T = unknown> {
  header: string;
  value: (row: T) => string;
  align?: "left" | "right";
}

/** One tab-separated line per row, ANSI-free so piped output stays stable; empty for no rows. */
export function renderPlain<T>(rows: readonly T[], columns: Column<T>[]): string {
  const lines = rows.map((row) =>
    columns.map((c) => c.value(row).replace(ANSI_RE, "")).join("\t"),
  );
  return lines.length ? lines.join("\n") + "\n" : "";
}

export function renderTable<T>(rows: readonly T[], columns: Column<T>[], color: boolean): string {
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
  const body = cells.map((r) =>
    columns.map((c, i) => pad(r[i], widths[i], c.align)).join("  ").trimEnd(),
  );
  return [header, ...body].join("\n") + "\n";
}

/** One `key.nested` row per entry of a one-level nested record, in insertion order. */
export function flattenRows(obj: Record<string, unknown>): [string, string][] {
  return Object.entries(obj).flatMap(([key, value]): [string, string][] =>
    isPlainObject(value)
      ? Object.entries(value).map(([nested, v]): [string, string] => [`${key}.${nested}`, String(v)])
      : [[key, String(value)]],
  );
}

// Human output only (TTY: aligned two-column, piped: tab-separated); the caller owns --json.
export function formatKeyValues(
  rows: [string, string | number][],
  opts: { tty: boolean; bold?: boolean },
): string {
  if (!opts.tty) return rows.map(([k, v]) => `${k}\t${v}`).join("\n") + "\n";
  const width = Math.max(...rows.map(([k]) => k.length));
  // Pads before applying bold, so the ANSI codes don't count toward the width.
  return rows
    .map(([k, v]) => `${opts.bold ? chalk.bold(k.padEnd(width)) : k.padEnd(width)}  ${v}\n`)
    .join("");
}

export function banner(): string {
  return chalk.bold("OpenLedger") + chalk.dim(`  ·  ${TAGLINE}`);
}

const DISCLAIMER =
  "OpenLedger is a tool, it only summarizes financial statements: verify amounts against your statements before relying on them.";

const SCENARIO = [
  "Place financial statements in a folder; your AI posts each row to a local ledger.",
  "Ask for net worth, spending, subscriptions, or debt payoff. Answers always come from the ledger.",
  "Every entry is double-entry and data stays safely on your machine.",
];

const EXIT_LABELS: Record<ExitCode, string> = {
  OK: "ok",
  GENERIC: "error",
  USAGE: "usage",
  NOT_READY: "not ready",
  INPUT_REQUIRED: "input required",
  NOT_FOUND: "not found",
  INVALID: "invalid",
  PARTIAL: "partial",
  BUSY: "busy",
};

const EXIT_LINE = (Object.keys(EXIT) as ExitCode[])
  .map((name) => `${EXIT[name]} ${EXIT_LABELS[name]}`)
  .join(" · ");

const CONTRACT = [
  `Exit codes: ${EXIT_LINE}.`,
  'Under --json every stdout line is one JSON object, and list reads end with a {"type":"summary"} row.',
  "Errors are one stderr JSON object with a hint; read output masks PII as [USER]/[CARD], masks are not data.",
];

function section(label: string, lines: string[]): string {
  return [chalk.bold.yellow(label), ...lines.map((l) => `  ${l}`)].join("\n");
}

export function helpScreen(
  commands: { name: string; desc: string }[],
  globalOptions: { name: string; desc: string }[],
): string {
  const options: { name: string; desc: string }[] = [
    ...globalOptions,
    { name: "--version", desc: "Show the version and exit" },
    { name: "--help", desc: "Show this help screen" },
  ];
  const nameWidth = Math.max(
    ...commands.map((c) => c.name.length),
    ...options.map((o) => o.name.length),
  );
  const row = (name: string, desc: string) =>
    `${chalk.cyan(name.padEnd(nameWidth))}    ${chalk.dim(desc)}`;

  return [
    "",
    banner(),
    "",
    section("About", SCENARIO),
    "",
    section("Usage", [row("oled", "<command> [OPTIONS]")]),
    "",
    section("Commands", commands.map((c) => row(c.name, c.desc))),
    "",
    section("Options", options.map((o) => row(o.name, o.desc))),
    "",
    section("Contract", CONTRACT),
    "",
    chalk.dim(DISCLAIMER),
    "",
  ].join("\n");
}
