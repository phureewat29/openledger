import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { createAccount } from "../accounts/accounts.js";
import { upsertMerchant } from "../merchants/queries.js";
import {
  insertTransaction,
  insertLinkedTransactions,
  countTransactions,
  findTransactionById,
  voidTransactionAsMirror,
  type DuplicateTransactionRow,
  type TransactionInput,
} from "./queries.js";
import {
  autoMergeStrictDuplicateTransactions,
  bucketDuplicateCandidates,
  clusterDuplicateCandidates,
  dayDiff,
  findDuplicateTransactions,
  proximityComponents,
} from "./duplicates.js";
import { freshDB, onBegin, seedAccount } from "../../fixtures/db.js";

function seedAccountsAndFile(db: Database.Database): void {
  createAccount(db, { id: "thb:expense", name: "Expenses (THB)", type: "expense", parent_id: null });
  createAccount(db, { id: "thb:expense:food", name: "Food", type: "expense", parent_id: "thb:expense" });
  createAccount(db, { id: "thb:asset", name: "Assets (THB)", type: "asset", parent_id: null });
  createAccount(db, { id: "thb:asset:cash", name: "Cash", type: "asset", parent_id: "thb:asset" });
  createAccount(db, { id: "thb:equity", name: "Equity (THB)", type: "equity", parent_id: null });
  createAccount(db, {
    id: "thb:equity:adjustments",
    name: "Adjustments (THB)",
    type: "equity",
    parent_id: "thb:equity",
  });
  // Three statements: auto-merge only collapses mirrors reported by different files.
  for (const id of ["sf-1", "sf-2", "sf-3"]) {
    db.prepare(
      `INSERT INTO files (id, path, file_hash, mime, status)
       VALUES (?, ?, ?, 'application/pdf', 'ingested')`,
    ).run(id, `/${id}.pdf`, `hash-${id}`);
  }
}

function tf(over: Partial<TransactionInput>): TransactionInput {
  return {
    date: "2026-05-01",
    description: "Starbucks",
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    amount: 15000,
    source_file_id: "sf-1",
    ...over,
  };
}

describe("autoMergeStrictDuplicateTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDB(seedAccountsAndFile); });

  it("merges one purchase mirrored across statements: same merchant/date/amount, different files", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    for (const source_file_id of ["sf-1", "sf-2", "sf-3"]) {
      insertTransaction(db, tf({ merchant_id: merchant.id, source_file_id }));
    }
    expect(countTransactions(db)).toBe(3);
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 2 });
    expect(countTransactions(db)).toBe(1);
  });

  it("keeps the first-inserted twin as the survivor, whatever the ids sort to", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    insertTransaction(db, tf({ id: "tx:zzz", merchant_id: merchant.id, source_file_id: "sf-1" }));
    insertTransaction(db, tf({ id: "tx:aaa", merchant_id: merchant.id, source_file_id: "sf-2" }));

    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 1 });
    expect(findTransactionById(db, "tx:zzz")!.void_of).toBeNull();
    expect(findTransactionById(db, "tx:aaa")!.void_of).toBe("tx:zzz");
  });

  it("never merges two rows from one statement: a same-day repeat purchase is real money", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    for (let i = 0; i < 2; i++) {
      insertTransaction(db, tf({ merchant_id: merchant.id })); // both from sf-1
    }
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
    expect(countTransactions(db)).toBe(2);
  });

  it("refuses an unbalanced cluster rather than guess which row the mirror pairs with", () => {
    // sf-2 reports two real same-day purchases; sf-1 mirrors one of them. Which
    // one is unknowable here, and absorbing both into the head voids real money.
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    insertTransaction(db, tf({ id: "tx:aaa", merchant_id: merchant.id, source_file_id: "sf-1" }));
    insertTransaction(db, tf({ id: "tx:bbb", merchant_id: merchant.id, source_file_id: "sf-2" }));
    insertTransaction(db, tf({ id: "tx:ccc", merchant_id: merchant.id, source_file_id: "sf-2" }));

    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
    expect(countTransactions(db)).toBe(3);
    for (const id of ["tx:aaa", "tx:bbb", "tx:ccc"]) {
      expect(findTransactionById(db, id)!.void_of, id).toBeNull();
    }
  });

  it("merges the mirror even when a later same-file repeat rides in the same cluster", () => {
    // The ±2-day clustering pulls the 05-02 repeat in, but only the 05-01 rows
    // can pair with the head, and those two come from different statements.
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    insertTransaction(db, tf({ id: "tx:aaa", merchant_id: merchant.id, source_file_id: "sf-1" }));
    insertTransaction(db, tf({ id: "tx:bbb", merchant_id: merchant.id, source_file_id: "sf-2" }));
    insertTransaction(
      db,
      tf({ id: "tx:ccc", merchant_id: merchant.id, source_file_id: "sf-1", date: "2026-05-02" }),
    );

    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 1 });
    expect(findTransactionById(db, "tx:bbb")!.void_of).toBe("tx:aaa");
    expect(findTransactionById(db, "tx:ccc")!.void_of).toBeNull();
    expect(countTransactions(db)).toBe(2);
  });

  it("never merges a candidate carrying no source file: nothing says which statement it mirrors", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    insertTransaction(db, tf({ merchant_id: merchant.id }));
    insertTransaction(db, tf({ merchant_id: merchant.id, source_file_id: null }));
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
    expect(countTransactions(db)).toBe(2);
  });

  it("keeps distinct amounts untouched", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    for (const [amount, source_file_id] of [[15000, "sf-1"], [17500, "sf-2"]] as const) {
      insertTransaction(db, tf({ merchant_id: merchant.id, amount, source_file_id }));
    }
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
    expect(countTransactions(db)).toBe(2);
  });

  it("does not merge when the earliest row lacks a merchant or source file", () => {
    for (const source_file_id of ["sf-1", "sf-2"]) {
      insertTransaction(db, tf({ source_file_id })); // no merchant_id
    }
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
    expect(countTransactions(db)).toBe(2);
  });

  it("voids duplicates into the head instead of deleting them, so an existing void on a candidate survives", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    // A, B, C: three live identical rows, one per statement; B already has a
    // mirror M voided into it.
    const [a, b, c] = ["sf-1", "sf-2", "sf-3"].map(
      (source_file_id) => insertTransaction(db, tf({ merchant_id: merchant.id, source_file_id })).id,
    );
    const m = insertTransaction(db, tf({ merchant_id: merchant.id })).id;
    voidTransactionAsMirror(db, m, b);

    expect(countTransactions(db)).toBe(3); // a, b, c live; m already void
    expect(countTransactions(db, { includeVoid: true })).toBe(4);

    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 2 });

    // Only the earliest (by date/id sort) row is still live.
    expect(countTransactions(db)).toBe(1);
    expect(countTransactions(db, { includeVoid: true })).toBe(4); // nothing deleted

    // Nothing got un-voided: m still points at b; none of a/b/c came back to void_of === null.
    const head = [a, b, c].find((id) => findTransactionById(db, id)?.void_of === null)!;
    expect(head).toBeDefined();
    expect(findTransactionById(db, m)?.void_of).toBe(b);
    for (const id of [a, b, c]) {
      if (id === head) continue;
      expect(findTransactionById(db, id)?.void_of).toBe(head);
    }

    // Re-running finds nothing left to merge: the live set is down to one row.
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
  });

  it("reads candidates under its own lock: an edit that commits as it opens keeps a real purchase live", () => {
    const starbucks = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    const other = upsertMerchant(db, { canonical_name: "Other" }, []);
    insertTransaction(db, tf({ id: "tx:head", merchant_id: starbucks.id, source_file_id: "sf-1" }));
    insertTransaction(db, tf({ id: "tx:real", merchant_id: starbucks.id, source_file_id: "sf-2" }));
    const raced = onBegin(db, 1, () =>
      db.prepare(`UPDATE transactions SET merchant_id = ? WHERE id = 'tx:real'`).run(other.id),
    );

    expect(autoMergeStrictDuplicateTransactions(raced)).toEqual({ merged: 0 });
    expect(findTransactionById(db, "tx:real")!.void_of).toBeNull();
  });

  it("voids all of a run or none: a failure on a later void rolls back the earlier ones", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Starbucks" }, []);
    for (const [id, source_file_id] of [["tx:a", "sf-1"], ["tx:b", "sf-2"], ["tx:c", "sf-3"]]) {
      insertTransaction(db, tf({ id, merchant_id: merchant.id, source_file_id }));
    }
    db.exec(
      `CREATE TRIGGER fail_void BEFORE UPDATE OF void_of ON transactions WHEN NEW.id = 'tx:c'
       BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
    );

    expect(() => autoMergeStrictDuplicateTransactions(db)).toThrow("disk I/O error");
    expect(countTransactions(db)).toBe(3);
  });

  it("never merges repeat postings on an equity:adjustments account: those are corrections, not duplicated statement rows", () => {
    const merchant = upsertMerchant(db, { canonical_name: "Balance correction" }, []);
    // Different statements, so only the adjustments exclusion can hold them apart.
    for (const source_file_id of ["sf-1", "sf-2"]) {
      insertTransaction(
        db,
        tf({
          merchant_id: merchant.id,
          source_file_id,
          debit_account_id: "thb:equity:adjustments",
          credit_account_id: "thb:asset:cash",
        }),
      );
    }
    expect(countTransactions(db)).toBe(2);
    expect(autoMergeStrictDuplicateTransactions(db)).toEqual({ merged: 0 });
    expect(countTransactions(db)).toBe(2);
  });
});

function seedDedupAccounts(db: Database.Database): void {
  seedAccount(db, { id: "thb:asset:cash" });
  seedAccount(db, { id: "thb:asset:bank", name: "KBank Savings" });
  seedAccount(db, { id: "thb:expense:food" });
  seedAccount(db, { id: "thb:expense:transport" });
}

function dupTf(over: Partial<TransactionInput> = {}): TransactionInput {
  return {
    date: "2026-05-01",
    description: "Coffee",
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    amount: 15000,
    ...over,
  };
}

describe("findDuplicateTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDB(seedDedupAccounts); });

  it("detects cross-group duplicates but excludes intra-group members", () => {
    insertLinkedTransactions(
      db,
      [
        dupTf({ id: "tx:same1", debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 5000 }),
        dupTf({ id: "tx:same2", debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 5000 }),
      ],
      "tg:split",
    );
    insertTransaction(db, dupTf({ id: "tx:dup1", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 7000 }));
    insertTransaction(db, dupTf({ id: "tx:dup2", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 7000 }));

    const groups = findDuplicateTransactions(db);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id).sort()).toEqual(["tx:dup1", "tx:dup2"]);
  });

  it("excludes voided rows from candidates", () => {
    insertTransaction(db, dupTf({ id: "tx:dupA", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 7000 }));
    insertTransaction(db, dupTf({ id: "tx:dupB", debit_account_id: "thb:expense:transport", credit_account_id: "thb:asset:bank", amount: 7000 }));
    expect(findDuplicateTransactions(db)).toHaveLength(1);

    voidTransactionAsMirror(db, "tx:dupB", "tx:dupA");
    expect(findDuplicateTransactions(db)).toHaveLength(0);
  });

  it("orders same-day rows by insertion, not by their random ids", () => {
    for (const id of ["tx:zz", "tx:mm", "tx:aa"]) insertTransaction(db, dupTf({ id }));
    expect(findDuplicateTransactions(db).map((group) => group.map((r) => r.id))).toEqual([
      ["tx:zz", "tx:mm", "tx:aa"],
    ]);
  });

  it("numbers groups by their first-inserted row when they share a date", () => {
    insertTransaction(db, dupTf({ id: "tx:z1", amount: 7000 }));
    insertTransaction(db, dupTf({ id: "tx:a1", amount: 5000 }));
    insertTransaction(db, dupTf({ id: "tx:z2", amount: 7000 }));
    insertTransaction(db, dupTf({ id: "tx:a2", amount: 5000 }));
    expect(findDuplicateTransactions(db).map((group) => group.map((r) => r.id))).toEqual([
      ["tx:z1", "tx:z2"],
      ["tx:a1", "tx:a2"],
    ]);
  });
});

function row(over: Partial<DuplicateTransactionRow> & { id: string }): DuplicateTransactionRow {
  return {
    group_id: null,
    date: "2026-05-01",
    description: "Coffee",
    amount: 15000,
    currency: "THB",
    source_file_id: null,
    merchant_id: null,
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    debit_account_name: null,
    credit_account_name: null,
    ...over,
  };
}

describe("dayDiff", () => {
  it("is whole days regardless of direction", () => {
    expect(dayDiff("2026-05-01", "2026-05-03")).toBe(2);
    expect(dayDiff("2026-05-03", "2026-05-01")).toBe(2);
  });

  it("is +Infinity on an unparseable date", () => {
    expect(dayDiff("not-a-date", "2026-05-01")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("proximityComponents ordering", () => {
  it("returns components in first-appearance order, not union-root order", () => {
    // Row 0 unions with the last row, pushing its root to a high index while
    // the singletons keep low roots; first appearance must still come first.
    const twinA = row({ id: "tx:first", date: "2026-05-01" });
    const singles = ["2026-05-11", "2026-05-21", "2026-06-01", "2026-06-11"].map((date, i) =>
      row({ id: `tx:s${i}`, date }),
    );
    const twinB = row({ id: "tx:last", date: "2026-05-01" });

    const comps = proximityComponents([twinA, ...singles, twinB]);
    expect(comps).toHaveLength(5);
    expect(comps[0].map((r) => r.id)).toEqual(["tx:first", "tx:last"]);
  });
});

describe("bucketDuplicateCandidates", () => {
  it("groups only rows sharing amount, debit, and credit", () => {
    const a = row({ id: "tx:a", amount: 5000 });
    const b = row({ id: "tx:b", amount: 5000 });
    const differentAmount = row({ id: "tx:c", amount: 7000 });
    const differentAccounts = row({ id: "tx:d", amount: 5000, credit_account_id: "thb:asset:bank" });

    const buckets = bucketDuplicateCandidates([a, b, differentAmount, differentAccounts]);
    expect(buckets).toHaveLength(3);
    const withTwo = buckets.find((bucket) => bucket.length === 2);
    expect(withTwo?.map((r) => r.id).sort()).toEqual(["tx:a", "tx:b"]);
  });

  it("returns an empty bucket set for no rows", () => {
    expect(bucketDuplicateCandidates([])).toEqual([]);
  });
});

describe("proximityComponents", () => {
  it("keeps rows separate outside the tolerance window", () => {
    const a = row({ id: "tx:a", date: "2026-05-01" });
    const b = row({ id: "tx:b", date: "2026-05-05" });
    const components = proximityComponents([a, b]);
    expect(components).toHaveLength(2);
  });

  it("unions rows within the tolerance window", () => {
    const a = row({ id: "tx:a", date: "2026-05-01" });
    const b = row({ id: "tx:b", date: "2026-05-02" });
    const components = proximityComponents([a, b]);
    expect(components).toHaveLength(1);
    expect(components[0].map((r) => r.id).sort()).toEqual(["tx:a", "tx:b"]);
  });

  it("chains transitively: A~B, B~C puts all three in one component even though A!~C", () => {
    const a = row({ id: "tx:a", date: "2026-05-01" });
    const b = row({ id: "tx:b", date: "2026-05-03" });
    const c = row({ id: "tx:c", date: "2026-05-05" });
    // dayDiff(a,c) = 4, outside TOLERANCE_DAYS (2), so only the a-b and b-c edges union directly.
    expect(dayDiff(a.date, c.date)).toBeGreaterThan(2);

    const components = proximityComponents([a, b, c]);
    expect(components).toHaveLength(1);
    expect(components[0].map((r) => r.id).sort()).toEqual(["tx:a", "tx:b", "tx:c"]);
  });

  it("never unions rows sharing a non-null group_id", () => {
    const a = row({ id: "tx:a", date: "2026-05-01", group_id: "tg:1" });
    const b = row({ id: "tx:b", date: "2026-05-01", group_id: "tg:1" });
    const components = proximityComponents([a, b]);
    expect(components).toHaveLength(2);
  });
});

describe("clusterDuplicateCandidates", () => {
  it("drops components of size 1", () => {
    const a = row({ id: "tx:a", amount: 5000 });
    expect(clusterDuplicateCandidates([a])).toEqual([]);
  });

  it("composes bucketing and proximity clustering into >=2 groups", () => {
    const a = row({ id: "tx:a", amount: 7000, date: "2026-05-01" });
    const b = row({ id: "tx:b", amount: 7000, date: "2026-05-02" });
    const lone = row({ id: "tx:c", amount: 9000, date: "2026-05-01" });

    const groups = clusterDuplicateCandidates([a, b, lone]);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id).sort()).toEqual(["tx:a", "tx:b"]);
  });
});
