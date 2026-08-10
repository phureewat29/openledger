import { describe, expect, it } from "vitest";
import { buildProgram, nearestCommand } from "./program.js";

// buildProgram() only builds the commander tree: no argv parsing, no action run.
describe("nearestCommand", () => {
  it("finds a one-edit-away root command, e.g. the missing plural", () => {
    const program = buildProgram();
    expect(nearestCommand("account", program.commands)).toBe("accounts");
  });

  it("finds a one-edit-away subcommand among its parent's own commands", () => {
    const program = buildProgram();
    const ingest = program.commands.find((c) => c.name() === "ingest")!;
    expect(nearestCommand("comit", ingest.commands)).toBe("commit");
  });

  it("returns null for input with no close candidate", () => {
    const program = buildProgram();
    expect(nearestCommand("bogus", program.commands)).toBeNull();
  });

  it("returns null once the edit distance exceeds half the input's length", () => {
    // "ab" -> "cd" is 2 edits, within the flat cap of 2, but over half of "ab"'s
    // own length (1); the length-relative cap must still reject it.
    const commands = [{ name: () => "cd" }] as never;
    expect(nearestCommand("ab", commands)).toBeNull();
  });
});
