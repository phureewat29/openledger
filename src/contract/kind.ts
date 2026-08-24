import * as z from "zod";

/** The shape every `COMMAND_CONTRACTS` entry and per-noun fragment satisfies. */
export interface CommandContract {
  lines: readonly z.ZodType[];
  summary?: "plain" | "capped";
}
