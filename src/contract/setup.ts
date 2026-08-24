import * as z from "zod";
import type { CommandContract } from "./kind.js";

export const SetupInstalledTarget = z.object({
  path: z.string(),
  version: z.string(),
});
export type SetupInstalledTarget = z.infer<typeof SetupInstalledTarget>;

// `--print` dumps SKILL.md as raw markdown and never reaches this shape, even under --json.
export const SetupInstallResult = z.object({
  installed: z.array(SetupInstalledTarget),
});
export type SetupInstallResult = z.infer<typeof SetupInstallResult>;

export const SETUP_CONTRACTS = {
  setup: { lines: [SetupInstallResult] },
} as const satisfies Record<string, CommandContract>;
