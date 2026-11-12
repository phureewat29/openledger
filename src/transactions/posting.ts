import type Database from "libsql";
import { ledgerExists } from "../accounts/queries.js";
import type { MerchantUpsertInput } from "../merchants/queries.js";
import { currencyOf, isLedgerScopedId } from "../lib/ids.js";
import type { TransactionMerchantInput } from "./queries.js";

/** One authority for the bookkeeping directions shown in CLI help text. */
export const DIRECTION_RULES =
  "Direction, not sign: debit the account that grows, amount always positive. Card purchase: debit thb:expense:<cat>, credit thb:liability:credit_card:<x>. Bank spend: debit thb:expense:<cat>, credit thb:asset:bank:<x>. Salary: debit thb:asset:bank:<x>, credit thb:income:salary. A refund reverses the purchase's accounts; a card payment debits the liability and credits the bank; opening balances post against thb:equity:opening. Money crossing currencies is two linked legs through <currency>:equity:conversion, never one row.";

export function withNoiseTokens(
  merchant: MerchantUpsertInput | null | undefined,
  noise: readonly string[],
): TransactionMerchantInput | null {
  return merchant ? { ...merchant, noise_tokens: noise } : null;
}

/** Only heads naming an EXISTING ledger count as a mismatch; an unopened
 *  ledger is a refusal of its own. */
export function crossLedger(
  db: Database.Database,
  debitAccountId: string,
  creditAccountId: string,
): boolean {
  if (!isLedgerScopedId(debitAccountId) || !isLedgerScopedId(creditAccountId)) return false;
  const debitCurrency = currencyOf(debitAccountId);
  const creditCurrency = currencyOf(creditAccountId);
  if (debitCurrency === creditCurrency) return false;
  return ledgerExists(db, debitCurrency) && ledgerExists(db, creditCurrency);
}
