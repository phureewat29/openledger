import { spawn } from "child_process";
import { mkdirSync } from "fs";
import type { Command } from "commander";
import { requireConfig } from "../../config/cli.js";
import { runAction, type Invocation } from "../output.js";
import type { OpenResult } from "../../contract/open.js";

const OPENERS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "open",
  win32: "explorer",
  linux: "xdg-open",
};

// Never rejects: resolves with an error message on spawn failure, else undefined.
function spawnOpener(cmd: string, dataDir: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, [dataDir], { stdio: "ignore", detached: true });
    child.once("error", (err: Error) => resolvePromise(err.message));
    child.once("spawn", () => resolvePromise(undefined));
    child.unref();
  });
}

// The path is reported even when the opener fails: it is still useful on its own.
async function openDataDir(ctx: Invocation): Promise<void> {
  const { dataDir } = requireConfig(ctx.configPath, ctx.roots);
  // 0700 like config --init creates it: the data dir holds the raw statements.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const cmd = OPENERS[process.platform];
  const spawnError = cmd
    ? await spawnOpener(cmd, dataDir)
    : `don't know how to open the file manager on ${process.platform}`;

  const { out } = ctx;
  out.render({
    json: () => {
      const result: OpenResult = { path: dataDir, ...(spawnError ? { spawn_error: spawnError } : {}) };
      out.emit(result);
    },
    tty: () => {
      out.write(out.paint.dim(`Data folder: ${dataDir}`) + "\n");
      if (spawnError) {
        const advice = `Couldn't open the folder automatically: ${spawnError}. Open it manually with the path above.`;
        out.write(out.paint.yellow(advice) + "\n");
      }
    },
    plain: () => out.write(dataDir + "\n"),
  });
}

export function registerOpen(program: Command): void {
  program
    .command("open")
    .description("Open the data folder in file explorer")
    .action(runAction(openDataDir));
}
