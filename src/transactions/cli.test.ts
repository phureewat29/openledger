import { describe, it, expect } from "vitest";
import { MERGE_TRANSACTIONS_EXIT, RECATEGORIZE_EXIT } from "./cli.js";
import { failReason, type FailureCode } from "../cli/errors.js";
import { EXIT } from "../contract/exit.js";

interface ReasonTable {
  name: string;
  table: Record<string, FailureCode>;
  /** The exit code each reason's plain-Error message mapped to before it had a type. */
  pinned: Record<string, number>;
}

/** Pinned as data, not read off the tables: a re-pointed reason must fail here. */
const REASON_TABLES: ReasonTable[] = [
  {
    name: "MERGE_TRANSACTIONS_EXIT",
    table: MERGE_TRANSACTIONS_EXIT,
    pinned: {
      same_transaction: EXIT.INVALID,
      not_found: EXIT.NOT_FOUND,
      target_voided: EXIT.INVALID,
      not_mirrors: EXIT.INVALID,
    },
  },
  {
    name: "RECATEGORIZE_EXIT",
    table: RECATEGORIZE_EXIT,
    pinned: { same_account: EXIT.INVALID, not_found: EXIT.NOT_FOUND },
  },
];

describe.each(REASON_TABLES)("$name", ({ table, pinned }) => {
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
