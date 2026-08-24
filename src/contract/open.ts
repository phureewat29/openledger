import * as z from "zod";
import type { CommandContract } from "./kind.js";

export const OpenResult = z.object({
  path: z.string(),
  // Present only when the platform opener failed (or none is known); the path is still useful alone.
  spawn_error: z.string().optional(),
});
export type OpenResult = z.infer<typeof OpenResult>;

export const OPEN_CONTRACTS = {
  open: { lines: [OpenResult] },
} as const satisfies Record<string, CommandContract>;
