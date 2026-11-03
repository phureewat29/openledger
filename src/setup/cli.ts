import type { Command } from "commander";
import { homedir } from "os";
import { runAction, type Invocation } from "../cli/output.js";
import { fail } from "../cli/errors.js";
import { DEFAULT_SKILLS_DIR, installSkill, skillMd } from "./install.js";
import type { SetupInstallResult } from "../contract/setup.js";

interface SetupSkillOpts {
  global?: boolean;
  dir?: string;
  force?: boolean;
  print?: boolean;
}

function setupSkill(ctx: Invocation, opts: SetupSkillOpts): void {
  // --print dumps SKILL.md as raw markdown (not NDJSON) even when --json is set.
  if (opts.print) {
    const md = skillMd();
    ctx.out.write(md.endsWith("\n") ? md : md + "\n");
    return;
  }

  if (opts.global && opts.dir) {
    fail("USAGE", "--global and --dir are mutually exclusive", {
      hint: `pass --dir with the exact skills directory, or --global for ~/${DEFAULT_SKILLS_DIR}`,
    });
  }

  const installed = installSkill(opts, { cwd: process.cwd(), home: homedir() });
  if (!installed.ok) {
    fail("INVALID", installed.message, {
      hint: "re-run with --force to overwrite the installed skill pack",
      details: {
        installed_version: installed.installedVersion,
        cli_version: installed.cliVersion,
        path: installed.path,
      },
    });
  }

  if (ctx.out.mode.json) {
    const result: SetupInstallResult = {
      installed: [{ path: installed.path, version: installed.version }],
    };
    ctx.out.emit(result);
    return;
  }
  ctx.out.write(`${installed.path}\t${installed.version}\n`);
}

export function registerSetup(program: Command): void {
  program
    .command("setup")
    .description("Install the skill for an agent CLI")
    .option("--global", `install under ~/${DEFAULT_SKILLS_DIR} instead of the cwd`)
    .option("--dir <path>", "skills directory to install into; the pack lands at <path>/openledger")
    .option("--force", "overwrite an installed skill dir whose version differs")
    .option("--print", "print SKILL.md to stdout as raw markdown and exit (ignores --json)")
    .action(runAction(setupSkill));
}
