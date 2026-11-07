import { mapValues } from "es-toolkit";
import type Database from "libsql";
import {
  countChildAccounts,
  deleteAccount as deleteAccountRow,
  findAccountById,
  insertAccount,
  insertStructuralAccount,
  isAccountType,
  type AccountType,
  type CreateAccountInput,
} from "./queries.js";
import { accountHasTransactions, repointTransactions } from "../transactions/queries.js";
import { repointMerchantDefaultAccount } from "../merchants/queries.js";
import { inTransaction } from "../db/transaction.js";
import { STRUCTURAL_SUFFIX, currencyOf, typeFromId } from "../lib/ids.js";

/** The DDL only GLOB-checks the currency head and the type position; this
 *  module owns the rest of the grammar. */
const ACCOUNT_ID_RE = /^[a-z]{3}:[a-z]+(?::[a-z0-9][a-z0-9._-]*)*$/;

const CURRENCY_RE = /^[a-z]{3}$/;

const TYPE_ROOT_NAME: Record<AccountType, string> = {
  asset: "Assets",
  liability: "Liabilities",
  income: "Income",
  expense: "Expenses",
  equity: "Equity",
};

export type StructuralKind = keyof typeof STRUCTURAL_SUFFIX;

const STRUCTURAL_NAME: Record<StructuralKind, string> = {
  uncategorized: "Uncategorized",
  adjustments: "Adjustments",
  opening: "Opening Balance",
};

/** The accounts the system auto-creates, one set per ledger. */
export const STRUCTURAL_ACCOUNTS: Record<StructuralKind, { type: AccountType; name: string }> =
  mapValues(STRUCTURAL_NAME, (name, kind) => ({
    type: STRUCTURAL_SUFFIX[kind].split(":")[0] as AccountType,
    name,
  }));

/** A bad currency here is a broken invariant, not user input (refused at the
 *  edges); throws instead of writing an id the DDL's CHECK would abort on. */
function ledgerCurrency(currency: string): string {
  const lower = currency.toLowerCase();
  if (!CURRENCY_RE.test(lower)) {
    throw new Error(`Currency "${currency}" must be a 3-letter code (e.g. thb) to name a ledger.`);
  }
  return lower;
}

export function structuralAccountId(currency: string, kind: StructuralKind): string {
  return `${ledgerCurrency(currency)}:${STRUCTURAL_SUFFIX[kind]}`;
}

function ledgerRootId(currency: string, type: AccountType): string {
  return `${ledgerCurrency(currency)}:${type}`;
}

/** True for a `<currency>:<type>` id, the only shape allowed a null parent. */
export function isLedgerRootId(id: string): boolean {
  const segments = id.split(":");
  return segments.length === 2 && isAccountType(segments[1]);
}

/** Root and structural names carry the currency, or `thb:asset` and `usd:asset`
 *  both named "Assets" become mutual fuzzy-match lookalikes. */
function ledgerName(name: string, currency: string): string {
  return `${name} (${currency.toUpperCase()})`;
}

export function ensureLedgerRoot(db: Database.Database, currency: string, type: AccountType): void {
  const id = ledgerRootId(currency, type);
  if (findAccountById(db, id)) return;
  insertStructuralAccount(db, {
    id,
    name: ledgerName(TYPE_ROOT_NAME[type], currency),
    type,
    parent_id: null,
  });
}

/** Idempotent; returns the id so callers don't re-derive it. */
export function ensureStructuralAccount(
  db: Database.Database,
  currency: string,
  kind: StructuralKind,
): string {
  const id = structuralAccountId(currency, kind);
  if (findAccountById(db, id)) return id;
  const { type, name } = STRUCTURAL_ACCOUNTS[kind];
  ensureLedgerRoot(db, currency, type);
  insertStructuralAccount(db, {
    id,
    name: ledgerName(name, currency),
    type,
    parent_id: ledgerRootId(currency, type),
  });
  return id;
}

export interface Refusal<R extends string> {
  readonly ok: false;
  readonly reason: R;
  readonly message: string;
}

export function refuse<R extends string>(reason: R, message: string): Refusal<R> {
  return { ok: false, reason, message };
}

/** `account_exists` is singled out elsewhere to swallow a lost race in the ancestor walk. */
export type AccountFailure = "account_exists" | "parent_not_found" | "invalid_hierarchy";

export type AccountRefusal = Refusal<AccountFailure>;

export type AccountResult = { readonly ok: true } | AccountRefusal;

const ACCOUNT_OK: AccountResult = { ok: true };

/** Grammar only, no database; callable standalone so a caller opening the
 *  ledger before the leaf can refuse a bad id before any write. */
