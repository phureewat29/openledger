import { Command, Help, type CommanderError } from "commander";
import { minBy } from "es-toolkit";
import { helpScreen } from "./format.js";
import { jsonRequested, runAction } from "./output.js";
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

const GLOBAL_OPTIONS = [
  { name: "--json", desc: "Emit NDJSON (machine-readable) instead of human output" },
  { name: "--no-color", desc: "Disable ANSI color output" },
  { name: "--config <path>", desc: "Config file to use (default ~/.oled/config.json)" },
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

// Parse failures never reach runAction; map them onto the same error contract here.
function parseFailureHandler(cmd: Command): (err: CommanderError) => void {
  return (err) => {
    if (err.exitCode === 0) return;
    // commander already printed help for a bare noun; --json needs one error line instead.
    if (err.code === "commander.help") {
      if (!jsonRequested()) return;
      fail("USAGE", `${commandPath(cmd)} needs a subcommand`, {
        hint: `one of: ${cmd.commands.map((sub) => sub.name()).join(", ")}`,
      });
    }
    if (err.code === "commander.excessArguments" && !cmd.parent) {
      const input = cmd.args[0];
      const match = nearestCommand(input, cmd.commands);
      const suggestion = match ? `try \`oled ${match}\`, or ` : "";
      fail("USAGE", `unknown command '${input}'`, {
        hint: `${suggestion}run \`oled --help\` for the list of commands`,
      });
    }
    // A nested subcommand miss (e.g. `oled ingest comit`); candidates are the parent's own subcommands.
    if (err.code === "commander.unknownCommand") {
      const input = cmd.args[0];
      const match = nearestCommand(input, cmd.commands);
      const path = commandPath(cmd);
      const suggestion = match ? `try \`${path} ${match}\`, or ` : "";
      fail("USAGE", `unknown command '${input}'`, {
        hint: `${suggestion}run \`${path} --help\` for its flags and usage`,
      });
    }
    fail("USAGE", err.message.replace(/^error:\s*/, ""), {
      hint: `run \`${commandPath(cmd)} --help\` for its flags and usage`,
    });
  };
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("oled")
    .description("A reliable, deterministic ledger for your AI")
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
  function configureEveryLevel(cmd: Command): void {
    cmd
      .option("--json", "Emit NDJSON (machine-readable) instead of human output")
      .option("--no-color", "Disable ANSI color output");
    // Kept off the config command's help screen, which teaches the positional; parsing resolves at the root either way.
    if (cmd.name() !== "config") {
      cmd.option("--config <path>", "Config file to use (default ~/.oled/config.json)");
    }
    cmd
      // Commander's own suggestion embeds a newline that breaks the one-line
      // error contract; nearestCommand is the only suggester.
      .showSuggestionAfterError(false)
      .exitOverride(parseFailureHandler(cmd))
      // Under --json, the CLIError contract is the only thing allowed on stderr.
      .configureOutput({
        outputError: () => {},
        writeErr: (str) => {
          if (!jsonRequested()) process.stderr.write(str);
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
