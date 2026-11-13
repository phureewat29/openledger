import { readFileSync } from "node:fs";
import { decodeUserText } from "../lib/text.js";
import { tryExecute } from "../lib/result.js";
import { fail } from "./errors.js";

export function requireYes(opts: { yes?: boolean }, what: string): void {
  if (!opts.yes) {
    fail("INPUT_REQUIRED", `${what} needs confirmation`, {
      hint: "re-run with --yes to proceed",
    });
  }
}

/**
 * Redaction is on unless --no-redact set opts.redact === false; it's undefined for a
 * direct call, so `!!opts.redact` reads backwards.
 */
export function redactionEnabled(opts: { redact?: boolean }): boolean {
  return opts.redact !== false;
}

/** Empty string when stdin is a TTY (no pipe). */
async function readStdinToEnd(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return decodeUserText(Buffer.concat(chunks));
}

function readInputFile(inputPath: string): string {
  const read = tryExecute(() => decodeUserText(readFileSync(inputPath)));
  if (!read.ok) {
    fail("NOT_FOUND", `cannot read --input file: ${read.error}`, {
      hint: "pass a readable NDJSON (or JSON array) file path",
    });
  }
  return read.value;
}

/** Auto-detects a JSON array (leading `[`) vs NDJSON; row validation is the caller's job. */
export async function readStdinBatch(inputPath?: string): Promise<unknown[]> {
  const from = inputPath ?? "stdin";
  const source = inputPath ? readInputFile(inputPath) : await readStdinToEnd();
  const firstNonWs = source.match(/\S/);
  if (!firstNonWs) {
    fail("USAGE", `${from}: no rows`, {
      hint: "pass NDJSON rows via --input <file> or pipe them on stdin",
    });
  }

  if (firstNonWs[0] === "[") {
    const parsed = tryExecute(() => JSON.parse(source) as unknown[]);
    if (!parsed.ok) fail("USAGE", `${from}: invalid JSON array: ${parsed.error}`);
    return parsed.value;
  }

  return source.split(/\r?\n/).flatMap((raw, index) => {
    const line = raw.trim();
    if (!line) return [];
    const parsed = tryExecute((): unknown => JSON.parse(line));
    if (!parsed.ok) {
      fail("USAGE", `${from}: invalid JSON on line ${index + 1}: ${parsed.error}`, {
        details: { line: index + 1 },
      });
    }
    return [parsed.value];
  });
}
