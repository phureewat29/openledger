import type Database from "libsql";
import {
  deleteMerchant,
  findMerchantById,
  repointMerchantAliases,
  setMerchantDefaultAccount,
} from "./queries.js";
import { repointTransactionMerchant } from "../transactions/queries.js";
import { inTransaction } from "../db/transaction.js";

export type MergeMerchantsFailure = "same_merchant" | "not_found";

type MergeMerchantsOutcome =
  | {
      ok: true;
      moved_transactions: number;
      moved_aliases: number;
      /** Present only when the destination had no default_account_id and the
       *  source's was adopted in its place. */
      adopted_default_account?: string;
    }
  | { ok: false; reason: MergeMerchantsFailure; message: string };

export function mergeMerchants(
  db: Database.Database,
  fromId: string,
  toId: string,
): MergeMerchantsOutcome {
  if (fromId === toId) {
    return { ok: false, reason: "same_merchant", message: "Cannot merge a merchant into itself." };
  }

  return inTransaction(db, (): MergeMerchantsOutcome => {
    const from = findMerchantById(db, fromId);
    if (!from) return { ok: false, reason: "not_found", message: `Source merchant ${fromId} not found.` };
    const to = findMerchantById(db, toId);
    if (!to) return { ok: false, reason: "not_found", message: `Destination merchant ${toId} not found.` };

    const movedTransactions = repointTransactionMerchant(db, fromId, toId);
    const movedAliases = repointMerchantAliases(db, fromId, toId);
    const adopted = !to.default_account_id && from.default_account_id;
    if (adopted) setMerchantDefaultAccount(db, toId, adopted);
    deleteMerchant(db, fromId);

    return {
      ok: true,
      moved_transactions: movedTransactions,
      moved_aliases: movedAliases,
      ...(adopted ? { adopted_default_account: adopted } : {}),
    };
  });
}
