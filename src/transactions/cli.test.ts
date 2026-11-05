import { describe, it, expect } from "vitest";
import { MERGE_TRANSACTIONS_EXIT, RECATEGORIZE_EXIT, clusterByGroup } from "./cli.js";
import { failReason, type FailureCode } from "../cli/errors.js";
import { EXIT } from "../contract/exit.js";
import type { TransactionView } from "../contract/transactions.js";

function view(id: string, group_id: string | null): TransactionView {
  return {
    id,
    group_id,
    date: "2026-05-01",
    description: "Coffee",
    merchant_id: null,
    raw_descriptor: null,
    source_file_id: null,
    source_page: null,
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    amount: 150,
    currency: "THB",
    void_of: null,
    created_at: "2026-05-01T00:00:00.000Z",
    debit_account_name: null,
    credit_account_name: null,
    merchant_name: null,
  };
}

describe("clusterByGroup", () => {
  const clusterIds = (rows: TransactionView[]) =>
    clusterByGroup(rows).map((c) => [c.group_id, c.transactions.map((t) => t.id)]);

  it("folds a group's rows into one cluster and keeps each ungrouped row its own", () => {
    const rows = [view("tx:1", null), view("tx:g1", "tg:a"), view("tx:2", null), view("tx:g2", "tg:a")];
    expect(clusterIds(rows)).toEqual([
      [null, ["tx:1"]],
      ["tg:a", ["tx:g1", "tx:g2"]],
      [null, ["tx:2"]],
    ]);
  });

  it("orders clusters by first appearance, even for integer-like group ids", () => {
    const rows = [view("tx:a", "20"), view("tx:b", "3"), view("tx:c", "20")];
    expect(clusterIds(rows)).toEqual([
      ["20", ["tx:a", "tx:c"]],
      ["3", ["tx:b"]],
    ]);
  });

  it("never folds an ungrouped row into a group whose id equals its own", () => {
    const rows = [view("tx:x", null), view("tx:y", "tx:x")];
    expect(clusterIds(rows)).toEqual([
      [null, ["tx:x"]],
      ["tx:x", ["tx:y"]],
    ]);
  });
});

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
