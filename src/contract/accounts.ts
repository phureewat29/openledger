import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { CurrencyTotals, Summary } from "./primitives.js";

/** Mirrors ACCOUNT_TYPES in db/queries/accounts.ts; duplicated because the
 *  contract is a leaf module and must not import outside its tree (purity.test.ts). */
const ACCOUNT_TYPE_VALUES = ["asset", "liability", "income", "expense", "equity"] as const;

export const AccountType = z.enum(ACCOUNT_TYPE_VALUES);
export type AccountType = z.infer<typeof AccountType>;

/** The bare table row `accounts match` nests; no ledger balances joined. */
export const AccountRecord = z.object({
  id: z.string(),
  name: z.string(),
  type: AccountType,
  parent_id: z.string().nullable(),
  subtype: z.string().nullable(),
  bank_name: z.string().nullable(),
  account_number_masked: z.string().nullable(),
  currency: z.string(),
  due_day: z.number().int().nullable(),
  statement_day: z.number().int().nullable(),
  // Raw metadata_json column text, verbatim: never JSON.parse'd on the way out.
  metadata_json: z.string().nullable(),
  created_at: z.string(),
});
export type AccountRecord = z.infer<typeof AccountRecord>;

export const Account = AccountRecord.extend({
  balance: z.number(),
  debits_posted: z.number(),
  credits_posted: z.number(),
});
export type Account = z.infer<typeof Account>;

/** A direct child only, never its own subtree. */
export const AccountDetailChild = z.object({
  id: z.string(),
  name: z.string(),
  type: AccountType,
  balance: z.number(),
});
export type AccountDetailChild = z.infer<typeof AccountDetailChild>;

export const AccountDetail = Account.extend({
  rollup: CurrencyTotals,
  children: z.array(AccountDetailChild),
});
export type AccountDetail = z.infer<typeof AccountDetail>;

/** `accounts tree`: recursive, so the type is written by hand and threaded through `z.lazy`. */
export interface AccountTreeNode {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  balance: number;
  rollup: CurrencyTotals;
  children: AccountTreeNode[];
}

export const AccountTreeNode: z.ZodType<AccountTreeNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    type: AccountType,
    currency: z.string(),
    balance: z.number(),
    rollup: CurrencyTotals,
    children: z.array(AccountTreeNode),
  }),
);

/** `accounts match`: a fuzzy-match candidate; never redacted. */
export const AccountMatch = z.object({
  account: AccountRecord,
  similarity: z.number(),
});
export type AccountMatch = z.infer<typeof AccountMatch>;

export const ListAccountsSummary = Summary.extend({
  total: z.number().int(),
  returned: z.number().int(),
});
export type ListAccountsSummary = z.infer<typeof ListAccountsSummary>;

export const TreeAccountsSummary = Summary.extend({
  roots: z.number().int(),
});
export type TreeAccountsSummary = z.infer<typeof TreeAccountsSummary>;

export const MatchAccountsSummary = Summary.extend({
  returned: z.number().int(),
});
export type MatchAccountsSummary = z.infer<typeof MatchAccountsSummary>;

/** `accounts create`, single mode (flags, no `--input`). */
export const CreateAccountResult = z.object({
  id: z.string(),
  created: z.literal(true),
  created_parents: z.array(z.string()),
  // Present only when --masked was given: the stored (post-normalization) value.
  account_number_masked: z.string().nullable().optional(),
});
export type CreateAccountResult = z.infer<typeof CreateAccountResult>;

export const CreateAccountBatchCreated = z.object({
  type: z.literal("result"),
  index: z.number().int(),
  ok: z.literal(true),
  id: z.string(),
  created: z.literal(true),
  created_parents: z.array(z.string()),
  account_number_masked: z.string().nullable().optional(),
});
export type CreateAccountBatchCreated = z.infer<typeof CreateAccountBatchCreated>;

/** An id that already existed; counted as success, not failure. */
export const CreateAccountBatchDuplicate = z.object({
  type: z.literal("result"),
  index: z.number().int(),
  ok: z.literal(true),
  id: z.string(),
  duplicate: z.literal(true),
});
export type CreateAccountBatchDuplicate = z.infer<typeof CreateAccountBatchDuplicate>;

export const CreateAccountBatchFailure = z.object({
  type: z.literal("result"),
  index: z.number().int(),
  ok: z.literal(false),
  message: z.string(),
});
export type CreateAccountBatchFailure = z.infer<typeof CreateAccountBatchFailure>;

export const CreateAccountBatchSummary = Summary.extend({
  created: z.number().int(),
  duplicates: z.number().int(),
  failed: z.number().int(),
});
export type CreateAccountBatchSummary = z.infer<typeof CreateAccountBatchSummary>;

export const MergeAccountsResult = z.object({
  from: z.string(),
  to: z.string(),
  moved: z.number().int(),
  // Deleted, not moved: re-pointing would collapse into a self-transaction (debit == credit).
  deleted_self_transactions: z.number().int(),
  moved_merchant_defaults: z.number().int(),
});
export type MergeAccountsResult = z.infer<typeof MergeAccountsResult>;

export const DeleteAccountResult = z.object({
  id: z.string(),
  deleted: z.literal(true),
});
export type DeleteAccountResult = z.infer<typeof DeleteAccountResult>;

export const AdjustAccountResult = z.object({
  // Null when the account was already at the target balance (no-op adjustment).
  transaction_id: z.string().nullable(),
  delta: z.number(),
});
export type AdjustAccountResult = z.infer<typeof AdjustAccountResult>;

/**
 * `id` always. `name`/`renamed` and `before`/`after` each appear only when that
 * half of the update (rename vs. metadata patch) ran; at least one always does.
 * `before`/`after` hold whichever patch fields were given, so values vary by key.
 */
export const UpdateAccountResult = z.object({
  id: z.string(),
  name: z.string().optional(),
  renamed: z.literal(true).optional(),
  before: z.record(z.string(), z.unknown()).optional(),
  after: z.record(z.string(), z.unknown()).optional(),
});
export type UpdateAccountResult = z.infer<typeof UpdateAccountResult>;

export const ACCOUNTS_CONTRACTS = {
  "accounts list": { lines: [Account, ListAccountsSummary], summary: "plain" },
  "accounts tree": { lines: [AccountTreeNode, TreeAccountsSummary], summary: "plain" },
  "accounts show": { lines: [AccountDetail] },
  "accounts create": {
    lines: [
      CreateAccountResult,
      CreateAccountBatchCreated,
      CreateAccountBatchDuplicate,
      CreateAccountBatchFailure,
      CreateAccountBatchSummary,
    ],
  },
  "accounts merge": { lines: [MergeAccountsResult] },
  "accounts delete": { lines: [DeleteAccountResult] },
  "accounts adjust": { lines: [AdjustAccountResult] },
  "accounts match": { lines: [AccountMatch, MatchAccountsSummary], summary: "plain" },
  "accounts update": { lines: [UpdateAccountResult] },
} as const satisfies Record<string, CommandContract>;
