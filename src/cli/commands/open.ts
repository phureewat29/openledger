import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
import chalk from "chalk";
import type { Command } from "commander";
import { requireConfig } from "../../config/cli.js";
import { runAction, type Invocation } from "../output.js";
import type { OpenResult } from "../../contract/open.js";

const OPENERS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "open",
  win32: "explorer",
  linux: "xdg-open",
};

function openerCommand(): string | null {
  return OPENERS[process.platform] ?? null;
}

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
  const dataDir = resolve(requireConfig(ctx.configPath).dataDir);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const cmd = openerCommand();
  const spawnError = cmd
    ? await spawnOpener(cmd, dataDir)
    : `don't know how to open the file manager on ${process.platform}`;

  ctx.out.render({
    json: () => {
      const result: OpenResult = { path: dataDir };
      if (spawnError) result.spawn_error = spawnError;
      ctx.out.emit(result);
    },
    tty: () => {
      ctx.out.write(chalk.dim(`Data folder: ${dataDir}`) + "\n");
      if (spawnError) {
        const advice = `Couldn't open the folder automatically: ${spawnError}. Open it manually with the path above.`;
        ctx.out.write(chalk.yellow(advice) + "\n");
      }
    },
    plain: () => ctx.out.write(dataDir + "\n"),
  });
}

export function registerOpen(program: Command): void {
  program
    .command("open")
    .description("Open the data folder in file explorer")
    .action(runAction(openDataDir));
}
