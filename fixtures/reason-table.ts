import { describe, it, expect } from "vitest";
import { failReason, type FailureCode } from "../src/cli/errors.js";
import { EXIT } from "../src/contract/exit.js";

/**
 * `pinned` is the exit code each reason must reach, written as data rather than
 * read off `table`, so re-pointing a reason fails here.
 */
export function describeReasonTable(
  name: string,
  table: Record<string, FailureCode>,
  pinned: Record<string, number>,
): void {
  describe(name, () => {
    it.each(Object.entries(pinned))("%s exits %i", (reason, exitCode) => {
      let thrown: { code: keyof typeof EXIT } | undefined;
      try {
        failReason(table, { reason, message: "refused" });
      } catch (err) {
        thrown = err as { code: keyof typeof EXIT };
      }
      expect(EXIT[thrown!.code]).toBe(exitCode);
    });

    it("assigns an exit code to every reason arm", () => {
      expect(Object.keys(table).sort()).toEqual(Object.keys(pinned).sort());
    });
  });
}
