import { describe, it, expect, beforeEach } from "vitest";
import Database from "libsql";
import { countAccounts, findAccountById, ledgerExists } from "../accounts/queries.js";
import { createAccount, mergeAccounts } from "../accounts/accounts.js";
import { getAccountBalances } from "../accounts/balances.js";
import { bulkRecategorize, countTransactions, findTransactionById } from "../transactions/queries.js";
import { findMerchantByName, upsertMerchant } from "../merchants/queries.js";
import { deriveTransactionId, deriveGroupId } from "../lib/ids.js";
import { listQuestions, countQuestions, closeQuestion, deferQuestion } from "../questions/queries.js";
import {
  commitTransaction,
  commitLinkedTransactions,
  type TransactionCommitContext,
  type RawTransactionInput,
} from "./commit.js";
import { noiseTokens } from "../datasets/datasets.js";
import { failingAccountInsert, failingStatement, freshDB } from "../../fixtures/db.js";

function seedAccountsAndFile(db: Database.Database): void {
  db.prepare(
    `INSERT INTO files (id, path, file_hash, mime, status) VALUES ('sf-1','/f.pdf','hashABC','application/pdf','ingested')`,
  ).run();
  createAccount(db, { id: "thb:asset", name: "Assets (THB)", type: "asset", parent_id: null });
  createAccount(db, { id: "thb:asset:cash", name: "Cash", type: "asset", parent_id: "thb:asset" });
  createAccount(db, { id: "thb:asset:bank", name: "KBank Savings", type: "asset", parent_id: "thb:asset" });
  createAccount(db, { id: "thb:income", name: "Income (THB)", type: "income", parent_id: null });
  createAccount(db, { id: "thb:income:salary", name: "Salary", type: "income", parent_id: "thb:income" });
  createAccount(db, { id: "thb:expense", name: "Expenses (THB)", type: "expense", parent_id: null });
  createAccount(db, { id: "thb:expense:food", name: "Food", type: "expense", parent_id: "thb:expense" });
  createAccount(db, { id: "thb:expense:tax", name: "Tax", type: "expense", parent_id: "thb:expense" });
  createAccount(db, {
    id: "thb:expense:tax:withholding",
    name: "Withholding",
    type: "expense",
    parent_id: "thb:expense:tax",
  });
  createAccount(db, {
    id: "thb:expense:socialsecurity",
    name: "Social Security",
    type: "expense",
    parent_id: "thb:expense",
  });
}

const CTX: TransactionCommitContext = {
  batchId: "ib:1",
  fileId: "sf-1",
  fileHash: "hashABC",
  noise: noiseTokens("TH"),
};

function raw(over: Partial<RawTransactionInput> = {}): RawTransactionInput {
  return {
    date: "2026-05-01",
    description: "Coffee",
    debit_account_id: "thb:expense:food",
    credit_account_id: "thb:asset:cash",
    amount: 135.0,
    currency: "THB",
    row_index: 0,
    source_page: 1,
    ...over,
  };
}