export function validateAccountId(id: string, type: AccountType): AccountResult {
  if (!ACCOUNT_ID_RE.test(id)) {
    return refuse(
      "invalid_hierarchy",
      `Account id "${id}" must be lowercase <currency>:<type>[:<segment>...], e.g. thb:expense:food.`,
    );
  }
  // Caught here so a mismatch is a clean refusal rather than a raw CHECK abort.
  if (typeFromId(id) !== type) {
    return refuse(
      "invalid_hierarchy",
      `Account id "${id}" must carry its type in the second segment: expected "${currencyOf(id).toLowerCase()}:${type}".`,
    );
  }
  return ACCOUNT_OK;
}

/** A missing ledger-root parent validates as the root `createAccount` opens for it. */
function validateAccountHierarchy(
  db: Database.Database,
  input: CreateAccountInput,
  parentId: string | null,
): AccountResult {
  const grammar = validateAccountId(input.id, input.type);
  if (!grammar.ok) return grammar;

  if (parentId === null) {
    return isLedgerRootId(input.id)
      ? ACCOUNT_OK
      : refuse(
          "invalid_hierarchy",
          `Account "${input.id}" has no parent_id; only a ledger's type root (<currency>:<type>, e.g. thb:asset) may have a null parent.`,
        );
  }

  const parent =
    findAccountById(db, parentId) ??
    (isLedgerRootId(parentId) ? { id: parentId, type: typeFromId(parentId) } : null);
  if (!parent) {
    return refuse("parent_not_found", `Parent account "${parentId}" does not exist; create it first.`);
  }
  if (parent.type !== input.type) {
    return refuse(
      "invalid_hierarchy",
      `Account "${input.id}" type "${input.type}" does not match parent "${parentId}" type "${parent.type}".`,
    );
  }
  // Also the same-ledger check: a child extends its parent's id, prefix included.
  if (!input.id.startsWith(parent.id + ":")) {
    return refuse("invalid_hierarchy", `Account id "${input.id}" must start with parent id "${parent.id}:".`);
  }
  return ACCOUNT_OK;
}

export function createAccount(db: Database.Database, input: CreateAccountInput): AccountResult {
  const parentId = input.parent_id ?? null;
  return inTransaction(db, (): AccountResult => {
    const hierarchy = validateAccountHierarchy(db, input, parentId);
    if (!hierarchy.ok) return hierarchy;
    if (parentId && isLedgerRootId(parentId)) ensureLedgerRoot(db, currencyOf(parentId), input.type);
    if (!insertAccount(db, input).inserted) {
      return refuse("account_exists", `Account "${input.id}" already exists.`);
    }
    return ACCOUNT_OK;
  });
}

export type MergeAccountsFailure = "same_account" | "not_found" | "cross_ledger" | "has_children";

type MergeAccountsOutcome =
  | {
      readonly ok: true;
      moved: number;
      // Deleted, not moved: re-pointing would collapse into a self-transaction (debit == credit).
      deletedSelfTransactions: number;
      movedMerchantDefaults: number;
    }
  | Refusal<MergeAccountsFailure>;

export function mergeAccounts(
  db: Database.Database,
  fromId: string,
  toId: string,
): MergeAccountsOutcome {
  if (fromId === toId) return refuse("same_account", "Cannot merge an account into itself.");

  return inTransaction(db, (): MergeAccountsOutcome => {
    if (!findAccountById(db, fromId)) return refuse("not_found", `Source account ${fromId} not found.`);
    if (!findAccountById(db, toId)) return refuse("not_found", `Destination account ${toId} not found.`);
    // The trigger only catches this once a row moves; an account with none
    // would silently merge across ledgers.
    if (currencyOf(fromId) !== currencyOf(toId)) {
      return refuse(
        "cross_ledger",
        `Cannot merge across ledgers: ${fromId} is ${currencyOf(fromId)}, ${toId} is ${currencyOf(toId)}.`,
      );
    }
    const children = countChildAccounts(db, fromId);
    if (children > 0) {
      return refuse(
        "has_children",
        `Account ${fromId} has ${children} child account(s); merge or delete them first.`,
      );
    }

    const { moved, deletedSelfTransactions } = repointTransactions(db, fromId, toId);
    // Before the delete: the FK would otherwise null these defaults out.
    const movedMerchantDefaults = repointMerchantDefaultAccount(db, fromId, toId);
    deleteAccountRow(db, fromId);
    return { ok: true, moved, deletedSelfTransactions, movedMerchantDefaults };
  });
}

export type DeleteAccountFailure = "has_transactions" | "has_children";

type DeleteAccountOutcome = { readonly ok: true } | Refusal<DeleteAccountFailure>;

export function deleteAccount(db: Database.Database, id: string): DeleteAccountOutcome {
  return inTransaction(db, (): DeleteAccountOutcome => {
    if (accountHasTransactions(db, id)) {
      return refuse("has_transactions", `Account ${id} still has transactions; merge it first.`);
    }
    const children = countChildAccounts(db, id);
    if (children > 0) {
      return refuse("has_children", `Account ${id} has ${children} child account(s); delete them first.`);
    }
    deleteAccountRow(db, id);
    return { ok: true };
  });
}
