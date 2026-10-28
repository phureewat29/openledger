import { describe, it, expect } from "vitest";
import { MERGE_MERCHANTS_EXIT } from "./cli.js";
import { failReason, type FailureCode } from "../cli/errors.js";
import { EXIT } from "../contract/exit.js";

const TABLE: Record<string, FailureCode> = MERGE_MERCHANTS_EXIT;

/** Pinned as data: the exit code each reason's plain-Error message mapped to before it had a type. */
const PINNED: Record<string, number> = { same_merchant: EXIT.INVALID, not_found: EXIT.NOT_FOUND };

describe("MERGE_MERCHANTS_EXIT", () => {
  it.each(Object.entries(PINNED))("%s exits %i", (reason, exitCode) => {
    let thrown: { code: keyof typeof EXIT } | undefined;
    try {
      failReason(TABLE, { reason, message: "refused" });
    } catch (err) {
      thrown = err as { code: keyof typeof EXIT };
    }
    expect(EXIT[thrown!.code]).toBe(exitCode);
  });

  it("assigns an exit code to every reason arm", () => {
    expect(Object.keys(TABLE).sort()).toEqual(Object.keys(PINNED).sort());
  });
});
