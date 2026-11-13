import { createRequire } from "module";

/**
 * Compiles to dist/lib/version.js; ../../package.json is the package root from there (same depth as src/cli/index.ts).
 */
const require = createRequire(import.meta.url);

export function getVersion(): string {
  const { version } = require("../../package.json") as { version: string };
  return version;
}
