import { spawnSync } from "node:child_process";
import { chmodSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const TSC = join(dirname(require.resolve("typescript/package.json")), require("typescript/package.json").bin.tsc);
const BIN = join(ROOT, "dist", "cli", "index.js");

/** tsc's JS entry on this node: a bare `tsc` is tsc.cmd on Windows, which spawns only through a shell. */
function tsc(...args) {
  const { status } = spawnSync(process.execPath, [TSC, ...args], { cwd: ROOT, stdio: "inherit" });
  if (status !== 0) process.exit(status ?? 1);
}

rmSync(join(ROOT, "dist"), { recursive: true, force: true, maxRetries: 3 });
tsc();
tsc("-p", "tsconfig.contract.json");
// Windows has no exec bit: npm's .cmd shim starts the bin there.
if (process.platform !== "win32") chmodSync(BIN, statSync(BIN).mode | 0o111);
