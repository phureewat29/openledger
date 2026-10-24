import { Command, Help, type CommanderError } from "commander";
import { minBy } from "es-toolkit";
import { TAGLINE, helpScreen } from "./format.js";
import { runAction } from "./output.js";
import { commandPath, fail } from "./errors.js";
import { levenshtein } from "../lib/distance.js";
import { getVersion } from "../lib/version.js";

import { registerStatus, showStatus } from "./commands/status.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerSetup } from "../setup/cli.js";
import { registerConfig } from "../config/cli.js";
import { registerIngest } from "../ingest/cli.js";
import { registerFiles } from "../files/cli.js";
import { registerTransactions } from "../transactions/cli.js";
import { registerAccounts } from "../accounts/cli.js";
import { registerMerchants } from "../merchants/cli.js";
import { registerQuestions } from "../questions/cli.js";
import { registerReport } from "./commands/report.js";
import { registerNotes } from "../notes/cli.js";
import { registerDatasets } from "../datasets/cli.js";
import { registerOpen } from "./commands/open.js";

const GLOBAL_OPTIONS: { name: string; desc: string; skipOn?: string }[] = [
  { name: "--json", desc: "Emit NDJSON (machine-readable) instead of human output" },
  { name: "--no-color", desc: "Disable ANSI color output" },
  // Kept off the config command's help screen, which teaches the positional; parsing resolves at the root either way.
  { name: "--config <path>", desc: "Config file to use (default ~/.oled/config.json)", skipOn: "config" },
];

// Navigation hints the overview screen adds; they would only be noise inside the command's own help.
const ROOT_HELP_HINTS = new Map([
  ["status", "(default)"],
  ["setup", "(--dir <path>)"],
]);

function rootHelpDesc(cmd: Command): string {
  const hint = ROOT_HELP_HINTS.get(cmd.name());
  return hint ? `${cmd.description()} ${hint}` : cmd.description();
}

/** Closest name among `commands` to `input`, within 2 edits and half of
 *  `input`'s length: loose enough for `account` to find `accounts`, tight
 *  enough that `bogus` finds nothing. */
export function nearestCommand(input: string, commands: readonly Command[]): string | null {
  const scored = commands
    .map((c) => ({ name: c.name(), dist: levenshtein(input, c.name()) }))
    .filter((s) => s.dist <= 2 && s.dist <= input.length / 2);
  return minBy(scored, (s) => s.dist)?.name ?? null;
}

// Candidates are `cmd`'s own subcommands; for the root, commandPath(cmd) is "oled".
function failUnknownCommand(cmd: Command, helpTail: string): never {
  const input = cmd.args[0];
  const match = nearestCommand(input, cmd.commands);
  const path = commandPath(cmd);
  const suggestion = match ? `try \`${path} ${match}\`, or ` : "";
  fail("USAGE", `unknown command '${input}'`, {
    hint: `${suggestion}run \`${path} --help\` ${helpTail}`,
  });
}

// Parse failures never reach runAction; map them onto the same error contract here.
function parseFailureHandler(cmd: Command, json: boolean): (err: CommanderError) => void {
  return (err) => {
    if (err.exitCode === 0) return;
    // commander already printed help for a bare noun; --json needs one error line instead.
    if (err.code === "commander.help") {
      if (!json) return;
      fail("USAGE", `${commandPath(cmd)} needs a subcommand`, {
        hint: `one of: ${cmd.commands.map((sub) => sub.name()).join(", ")}`,
      });
    }
    if (err.code === "commander.excessArguments" && !cmd.parent) {
      failUnknownCommand(cmd, "for the list of commands");
    }
    // A nested subcommand miss (e.g. `oled ingest comit`).
    if (err.code === "commander.unknownCommand") {
      failUnknownCommand(cmd, "for its flags and usage");
    }
    fail("USAGE", err.message.replace(/^error:\s*/, ""), {
      hint: `run \`${commandPath(cmd)} --help\` for its flags and usage`,
    });
  };
}

export function buildProgram(argv: readonly string[]): Command {
  // Parse failures and commander's own help output precede option binding; argv is all they have.
  const json = argv.includes("--json");
  const program = new Command();

  program
    .name("oled")
    .description(TAGLINE)
    .version(getVersion())
    .addHelpCommand(false)
    // Bare `oled` runs the same action as `status`, which redacts by default.
    .action(runAction(showStatus));

  // Registration order is the help screen's order.
  registerStatus(program);
  registerDoctor(program);
  registerSetup(program);
  registerConfig(program);
  registerIngest(program);
  registerFiles(program);
  registerTransactions(program);
  registerAccounts(program);
  registerMerchants(program);
  registerQuestions(program);
  registerReport(program);
  registerNotes(program);
  registerDatasets(program);
  registerOpen(program);

  // Repeated per command for each --help screen; value resolution happens at the root, which scans all of argv.
  // Runs after every register*: a command added later would lack the flags and the exit override.
  function configureEveryLevel(cmd: Command): void {
    for (const opt of GLOBAL_OPTIONS) {
      if (opt.skipOn !== cmd.name()) cmd.option(opt.name, opt.desc);
    }
    cmd
      // Commander's own suggestion embeds a newline that breaks the one-line
      // error contract; nearestCommand is the only suggester.
      .showSuggestionAfterError(false)
      .exitOverride(parseFailureHandler(cmd, json))
      // Under --json, the CLIError contract is the only thing allowed on stderr.
      .configureOutput({
        outputError: () => {},
        writeErr: (str) => {
          if (!json) process.stderr.write(str);
        },
      });
    for (const sub of cmd.commands) configureEveryLevel(sub);
  }
  configureEveryLevel(program);

  program.configureHelp({
    // configureHelp is inherited by subcommands, so guard explicitly: only the root gets the branded screen.
    formatHelp: (cmd, helper) =>
      cmd === program
        ? helpScreen(
            program.commands.map((c) => ({ name: c.name(), desc: rootHelpDesc(c) })),
            GLOBAL_OPTIONS,
          )
        : Help.prototype.formatHelp.call(helper, cmd, helper),
  });

  return program;
}
