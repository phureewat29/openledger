import { range } from "es-toolkit";
import type Database from "libsql";
import {
  createAccount,
  ensureLedgerRoot,
  isLedgerRootId,
  structuralAccountId,
  validateAccountId,
  type AccountRefusal,
} from "./accounts.js";
import {
  findAccountById,
  isAccountType,
  ledgerExists,
  type AccountType,
  type CreateAccountInput,
} from "./queries.js";
import { findAccountsByFuzzyName } from "./matching.js";
import { inTransaction } from "../db/transaction.js";
import { currencyOf, isLedgerScopedId, typeFromId } from "../lib/ids.js";

export type AccountHint =
  | { readonly type: "placeholder_created"; readonly accountId: string }
  | { readonly type: "uncategorized_fallback"; readonly accountId: string }
  | { readonly type: "uncategorized_requested"; readonly accountId: string }
  | {
      readonly type: "similar_account";
      readonly accountId: string;
      readonly similarId: string;
    };

/** The ledger's own uncategorized account, and nothing under it. Compared
 *  against the id `ensureStructuralAccount` would build, never re-parsed. */
export function isUncategorizedId(accountId: string): boolean {
  return (
    isLedgerScopedId(accountId) &&
    accountId === structuralAccountId(currencyOf(accountId), "uncategorized")
  );
}

export interface PostingResolution {
  /** Null when no path could be built; caller supplies the fallback ledger. */
  readonly accountId: string | null;
  readonly hint: AccountHint | null;
}

/** A lookalike is reported, never used: the requested id is still created. */
export function resolveOnePosting(
  db: Database.Database,
  accountId: string,
): PostingResolution {
  if (findAccountById(db, accountId)) return { accountId, hint: null };

  const similarId = bestFuzzyMatch(db, accountId);
  if (!ensurePlaceholderAccount(db, accountId)) return { accountId: null, hint: null };
  return {
    accountId,
    hint: similarId
      ? { type: "similar_account", accountId, similarId }
      : { type: "placeholder_created", accountId },
  };
}

/** The currency head alone decides: booking elsewhere would relabel the
 *  amount at the wrong exponent. */
export function namesUnopenedLedger(db: Database.Database, accountId: string): boolean {
  return isLedgerScopedId(accountId) && !ledgerExists(db, currencyOf(accountId));
}

// Stricter than MATCH_THRESHOLD (accounts/matching.ts): hints are unprompted,
// so precision wins over recall. Tune the two together.
const FUZZY_THRESHOLD = 0.7;

/**
 * Closest existing account to a requested id, or null; advisory only.
 * Excludes cross-ledger and same-lineage matches.
 */
function bestFuzzyMatch(db: Database.Database, accountId: string): string | null {
  const type = typeFromId(accountId);
  const leaf = leafSegment(accountId).replace(/[-_]+/g, " ");
  if (!isAccountType(type) || !leaf) return null;
  const matches = findAccountsByFuzzyName(db, leaf, FUZZY_THRESHOLD, {
    type,
    ledger: currencyOf(accountId),
  });
  return matches.find((m) => !sharesLineage(m.account.id, accountId))?.account.id ?? null;
}

function sharesLineage(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}:`) || b.startsWith(`${a}:`);
}

function leafSegment(id: string): string {
  return id.slice(id.lastIndexOf(":") + 1);
}

function parentIdOf(id: string): string {
  return id.slice(0, id.lastIndexOf(":"));
}

type PathResult = { readonly ok: true; readonly created: string[] } | AccountRefusal;

/** Opens the ledger root and every missing account down to `id` inclusive; `created` is root-first. */
function openAccountPath(db: Database.Database, id: string, type: AccountType): PathResult {
  const segments = id.split(":");
  const rootId = `${segments[0]}:${type}`;
  const created: string[] = findAccountById(db, rootId) ? [] : [rootId];
  ensureLedgerRoot(db, segments[0], type);

  const pathIds = range(3, segments.length + 1).map((n) => segments.slice(0, n).join(":"));
  for (const pathId of pathIds) {
    if (findAccountById(db, pathId)) continue;
    const result = createAccount(db, {
      id: pathId,
      name: humanizeSegment(leafSegment(pathId)),
      type,
      parent_id: parentIdOf(pathId),
    });
    // A concurrent writer claimed the id first: its row stands, the walk goes on.
    if (!result.ok && result.reason !== "account_exists") return result;
    if (result.ok) created.push(pathId);
  }
  return { ok: true, created };
}

/** The type `ensurePlaceholderAccount` would open `accountId` under, or null when it would refuse. */
function placeableType(db: Database.Database, accountId: string): AccountType | null {
  const type = typeFromId(accountId);
  if (!isAccountType(type) || !validateAccountId(accountId, type).ok) return null;
  return ledgerExists(db, currencyOf(accountId)) ? type : null;
}

/**
 * The read-only half of `ensurePlaceholderAccount`, so a caller can refuse a
 * row before resolution writes anything.
 */
export function shouldPlaceAccount(db: Database.Database, accountId: string): boolean {
  return placeableType(db, accountId) !== null;
}

/**
 * False on a malformed id, unknown type, or unopened ledger; a database
 * failure propagates instead.
 */
function ensurePlaceholderAccount(db: Database.Database, accountId: string): boolean {
  const type = placeableType(db, accountId);
  return type !== null && openAccountPath(db, accountId, type).ok;
}

interface AncestorsReady {
  readonly ok: true;
  /** Null for a ledger type root. */
  readonly parentId: string | null;
  /** Root-to-leaf order. */
  readonly createdParents: string[];
}

/**
 * Unlike `ensurePlaceholderAccount`, returns the refusal instead of
 * swallowing it, and may open a new ledger. `id` must already pass the grammar.
 */
function ensureAccountAncestors(
  db: Database.Database,
  id: string,
  type: AccountType,
): AncestorsReady | AccountRefusal {
  if (isLedgerRootId(id)) return { ok: true, parentId: null, createdParents: [] };
  const parentId = parentIdOf(id);
  const opened = openAccountPath(db, parentId, type);
  if (!opened.ok) return opened;
  return { ok: true, parentId, createdParents: opened.created };
}

export interface CreatedAccount {
  readonly ok: true;
  id: string;
  created_parents: string[];
  account_number_masked?: string | null;
}

/**
 * An omitted `parent_id` opens every missing ancestor. A refusal can only come
 * before the first write: the grammar check precedes the walk, and an id that
 * already exists has every ancestor already.
 */
export function createOneAccount(
  db: Database.Database,
  input: CreateAccountInput,
): CreatedAccount | AccountRefusal {
  const grammar = validateAccountId(input.id, input.type);
  if (!grammar.ok) return grammar;

  return inTransaction(db, (): CreatedAccount | AccountRefusal => {
    const ancestors: AncestorsReady | AccountRefusal =
      input.parent_id === undefined
        ? ensureAccountAncestors(db, input.id, input.type)
        : { ok: true, parentId: input.parent_id, createdParents: [] };
    if (!ancestors.ok) return ancestors;

    const created = createAccount(db, { ...input, parent_id: ancestors.parentId });
    if (!created.ok) return created;

    const result: CreatedAccount = { ok: true, id: input.id, created_parents: ancestors.createdParents };
    if (input.account_number_masked === undefined) return result;
    // Echo the stored (post-normalization) value rather than re-deriving it.
    return { ...result, account_number_masked: findAccountById(db, input.id)?.account_number_masked ?? null };
  });
}

export function humanizeSegment(segment: string): string {
  const spaced = segment.replace(/[-_]+/g, " ").trim();
  if (!spaced) return "Placeholder";
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}
