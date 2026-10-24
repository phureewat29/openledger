import { describe, it, expect } from "vitest";
import type { Command } from "commander";
import { buildProgram } from "../cli/program.js";
import { COMMAND_CONTRACTS } from "./commands.js";

/**
 * A command cannot merge without declaring its wire shape in `COMMAND_CONTRACTS`,
 * and a deleted command must drop its entry. This test enforces both directions
 * against the real commander tree, the same `buildProgram([])` entry
 * `src/cli/consistency.test.ts` walks.
 */

function leafPaths(cmd: Command): string[] {
  if (cmd.commands.length === 0) return [cmd.name()];
  return cmd.commands.flatMap((sub) => leafPaths(sub).map((path) => `${cmd.name()} ${path}`));
}

function programLeafPaths(program: Command): string[] {
  return program.commands.flatMap((cmd) => leafPaths(cmd));
}

describe("COMMAND_CONTRACTS covers exactly the real command tree", () => {
  it("every leaf command has an entry, and every entry names a real leaf command", () => {
    const fromProgram = new Set(programLeafPaths(buildProgram([])));
    const fromContracts = new Set(Object.keys(COMMAND_CONTRACTS));

    const missing = [...fromProgram].filter((path) => !fromContracts.has(path));
    const extra = [...fromContracts].filter((path) => !fromProgram.has(path));

    expect(missing, `commands missing a COMMAND_CONTRACTS entry: ${missing.join(", ")}`).toEqual([]);
    expect(extra, `COMMAND_CONTRACTS entries for commands that no longer exist: ${extra.join(", ")}`).toEqual([]);
  });
});
