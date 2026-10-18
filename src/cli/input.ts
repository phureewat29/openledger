import { readFileSync } from "node:fs";
import { decodeUserText } from "../lib/text.js";
import { errorMessage } from "../lib/result.js";
import { fail } from "./errors.js";

export function requireYes(opts: { yes?: boolean }, what: string): void {
  if (!opts.yes) {
    fail("INPUT_REQUIRED", `${what} needs confirmation`, {
      hint: "re-run with --yes to proceed",
    });
  }
}

// Redaction is on unless --no-redact set opts.redact === false; it's undefined for a
// direct call, so `!!opts.redact` reads backwards.
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

// Auto-detects a JSON array (leading `[`) vs NDJSON; row validation is the caller's job.
export async function readStdinBatch(inputPath?: string): Promise<unknown[]> {
  const from = inputPath ?? "stdin";
  let source: string;
  if (inputPath) {
    try {
      source = decodeUserText(readFileSync(inputPath));
    } catch (err) {
      fail("NOT_FOUND", `cannot read --input file: ${errorMessage(err)}`, {
        hint: "pass a readable NDJSON (or JSON array) file path",
      });
    }
  } else {
    source = await readStdinToEnd();
  }
  const firstNonWs = source.match(/\S/);
  if (!firstNonWs)
    fail("USAGE", `${from}: no rows`, {
      hint: "pass NDJSON rows via --input <file> or pipe them on stdin",
    });

  if (firstNonWs[0] === "[") {
    try {
      return JSON.parse(source) as unknown[];
    } catch (err) {
      fail("USAGE", `${from}: invalid JSON array: ${errorMessage(err)}`);
    }
  }

  const out: unknown[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      fail("USAGE", `${from}: invalid JSON on line ${i + 1}: ${errorMessage(err)}`, {
        details: { line: i + 1 },
      });
    }
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