describe("commitTransaction", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDB(seedAccountsAndFile); });

  it("happy path: converts decimal to minor units, derives id, raises no questions", () => {
    const out = commitTransaction(db, CTX, raw());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.duplicate).toBe(false);
    expect(out.raisedQuestions).toBe(0);
    expect(out.transactionId).toBe(deriveTransactionId("hashABC", 1, 0));

    const row = findTransactionById(db, out.transactionId)!;
    expect(row.amount).toBe(13500); // 135.00 THB -> minor units
    expect(row.debit_account_id).toBe("thb:expense:food");
    expect(countQuestions(db)).toBe(0);

    expect(out.sides).toEqual([
      { side: "debit", requested: "thb:expense:food", resolved: "thb:expense:food", how: "exact" },
      { side: "credit", requested: "thb:asset:cash", resolved: "thb:asset:cash", how: "exact" },
    ]);
    expect(out.merchant).toEqual({ how: "none" });
  });

  it("auto-creates a well-formed placeholder silently: no question raised for it", () => {
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "thb:expense:subscriptions:news", row_index: 1 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(0);
    expect(countQuestions(db)).toBe(0);

    const row = findTransactionById(db, out.transactionId)!;
    expect(row.debit_account_id).toBe("thb:expense:subscriptions:news");
    expect(findAccountById(db, "thb:expense:subscriptions:news")).toBeTruthy();
    expect(countTransactions(db)).toBe(1);

    expect(out.sides[0]).toEqual({
      side: "debit",
      requested: "thb:expense:subscriptions:news",
      resolved: "thb:expense:subscriptions:news",
      how: "placeholder_created",
    });
  });

  it("a broken write stops the row: nothing is booked to uncategorized", () => {
    // A broken write must propagate, not be read as an unresolvable id booked to uncategorized.
    const broken = failingAccountInsert(db, "thb:expense:subscriptions");
    expect(() =>
      commitTransaction(
        broken,
        CTX,
        raw({ debit_account_id: "thb:expense:subscriptions:news", row_index: 30 }),
      ),
    ).toThrow(/disk I\/O/);

    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:uncategorized")).toBeNull();
    expect(countQuestions(db)).toBe(0);
  });

  it("is one transaction: a throw after the insert leaves none of the row behind", () => {
    // The uncategorized question is the row's last write; failing it must also undo the
    // placeholder account and the transaction written before it.
    const broken = failingStatement(db, "INSERT INTO questions");
    expect(() =>
      commitTransaction(
        broken,
        CTX,
        raw({ debit_account_id: "thb:expense:uncategorized", row_index: 31 }),
      ),
    ).toThrow(/disk I\/O/);

    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:uncategorized")).toBeNull();
  });

  it("is one transaction for a compound row too: a later leg's throw undoes the earlier legs", () => {
    const broken = failingStatement(db, "INSERT INTO questions");
    expect(() =>
      commitLinkedTransactions(
        broken,
        CTX,
        { date: "2026-05-01", description: "Split", row_index: 32, source_page: 1 },
        [
          { debit_account_id: "thb:expense:food", credit_account_id: "thb:asset:cash", amount: 10 },
          { debit_account_id: "thb:expense:uncategorized", credit_account_id: "thb:asset:cash", amount: 5 },
        ],
      ),
    ).toThrow(/disk I\/O/);

    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:uncategorized")).toBeNull();
  });

  it("raises an uncategorized question when a leaf-only hint falls back to expense:uncategorized", () => {
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "mysterycharge", row_index: 1 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(1);

    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    expect(qs[0].transaction_id).toBe(out.transactionId);
    expect(qs[0].kind).toBe("uncategorized");
    const ctx = JSON.parse(qs[0].context_json!);
    expect(ctx.side).toBe("debit");
    expect(ctx.placeholder_id).toBe("thb:expense:uncategorized");
    expect(findTransactionById(db, out.transactionId)!.debit_account_id).toBe("thb:expense:uncategorized");
    expect(countTransactions(db)).toBe(1);

    // The side reports where the money landed, not the hint that failed.
    expect(out.sides).toEqual([
      {
        side: "debit",
        requested: "mysterycharge",
        resolved: "thb:expense:uncategorized",
        how: "uncategorized_fallback",
      },
      { side: "credit", requested: "thb:asset:cash", resolved: "thb:asset:cash", how: "exact" },
    ]);
  });

  it("asks when a row requests uncategorized outright, whether or not that account exists yet", () => {
    // The first row creates the account, which would otherwise report as a
    // placeholder and ask nothing; parking a row here is never the quiet path.
    expect(findAccountById(db, "thb:expense:uncategorized")).toBeNull();

    for (const rowIndex of [40, 41]) {
      const out = commitTransaction(
        db,
        CTX,
        raw({ debit_account_id: "thb:expense:uncategorized", row_index: rowIndex }),
      );
      expect(out.ok, `row ${rowIndex}`).toBe(true);
      if (!out.ok) return;
      expect(out.raisedQuestions, `row ${rowIndex}`).toBe(1);
      // `exact` is the truth about where it landed; the question carries the doubt.
      expect(out.sides[0]).toEqual({
        side: "debit",
        requested: "thb:expense:uncategorized",
        resolved: "thb:expense:uncategorized",
        how: "exact",
      });
    }

    const asked = listQuestions(db).filter((q) => q.kind === "uncategorized");
    expect(asked).toHaveLength(2);
    expect(asked[0].prompt).toContain("asked for");
  });

  it("an unprefixed hint has no currency head, so it falls back into the other side's ledger and raises uncategorized", () => {
    // "expense:food" names no ledger, so the other side (thb:asset:cash) supplies the fallback ledger.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "expense:food", row_index: 20 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(1);
    expect(findTransactionById(db, out.transactionId)!.debit_account_id).toBe("thb:expense:uncategorized");
    expect(listQuestions(db).find((q) => q.kind === "uncategorized")).toBeTruthy();
  });

  it("refuses a side whose currency head names no existing ledger, and posts nothing", () => {
    // No eur ledger exists; booking into thb would re-label EUR as THB at 1:1, so the row is refused.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "eur:expense:food", row_index: 21 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(out.message).toBe(
      'debit eur:expense:food names ledger "eur", which does not exist here; ' +
        "open it with `oled accounts create`, or fix the currency prefix",
    );
    expect(out.raisedQuestions).toBe(1);
    expect(countTransactions(db)).toBe(0);
    expect(ledgerExists(db, "eur")).toBe(false);
  });

  it("refuses the credit side the same way, leaving the good side's placeholder unbuilt", () => {
    const before = countAccounts(db);
    const out = commitTransaction(
      db,
      CTX,
      raw({
        // Buildable inside thb, but the refusal comes first, so it stays unbuilt.
        debit_account_id: "thb:asset:kbank",
        credit_account_id: "usd:income:salary",
        // The stated currency is discarded either way; the accounts decide.
        currency: "USD",
        row_index: 22,
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(out.message).toContain('credit usd:income:salary names ledger "usd"');
    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:asset:kbank")).toBeNull();
    expect(countAccounts(db)).toBe(before);
    expect(ledgerExists(db, "usd")).toBe(false);

    const q = listQuestions(db).find((x) => x.kind === "currency_mismatch")!;
    expect(q.transaction_id).toBeNull();
    // The account it names cannot exist, or the ledger would.
    expect(q.account_id).toBeNull();
    expect(q.prompt).toContain(
      "`oled accounts create --id usd:income:salary --name <name> --type income`",
    );
    expect(JSON.parse(q.context_json!)).toMatchObject({
      side: "credit",
      account_id: "usd:income:salary",
      ledger: "usd",
    });
  });

  it("refuses a mistyped currency head too: nothing tells it from a ledger not opened yet", () => {
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "thn:expense:food", row_index: 23 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.message).toContain('names ledger "thn"');
    expect(countTransactions(db)).toBe(0);
    expect(ledgerExists(db, "thn")).toBe(false);
  });

  it("the currency head alone is the claim: a malformed tail does not cancel it", () => {
    const out = commitTransaction(db, CTX, raw({ debit_account_id: "usd:food", row_index: 24 }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(out.message).toContain('names ledger "usd"');
    expect(countTransactions(db)).toBe(0);
    // The id names no creatable account, so the question says fix-the-id, not create.
    const q = listQuestions(db).find((x) => x.kind === "currency_mismatch")!;
    expect(q.prompt).not.toContain("accounts create");
    expect(q.prompt).toContain("fix the id");
  });

  it("refuses an uppercase currency head as dirty input, naming the id", () => {
    // The id grammar is lowercase-only, so an uppercase head names no ledger and
    // no account. Read as neither, "THB:expense:food" would fall into the OTHER
    // side's ledger and be re-labelled at that currency's exponent.
    const before = countAccounts(db);
    for (const [rowIndex, id] of [[25, "USD:expense:food"], [27, "THB:expense:food"]] as const) {
      const out = commitTransaction(db, CTX, raw({ debit_account_id: id, row_index: rowIndex }));
      expect(out.ok, id).toBe(false);
      if (out.ok) return;
      expect(out.reason, id).toBe("dirty_input");
      expect(out.message).toBe(
        `debit ${id} carries an uppercase currency head; account ids are lowercase, ` +
          `e.g. ${id.toLowerCase()}`,
      );
    }

    expect(countTransactions(db)).toBe(0);
    expect(countAccounts(db)).toBe(before);
    expect(ledgerExists(db, "usd")).toBe(false);
    expect(findAccountById(db, "thb:expense:uncategorized")).toBeNull();
  });

  it("a malformed tail on the OWN ledger's head still falls back, not refuses", () => {
    const out = commitTransaction(db, CTX, raw({ debit_account_id: "thb:food", row_index: 26 }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const committed = findTransactionById(db, out.transactionId)!;
    expect(committed.debit_account_id).toBe("thb:expense:uncategorized");
    expect(out.sides[0]).toMatchObject({ requested: "thb:food", how: "uncategorized_fallback" });
  });

  it("refuses a caller-supplied id outside the tx: namespace", () => {
    // Derived tx: ids make re-ingest idempotent; row_index null means this id is used verbatim.
    const out = commitTransaction(db, CTX, raw({ id: "acct:thb", row_index: null }));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(out.message).toBe('id must start with "tx:".');
    expect(countTransactions(db)).toBe(0);
  });

  it("refuses a malformed row in the shared wording, not a second copy of it", () => {
    // Shared rules live in validateTransactionFields; this path only adds the
    // decimal amount and tx: namespace.
    const messages = [
      raw({ description: "  ", row_index: 30 }),
      raw({ date: "2026/05/01", row_index: 31 }),
      raw({ credit_account_id: "thb:expense:food", row_index: 32 }),
      raw({ amount: 0, row_index: 33 }),
    ].map((input) => {
      const out = commitTransaction(db, CTX, input);
      return out.ok ? "committed" : out.message;
    });

    expect(messages).toEqual([
      "description must not be empty.",
      "date must be an ISO date (YYYY-MM-DD).",
      "debit and credit accounts must differ.",
      "amount must be a positive number.",
    ]);
    expect(countTransactions(db)).toBe(0);
  });

  it("refuses an amount no currency's minor units could hold, before resolution writes anything", () => {
    // 1e30 satang is past 2^53-1; decided among the pure input rules, before
    // resolution could build a placeholder tree.
    const out = commitTransaction(
      db,
      CTX,
      raw({ amount: 1e30, debit_account_id: "thb:expense:brandnewxyz", row_index: 40 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(out.message).toBe("amount is too large to hold in any currency's minor units.");
    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:brandnewxyz")).toBeNull();
  });

  it("posts to the requested account and raises similar_accounts for the lookalike", () => {
    // Leaf "fod" is one edit from "Food"; reported as a possible duplicate, but
    // the money stays where the input named.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "thb:expense:fod", row_index: 3 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(1);
    expect(findTransactionById(db, out.transactionId)!.debit_account_id).toBe("thb:expense:fod");

    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    expect(qs[0].kind).toBe("similar_accounts");
    // Anchored on the lookalike so the recommended merge cannot cascade it away.
    expect(qs[0].account_id).toBe("thb:expense:food");
    expect(JSON.parse(qs[0].context_json!)).toMatchObject({
      created_id: "thb:expense:fod",
      similar_id: "thb:expense:food",
      side: "debit",
    });

    // similar_to rides along, never the destination; serialized here because
    // callers emit these keys verbatim as NDJSON.
    expect(JSON.stringify(out.sides[0])).toBe(
      '{"side":"debit","requested":"thb:expense:fod","resolved":"thb:expense:fod",' +
        '"how":"similar_account","similar_to":"thb:expense:food"}',
    );
    expect(out.sides[1]).toEqual({
      side: "credit",
      requested: "thb:asset:cash",
      resolved: "thb:asset:cash",
      how: "exact",
    });
  });

  it("the similar_accounts question survives its own remedy and still answers", () => {
    const out = commitTransaction(db, CTX, raw({ debit_account_id: "thb:expense:fod", row_index: 8 }));
    expect(out.ok).toBe(true);

    // Merging the created account into the lookalike must not also kill the
    // question anchored on the survivor.
    mergeAccounts(db, "thb:expense:fod", "thb:expense:food");

    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    const closed = closeQuestion(db, qs[0].id, "merged");
    expect(closed?.rule_key).toBe("account-pair:thb:expense:fod|thb:expense:food");
  });

  it("flags a stated currency the accounts overrule, and stays quiet when they agree", () => {
    // Accounts derive THB; the row claims USD; accounts win and the override is reported.
    const overridden = commitTransaction(db, CTX, raw({ currency: "USD", row_index: 10 }));
    expect(overridden.ok).toBe(true);
    if (!overridden.ok) return;
    expect(overridden.currencyOverridden).toBe(true);
    expect(findTransactionById(db, overridden.transactionId)!.currency).toBe("THB");

    const agreeing = commitTransaction(db, CTX, raw({ currency: "THB", row_index: 11 }));
    expect(agreeing.ok).toBe(true);
    if (!agreeing.ok) return;
    expect(agreeing.currencyOverridden).toBe(false);
  });

  it("raises one similar_accounts question per side when both sides have lookalikes", () => {
    // "fod" pairs with Food; "cash 1" pairs with Cash, a sibling, not a lineage relation.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "thb:expense:fod", credit_account_id: "thb:asset:cash-1", row_index: 9 }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.raisedQuestions).toBe(2);

    const row = findTransactionById(db, out.transactionId)!;
    expect(row.debit_account_id).toBe("thb:expense:fod");
    expect(row.credit_account_id).toBe("thb:asset:cash-1");

    const anchors = listQuestions(db).map((q) => q.account_id).sort();
    expect(anchors).toEqual(["thb:asset:cash", "thb:expense:food"]);
  });

  it("drops a cross-currency transaction and raises currency_mismatch (no insert)", () => {
    // A real, pre-existing usd ledger, not just a usd-shaped hint, so both
    // sides name a DIFFERENT EXISTING ledger.
    createAccount(db, { id: "usd:asset", name: "Assets (USD)", type: "asset", parent_id: null });
    createAccount(db, { id: "usd:asset:wallet", name: "USD Wallet", type: "asset", parent_id: "usd:asset" });
    const out = commitTransaction(
      db,
      CTX,
      raw({
        debit_account_id: "usd:asset:wallet",
        credit_account_id: "thb:asset:cash",
        currency: "USD",
        row_index: 5,
      }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(countTransactions(db)).toBe(0);

    const cm = listQuestions(db).find((q) => q.kind === "currency_mismatch")!;
    expect(cm).toBeTruthy();
    expect(cm.transaction_id).toBeNull();
  });

  it("is idempotent: a re-commit is a duplicate reporting the row as committed", () => {
    const input = raw({ row_index: 9 });
    const a = commitTransaction(db, CTX, input);
    expect(a.ok && !a.duplicate).toBe(true);

    // thb:expense:food still exists, so re-resolving would wrongly report "exact".
    bulkRecategorize(db, { accountId: "thb:expense:food" }, { accountId: "thb:expense:tax" });

    const b = commitTransaction(db, CTX, input);
    expect(b.ok && b.duplicate).toBe(true);
    if (!b.ok) return;
    expect(b.raisedQuestions).toBe(0);
    expect(b.sides).toEqual([
      {
        side: "debit",
        requested: "thb:expense:food",
        resolved: "thb:expense:tax",
        how: "as_committed",
      },
      {
        side: "credit",
        requested: "thb:asset:cash",
        resolved: "thb:asset:cash",
        how: "as_committed",
      },
    ]);
    expect(b.merchant).toEqual({ how: "none" });
    expect(countTransactions(db)).toBe(1);
  });

  it("reports the merchant a row linked, and asks about one that resolves to nothing", () => {
    const known = upsertMerchant(db, { canonical_name: "Pet Paradise" }, []);

    const linked = commitTransaction(db, CTX, raw({ merchant_id: known.id, row_index: 12 }));
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.merchant).toEqual({ how: "linked", merchant_id: known.id });
    expect(linked.raisedQuestions).toBe(0);

    // The upsert form only earns its id at insert, so the report reads it back.
    const upserted = commitTransaction(
      db,
      CTX,
      raw({ merchant: { canonical_name: "Corner Cafe" }, row_index: 13 }),
    );
    expect(upserted.ok).toBe(true);
    if (!upserted.ok) return;
    expect(upserted.merchant).toEqual({
      how: "linked",
      merchant_id: findTransactionById(db, upserted.transactionId)!.merchant_id,
    });

    const unknown = commitTransaction(db, CTX, raw({ merchant_id: "m:nope", row_index: 14 }));
    expect(unknown.ok).toBe(true);
    if (!unknown.ok) return;
    expect(unknown.merchant).toEqual({ how: "unknown" });
    expect(unknown.raisedQuestions).toBe(1);
    expect(findTransactionById(db, unknown.transactionId)!.merchant_id).toBeNull();
  });

  it("reports what the row linked, not the id that missed, when it carries both", () => {
    // The inline merchant is upserted and linked, so "unknown" would be a lie
    // about the stored row; the question about the missed id is still asked.
    const out = commitTransaction(
      db,
      CTX,
      raw({
        merchant_id: "m:nope",
        merchant: { canonical_name: "Corner Cafe" },
        row_index: 15,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const stored = findTransactionById(db, out.transactionId)!.merchant_id;
    expect(stored).toBeTruthy();
    expect(out.merchant).toEqual({ how: "linked", merchant_id: stored });
    expect(out.raisedQuestions).toBe(1);
    expect(listQuestions(db).map((q) => q.kind)).toEqual(["unknown_merchant"]);
  });

  it("no-ops every question raise when batchId is null", () => {
    // With no batchId, raise() no-ops, so the fallback commits without persisting a question.
    const out = commitTransaction(
      db,
      { ...CTX, batchId: null },
      raw({ debit_account_id: "mysterycharge", row_index: 2 }),
    );
    expect(out.ok).toBe(true);
    expect(countQuestions(db, { includeDeferred: true })).toBe(0);
  });

  it("a cross-type lookalike raises nothing: the asset path is created beside the liability card", () => {
    // Existing account whose name shares the "ttb" token with the debit hint below.
    createAccount(db, { id: "thb:liability", name: "Liabilities (THB)", type: "liability", parent_id: null });
    createAccount(db, {
      id: "thb:liability:credit_card",
      name: "Credit Cards",
      type: "liability",
      parent_id: "thb:liability",
    });
    createAccount(db, {
      id: "thb:liability:credit_card:ttb",
      name: "TTB Credit Card",
      type: "liability",
      parent_id: "thb:liability:credit_card",
    });

    const out = commitTransaction(
      db,
      CTX,
      raw({
        debit_account_id: "thb:asset:bank:ttb",
        credit_account_id: "thb:liability:credit_card:ttb",
        row_index: 6,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const row = findTransactionById(db, out.transactionId)!;
    expect(row.debit_account_id).toBe("thb:asset:bank:ttb");
    expect(row.credit_account_id).toBe("thb:liability:credit_card:ttb");

    // Different type, so not a lookalike; the well-formed asset path is created silently.
    expect(out.raisedQuestions).toBe(0);
    expect(listQuestions(db)).toHaveLength(0);
    expect(findAccountById(db, "thb:asset:bank:ttb")).toBeTruthy();
  });

  it("dirty_input when neither side resolves to any ledger", () => {
    // Neither carries a currency head, so resolution fails outright rather
    // than falling both to uncategorized.
    const out = commitTransaction(
      db,
      CTX,
      raw({ debit_account_id: "bogus", credit_account_id: "alsobogus", row_index: 7 }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(countTransactions(db)).toBe(0);
  });
});

describe("commitLinkedTransactions", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDB(seedAccountsAndFile); });

  it("commits the salary example atomically with a shared group and gross income", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "May salary", row_index: 0, source_page: 2 },
      [
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 50000 },
        { debit_account_id: "thb:expense:tax:withholding", credit_account_id: "thb:income:salary", amount: 8000 },
        { debit_account_id: "thb:expense:socialsecurity", credit_account_id: "thb:income:salary", amount: 2000 },
      ],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results).toHaveLength(3);
    expect(out.group_id).toBe(deriveGroupId("hashABC", 2, 0));
    expect(out.currencyOverridden).toBe(false);
    expect(out.merchant).toEqual({ how: "none" });
    expect(countTransactions(db)).toBe(3);

    // thb:income:salary is credited by all three legs: 60000 THB gross.
    const salary = getAccountBalances(db).find((b) => b.id === "thb:income:salary")!;
    expect(salary.credits_posted).toBe(6_000_000); // minor units
    expect(salary.balance).toBe(60000); // decimal, credit-normal

    for (const r of out.results) {
      expect(findTransactionById(db, r.id)?.group_id).toBe(out.group_id);
    }
  });

  it("a refused later leg leaves the earlier legs' placeholder trees unbuilt", () => {
    const before = countAccounts(db);
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "Split with a bad leg", row_index: 9, source_page: 2 },
      [
        // Leg 0 would build thb:expense:coffee:beans as a placeholder tree.
        { debit_account_id: "thb:expense:coffee:beans", credit_account_id: "thb:asset:bank", amount: 300 },
        { debit_account_id: "eur:expense:coffee", credit_account_id: "thb:asset:bank", amount: 100 },
      ],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("currency_mismatch");
    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:coffee:beans")).toBeNull();
    expect(findAccountById(db, "thb:expense:coffee")).toBeNull();
    expect(countAccounts(db)).toBe(before);
  });

  it("a later leg naming no ledger at all is refused before the earlier leg builds anything", () => {
    // Placeability is decided in the pure pre-scan, not after leg 0's tree is written.
    const before = countAccounts(db);
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "Split with an unplaceable leg", row_index: 10, source_page: 2 },
      [
        { debit_account_id: "thb:expense:coffee:beans", credit_account_id: "thb:asset:bank", amount: 300 },
        { debit_account_id: "bogus", credit_account_id: "alsobogus", amount: 100 },
      ],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:coffee:beans")).toBeNull();
    expect(findAccountById(db, "thb:expense:coffee")).toBeNull();
    expect(countAccounts(db)).toBe(before);
  });

  it("a later leg that would fall onto the account its other side names is refused the same way", () => {
    // "grooming" falls back to thb:expense:uncategorized, which the credit side
    // already names: one account on both legs. Refused before anything is written.
    const before = countAccounts(db);
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "Split onto one account", row_index: 11, source_page: 2 },
      [
        { debit_account_id: "thb:expense:coffee:beans", credit_account_id: "thb:asset:bank", amount: 300 },
        { debit_account_id: "grooming", credit_account_id: "thb:expense:uncategorized", amount: 100 },
      ],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(out.message).toContain("debit and credit accounts must differ.");
    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:coffee:beans")).toBeNull();
    expect(findAccountById(db, "thb:expense:uncategorized")).toBeNull();
    expect(countAccounts(db)).toBe(before);
  });

  it("a later leg under the currency's smallest unit is refused before the earlier leg builds anything", () => {
    // 0.004 THB rounds to 0 satang, which only validateTransaction used to
    // catch, after leg 0 and leg 1 had both written their placeholder trees.
    const before = countAccounts(db);
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "Split with a sub-satang leg", row_index: 13, source_page: 2 },
      [
        { debit_account_id: "thb:expense:coffee:beans", credit_account_id: "thb:asset:bank", amount: 300 },
        { debit_account_id: "thb:expense:coffee:cups", credit_account_id: "thb:asset:bank", amount: 0.004 },
      ],
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe("dirty_input");
    expect(out.message).toBe("amount must be a positive integer in minor units.");
    expect(countTransactions(db)).toBe(0);
    expect(findAccountById(db, "thb:expense:coffee")).toBeNull();
    expect(findAccountById(db, "thb:expense:coffee:beans")).toBeNull();
    expect(findAccountById(db, "thb:expense:coffee:cups")).toBeNull();
    expect(countAccounts(db)).toBe(before);
  });

  it("asks once about an unknown merchant the header gave every leg", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      {
        date: "2026-05-25",
        description: "May salary",
        row_index: 12,
        source_page: 2,
        merchant_id: "m:nope",
      },
      [
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 50000 },
        { debit_account_id: "thb:expense:tax", credit_account_id: "thb:income:salary", amount: 8000 },
        { debit_account_id: "thb:expense:socialsecurity", credit_account_id: "thb:income:salary", amount: 2000 },
      ],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results).toHaveLength(3);
    expect(out.raisedQuestions).toBe(1);
    expect(out.merchant).toEqual({ how: "unknown" });

    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    expect(qs[0].kind).toBe("unknown_merchant");
    // Anchored on the first leg that posted, which speaks for the whole group.
    expect(qs[0].transaction_id).toBe(out.results[0].id);
  });

  it("anchors the merchant claim on the leg that posted when a re-commit grows a leg", () => {
    const known = upsertMerchant(db, { canonical_name: "Employer Co" }, []);
    const header = { date: "2026-05-25", description: "May salary", row_index: 20, source_page: 2 };
    const legs = [
      { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 50000 },
      { debit_account_id: "thb:expense:tax", credit_account_id: "thb:income:salary", amount: 8000 },
    ];
    expect(commitLinkedTransactions(db, CTX, { ...header, merchant_id: known.id }, legs).ok).toBe(true);
    expect(listQuestions(db)).toHaveLength(0);

    // The same row re-read as three legs: legs 0-1 keep their derived ids and
    // land as duplicates, so only leg 2 carries this run's merchant claim.
    const out = commitLinkedTransactions(db, CTX, { ...header, merchant_id: "m:nope" }, [
      ...legs,
      { debit_account_id: "thb:expense:socialsecurity", credit_account_id: "thb:income:salary", amount: 2000 },
    ]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.results.map((r) => r.duplicate)).toEqual([true, true, false]);

    expect(out.raisedQuestions).toBe(1);
    const qs = listQuestions(db);
    expect(qs).toHaveLength(1);
    expect(qs[0].kind).toBe("unknown_merchant");
    expect(qs[0].transaction_id).toBe(out.results[2].id);

    // The posted leg linked nothing; reading the duplicate leg's merchant would
    // credit this run with a link it never made.
    expect(findTransactionById(db, out.results[2].id)!.merchant_id).toBeNull();
    expect(out.merchant).toEqual({ how: "unknown" });
  });

  it("reports a leg whose stated currency its accounts overruled", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "May salary", row_index: 4, source_page: 2 },
      [
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 50000 },
        {
          debit_account_id: "thb:expense:tax",
          credit_account_id: "thb:income:salary",
          amount: 8000,
          currency: "USD",
        },
      ],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.currencyOverridden).toBe(true);
  });

  it("reports the header's merchant once for the whole group", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      {
        date: "2026-05-25",
        description: "May salary",
        row_index: 5,
        source_page: 2,
        merchant: { canonical_name: "Employer Co" },
      },
      [
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 50000 },
        { debit_account_id: "thb:expense:tax", credit_account_id: "thb:income:salary", amount: 8000 },
      ],
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // Every leg carries the header's merchant, which is why one report covers the group.
    expect(out.merchant.how).toBe("linked");
    expect(out.results.map((r) => findTransactionById(db, r.id)!.merchant_id)).toEqual([
      out.merchant.merchant_id,
      out.merchant.merchant_id,
    ]);
  });

  it("takes the group's merchant back when the insert is abandoned", () => {
    // A source_file_id no file answers to fails the FK at insert time: the way
    // to abandon a group after its first leg has already claimed the merchant.
    expect(() =>
      commitLinkedTransactions(
        db,
        CTX,
        {
          date: "2026-05-25",
          description: "May salary",
          row_index: 6,
          source_page: 2,
          source_file_id: "sf-gone",
          merchant: { canonical_name: "Ghost Employer", alias: "GHOST EMPLOYER" },
        },
        [
          { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 50000 },
          { debit_account_id: "thb:expense:tax", credit_account_id: "thb:income:salary", amount: 8000 },
        ],
      ),
    ).toThrow(/FOREIGN KEY/i);

    expect(findMerchantByName(db, "Ghost Employer")).toBeNull();
    expect(countTransactions(db)).toBe(0);
  });

  it("rolls back all legs when one leg is invalid", () => {
    const out = commitLinkedTransactions(
      db,
      CTX,
      { date: "2026-05-25", description: "bad batch", row_index: 3, source_page: 2 },
      [
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:income:salary", amount: 100 },
        { debit_account_id: "thb:asset:bank", credit_account_id: "thb:asset:bank", amount: 50 }, // debit == credit
      ],
    );
    expect(out.ok).toBe(false);
    expect(countTransactions(db)).toBe(0);
  });
});

