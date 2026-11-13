#!/usr/bin/env node
import { buildProgram } from "./program.js";
import { reportParseError } from "./output.js";

/** Windows can report the closed reader as EOF rather than EPIPE. */
const CLOSED_PIPE_CODES = new Set(["EPIPE", "EOF"]);

/** Exit quietly when a downstream pipe closes early (e.g. `oled transactions list --json | head`). */
const exitOnEpipe = (err: NodeJS.ErrnoException): void => {
  if (CLOSED_PIPE_CODES.has(err.code ?? "")) process.exit(0);
  throw err;
};
process.stdout.on("error", exitOnEpipe);
process.stderr.on("error", exitOnEpipe);

const argv = process.argv;

// runAction reports action failures; only commander's parse errors reach here.
try {
  buildProgram(argv).parse(argv);
} catch (err) {
  reportParseError(err, argv);
}
