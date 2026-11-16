import { createRequire } from "module";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

/**
 * Compiles to dist/lib/version.js; ../../package.json is the package root from there (same depth as src/cli/index.ts).
 */
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { name: string; version: string };

/** Where the install lives; errors naming a bundled file are shown relative to this. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const INSTALL_COMMAND = `npm install -g ${pkg.name}`;

export function getVersion(): string {
  return pkg.version;
}
