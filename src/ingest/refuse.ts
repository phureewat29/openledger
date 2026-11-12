import type Database from "libsql";
import { shouldPlaceAccount, isUncategorizedId, namesUnopenedLedger } from "../accounts/resolve.js";
import {
  invalidTransaction,
  validateTransactionFields,
  type ValidateTransactionResult,
} from "../transactions/queries.js";
import { crossLedger } from "../transactions/posting.js";
import type { MerchantUpsertInput } from "../merchants/queries.js";
import { currencyOf, isLedgerScopedId } from "../lib/ids.js";
import { toMinorUnits } from "../lib/money.js";
import type { TransactionSide } from "./questions.js";

export interface RawTransactionInput {
  id?: string;
  group_id?: string | null;
  date: string;
  description: string;
  raw_descriptor?: string | null;
  merchant?: MerchantUpsertInput | null;
  merchant_id?: string | null;
  source_file_id?: string | null;
  debit_account_id: string;
  credit_account_id: string;
  /** DECIMAL in `currency`; converted to minor units during commit. */
  amount: number;
  /** Hint only; account ids' currency wins, conflict surfaces as `currencyOverridden`. */
  currency?: string | null;
  source_page?: number | null;
  row_index?: number | null;
  leg_index?: number | null;
}

interface UnopenedLedgerRefusal {
  ok: false;
  reason: "unknown_ledger";
  message: string;
  side: TransactionSide;
  accountId: string;
  ledger: string;
}

type DirtyInput = { ok: false; reason: "dirty_input"; message: string };

function dirtyInput(message: string): DirtyInput {
  return { ok: false, reason: "dirty_input", message };
}

/** Refusals decided by pure read, before resolution writes anything. */
export type RowRefusal =
  | DirtyInput
  | {
      ok: false;
      reason: "currency_mismatch";
      message: string;
      debit: { id: string; currency: string };
      credit: { id: string; currency: string };
    }
  | UnopenedLedgerRefusal;

function validateRawTransaction(input: RawTransactionInput): ValidateTransactionResult {
  const fields = validateTransactionFields(input);
  if (!fields.ok) return fields;
  // tx: ids make re-ingest idempotent; a caller-supplied id must stay in that namespace.
  if (input.id != null && !input.id.startsWith("tx:")) {
    return invalidTransaction('id must start with "tx:".');
  }
  if (typeof input.amount !== "number" || !Number.isFinite(input.amount) || input.amount <= 0) {
    return invalidTransaction("amount must be a positive number.");
  }
  // Currency isn't resolved yet, so this assumes the largest ISO exponent (3);
  // conservative, since an exponent-0 currency would tolerate a larger amount.
  if (input.amount * 1000 > Number.MAX_SAFE_INTEGER) {
    return invalidTransaction("amount is too large to hold in any currency's minor units.");
  }
  return { ok: true };
}

/** An uppercase head is still a currency claim, and the id grammar has no case
 *  to read it in; treating it as no claim would drop the side into the other's
 *  ledger and relabel the amount at that exponent. */
function miscasedHeadRefusal(side: TransactionSide, accountId: string): DirtyInput | null {
  if (isLedgerScopedId(accountId)) return null;
  if (!isLedgerScopedId(accountId.toLowerCase())) return null;
  return dirtyInput(
    `${side} ${accountId} carries an uppercase currency head; account ids are lowercase, ` +
      `e.g. ${accountId.toLowerCase()}`,
  );
}

/** The unplaceable side takes the other's uncategorized account, so naming that
 *  very account opposite it would post both legs to one account. */
function sharedFallbackRefusal(unplaceableId: string, otherId: string): DirtyInput | null {
  if (!isUncategorizedId(otherId)) return null;
  return dirtyInput(
    `${unplaceableId} names no path in an existing ledger and falls back onto ${otherId}, ` +
      "which the other side already names; debit and credit accounts must differ.",
  );
}

/** Refuses the whole row before either side resolves, so a good side's
 *  placeholder tree can't outlive a refused row. */
function unopenedLedgerRefusal(
  db: Database.Database,
  side: TransactionSide,
  accountId: string,
): UnopenedLedgerRefusal | null {
  if (!namesUnopenedLedger(db, accountId)) return null;
  const ledger = currencyOf(accountId).toLowerCase();
  return {
    ok: false,
    reason: "unknown_ledger",
    side,
    accountId,
    ledger,
    message:
      `${side} ${accountId} names ledger "${ledger}", which does not exist here; ` +
      "open it with `oled accounts create`, or fix the currency prefix",
  };
}

/** Pure-read refusals only, decided before resolution writes anything; shared
 *  with the compound pre-scan so a bad later leg is caught first. */
export function refuseRow(db: Database.Database, input: RawTransactionInput): RowRefusal | null {
  const raw = validateRawTransaction(input);
  if (!raw.ok) return dirtyInput(raw.message);

  const miscased =
    miscasedHeadRefusal("debit", input.debit_account_id) ??
    miscasedHeadRefusal("credit", input.credit_account_id);
  if (miscased) return miscased;

  const unopened =
    unopenedLedgerRefusal(db, "debit", input.debit_account_id) ??
    unopenedLedgerRefusal(db, "credit", input.credit_account_id);
  if (unopened) return unopened;

  if (crossLedger(db, input.debit_account_id, input.credit_account_id)) {
    const debit = { id: input.debit_account_id, currency: currencyOf(input.debit_account_id) };
    const credit = { id: input.credit_account_id, currency: currencyOf(input.credit_account_id) };
    return {
      ok: false,
      reason: "currency_mismatch",
      message: `debit ${debit.id} is ${debit.currency}, credit ${credit.id} is ${credit.currency}`,
      debit,
      credit,
    };
  }

  const debitPlaceable = shouldPlaceAccount(db, input.debit_account_id);
  const creditPlaceable = shouldPlaceAccount(db, input.credit_account_id);
  if (!debitPlaceable && !creditPlaceable) {
    return dirtyInput("neither account id names a path in an existing ledger.");
  }

  const shared =
    (debitPlaceable ? null : sharedFallbackRefusal(input.debit_account_id, input.credit_account_id)) ??
    (creditPlaceable ? null : sharedFallbackRefusal(input.credit_account_id, input.debit_account_id));
  if (shared) return shared;

  // Both sides share a ledger by now (`crossLedger` refused the rest), so the
  // placeable side already fixes the exponent the decimal converts through.
  const currency = currencyOf(debitPlaceable ? input.debit_account_id : input.credit_account_id);
  if (toMinorUnits(input.amount, currency) <= 0) {
    return dirtyInput("amount must be a positive integer in minor units.");
  }
  return null;
}