describe("a refused row keeps one question across retries", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDB(seedAccountsAndFile); });

  /** Commits a row that must be refused, and reports what the refusal raised. */
  function refusalRaised(
    ctx: TransactionCommitContext,
    input: RawTransactionInput,
  ): number {
    const out = commitTransaction(db, ctx, input);
    if (out.ok) throw new Error(`expected a refusal, got ${out.transactionId}`);
    return out.raisedQuestions;
  }

  it("raises once per row for both refusal kinds, and reports raised_questions 0 on the retry", () => {
    // One refusal decided before resolution (the ledger is not open) and one
    // among the pure input rules: they leave by the same road and both dedupe.
    const rows = [
      raw({ debit_account_id: "eur:expense:food", row_index: 50 }),
      raw({ amount: 0, row_index: 51 }),
    ];

    expect(rows.map((input) => refusalRaised(CTX, input))).toEqual([1, 1]);
    expect(rows.map((input) => refusalRaised(CTX, input))).toEqual([0, 0]);

    expect(countQuestions(db, { file_id: "sf-1" })).toBe(2);
    expect(countTransactions(db)).toBe(0);
  });

  it("closes the refusal when the fixed row posts, and the file's open count follows", () => {
    expect(refusalRaised(CTX, raw({ debit_account_id: "eur:expense:food", row_index: 52 }))).toBe(1);
    expect(countQuestions(db, { file_id: "sf-1" })).toBe(1);

    // Same address, account fixed: the row posts under the id its address derives.
    const fixed = commitTransaction(db, CTX, raw({ row_index: 52 }));
    expect(fixed.ok).toBe(true);
    if (!fixed.ok) return;
    expect(fixed.duplicate).toBe(false);
    expect(fixed.transactionId).toBe(deriveTransactionId("hashABC", 1, 52));

    // The query behind the commit summary's file_open_question_count.
    expect(countQuestions(db, { file_id: "sf-1" })).toBe(0);
  });

  it("a row with no address asks again every attempt: nothing recognises the retry", () => {
    // The two halves of the address, missing one at a time. Neither row's
    // transaction id would be derived either, so neither re-commit is a no-op.
    const bad = raw({ debit_account_id: "eur:expense:food", row_index: 53 });
    const fileless = { ...CTX, fileId: null };
    expect([refusalRaised(fileless, bad), refusalRaised(fileless, bad)]).toEqual([1, 1]);

    const unindexed = raw({ debit_account_id: "eur:expense:food", row_index: null });
    expect([refusalRaised(CTX, unindexed), refusalRaised(CTX, unindexed)]).toEqual([1, 1]);

    expect(countQuestions(db)).toBe(4);
  });

  it("a deferred refusal still blocks the re-raise: deferring is not answering", () => {
    const bad = raw({ debit_account_id: "eur:expense:food", row_index: 54 });
    expect(refusalRaised(CTX, bad)).toBe(1);

    expect(deferQuestion(db, listQuestions(db)[0].id, 7)).toBe(true);
    expect(listQuestions(db)).toHaveLength(0);

    expect(refusalRaised(CTX, bad)).toBe(0);
    expect(countQuestions(db, { includeDeferred: true })).toBe(1);
  });

  it("posting leaves the questions the row's own hints raised alone", () => {
    // Only a refusal is addressed, and only an addressed question is closed by a
    // post: the fallback question belongs to a row that posted and stays open.
    const input = raw({ debit_account_id: "thb:food", row_index: 55 });
    const first = commitTransaction(db, CTX, input);
    expect(first.ok && first.raisedQuestions).toBe(1);

    const again = commitTransaction(db, CTX, input);
    expect(again.ok && again.duplicate).toBe(true);
    expect(again.ok && again.raisedQuestions).toBe(0);
    expect(listQuestions(db).map((q) => q.kind)).toEqual(["uncategorized"]);
  });

  it("a compound row's refusal is addressed to the row, not the leg that failed", () => {
    const header = {
      date: "2026-05-25",
      description: "Split with a bad leg",
      row_index: 60,
      source_page: 2,
    };
    const good = {
      debit_account_id: "thb:expense:food",
      credit_account_id: "thb:asset:bank",
      amount: 300,
    };
    const withBadLeg = [
      good,
      { debit_account_id: "eur:expense:coffee", credit_account_id: "thb:asset:bank", amount: 100 },
    ];

    const first = commitLinkedTransactions(db, CTX, header, withBadLeg);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.raisedQuestions).toBe(1);

    const second = commitLinkedTransactions(db, CTX, header, withBadLeg);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.raisedQuestions).toBe(0);
    expect(countQuestions(db, { file_id: "sf-1" })).toBe(1);
    expect(countTransactions(db)).toBe(0);

    // One refusal covered the whole group, so the group landing answers it.
    const fixed = commitLinkedTransactions(db, CTX, header, [
      good,
      { debit_account_id: "thb:expense:tax", credit_account_id: "thb:asset:bank", amount: 100 },
    ]);
    expect(fixed.ok).toBe(true);
    expect(countTransactions(db)).toBe(2);
    expect(countQuestions(db, { file_id: "sf-1" })).toBe(0);
  });
});
