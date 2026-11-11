import { orderBy, round } from "es-toolkit";
import type Database from "libsql";
import { listAccounts, type AccountRow, type AccountType } from "./queries.js";
import { accountNumberKey, tailAfterMask } from "../lib/masked.js";
import { levenshtein } from "../lib/distance.js";

export interface FuzzyAccountMatch {
  account: AccountRow;
  similarity: number;
}

/** The candidates a caller could actually act on. Both fields are required:
 *  a cross-ledger lookalike proposes a merge the trigger refuses anyway. */
interface FuzzyAccountScope {
  readonly type: AccountType;
  /** ISO currency, as `currencyOf` and `AccountRow.currency` both spell it. */
  readonly ledger: string;
}

function inScope(row: AccountRow, scope: FuzzyAccountScope): boolean {
  return row.type === scope.type && row.currency === scope.ledger;
}

// A mask in the text (`470686XXXXXX9483`) is authoritative: its tail wins over the
// longest-digit-run fallback, which would prefer the longer unmasked prefix.
function queryNumberKey(text: string): string {
  const tail = tailAfterMask(text);
  if (tail !== text) return accountNumberKey(tail);

  const runs = text.match(/\d+/g);
  if (!runs) return "";
  const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
  return accountNumberKey(longest);
}

/** Loose, favoring recall: `accounts match` callers review the list before
 *  acting. The unprompted `similar_account` hint passes the stricter
 *  FUZZY_THRESHOLD (accounts/resolve.ts) instead; tune the two together. */
const MATCH_THRESHOLD = 0.5;

const SUBSTRING_FLOOR = 0.85;

// Above the substring floor, below exact-name 1.0: masked keys can collide
// across banks, so a number hit never outranks an exact name.
const NUMBER_FLOOR = 0.9;

function rowNumberKey(row: AccountRow, name: string): string {
  return row.account_number_masked ? accountNumberKey(row.account_number_masked) : queryNumberKey(name);
}

function scoreRow(row: AccountRow, q: string, qKey: string): number {
  const name = row.name.toLowerCase();
  const substringHit = name.includes(q) || q.includes(name);
  const numberHit = !!qKey && rowNumberKey(row, name) === qKey;
  return Math.max(
    similarity(q, name),
    substringHit ? SUBSTRING_FLOOR : 0,
    numberHit ? NUMBER_FLOOR : 0,
  );
}

/** A query carrying an account number matches the row's masked number.
 *  Callers confirm before acting. `scope` narrows the candidates, never the
 *  ranking of the ones that survive it. */
export function findAccountsByFuzzyName(
  db: Database.Database,
  query: string,
  threshold = MATCH_THRESHOLD,
  scope?: FuzzyAccountScope,
): FuzzyAccountMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qKey = queryNumberKey(q);
  const matches = listAccounts(db)
    .filter((row) => !scope || inScope(row, scope))
    .flatMap((account) => {
      const score = scoreRow(account, q, qKey);
      return score >= threshold ? [{ account, similarity: round(score, 3) }] : [];
    });
  return orderBy(matches, ["similarity"], ["desc"]);
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}
