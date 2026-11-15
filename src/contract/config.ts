import * as z from "zod";
import type { CommandContract } from "./kind.js";

/** The shared base of every `oled config --json` line; `problem` or `created`
 *  distinguishes a read from a write. The one surface that answers camelCase. */
export const ConfigView = z.object({
  country: z.string(),
  displayLocale: z.string(),
  displayCurrency: z.string(),
  dbPath: z.string(),
  dataDir: z.string(),
  cacheDir: z.string(),
  userName: z.string(),
  config_path: z.string(),
  context_path: z.string(),
});
export type ConfigView = z.infer<typeof ConfigView>;

/** Bare `oled config --json`, or naming a file to read. */
export const ConfigShowResult = ConfigView.extend({
  // A broken file degrades to defaults; present only then, so its absence means "fine".
  problem: z.string().optional(),
});
export type ConfigShowResult = z.infer<typeof ConfigShowResult>;

/** `oled config --init` or any setting flag: the file was just written. */
export const ConfigConvergeResult = ConfigView.extend({
  created: z.object({
    config: z.string(),
    db: z.string(),
    data_dir: z.string(),
  }),
});
export type ConfigConvergeResult = z.infer<typeof ConfigConvergeResult>;

export const CONFIG_CONTRACTS = {
  config: { lines: [ConfigShowResult, ConfigConvergeResult] },
} as const satisfies Record<string, CommandContract>;
