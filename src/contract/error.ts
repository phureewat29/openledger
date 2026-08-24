import * as z from "zod";
import { EXIT, type ExitCode } from "./exit.js";

function isErrorCode(name: ExitCode): name is Exclude<ExitCode, "OK"> {
  return name !== "OK";
}

/**
 * Derived from EXIT so the two can't drift: every non-OK name, `E_`-prefixed.
 * OK is excluded because it never reaches the envelope: the CLI only writes
 * `{error:...}` to stderr on a non-zero exit.
 */
const ERROR_CODES = (Object.keys(EXIT) as ExitCode[])
  .filter(isErrorCode)
  .map((name) => `E_${name}` as const);

/** The one-line stderr error every non-zero `--json` exit writes. */
export const ErrorEnvelope = z.object({
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    hint: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelope>;
