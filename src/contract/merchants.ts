import * as z from "zod";
import type { CommandContract } from "./kind.js";
import { CappedSummary } from "./primitives.js";

/** A normalized alias pattern stays with the merchant that already holds it. */
export const MerchantAliasConflict = z.object({
  pattern: z.string(),
  held_by: z.string(),
});
export type MerchantAliasConflict = z.infer<typeof MerchantAliasConflict>;

/** `canonical_name` is redacted by default. */
export const Merchant = z.object({
  id: z.string(),
  canonical_name: z.string(),
  default_account_id: z.string().nullable(),
  created_at: z.iso.datetime(),
  alias_count: z.number().int(),
});
export type Merchant = z.infer<typeof Merchant>;

export const MerchantResolveMiss = z.object({ found: z.literal(false) });
export type MerchantResolveMiss = z.infer<typeof MerchantResolveMiss>;

export const MerchantResolveHit = z.object({
  found: z.literal(true),
  merchant_id: z.string(),
  canonical_name: z.string(),
  default_account_id: z.string().nullable(),
});
export type MerchantResolveHit = z.infer<typeof MerchantResolveHit>;

/** A descriptor no alias pattern claims resolves to nothing, not to an error. */
export const MerchantResolveResult = z.discriminatedUnion("found", [
  MerchantResolveMiss,
  MerchantResolveHit,
]);
export type MerchantResolveResult = z.infer<typeof MerchantResolveResult>;

export const MerchantUpsertResult = z.object({
  id: z.string(),
  canonical_name: z.string(),
  default_account_id: z.string().nullable(),
  created_at: z.iso.datetime(),
  /** Present when `--alias` normalizes onto a pattern another merchant already holds. */
  alias_conflict: MerchantAliasConflict.optional(),
});
export type MerchantUpsertResult = z.infer<typeof MerchantUpsertResult>;

/** Every field but `merchant_id` reports one flag that was passed. */
export const MerchantUpdateResult = z.object({
  merchant_id: z.string(),
  /** `--name`: the canonical name before and after; the old one is kept as an alias. */
  before: z.string().optional(),
  after: z.string().optional(),
  alias_conflict: MerchantAliasConflict.optional(),
  alias_added: z.string().optional(),
  default_account: z.string().optional(),
});
export type MerchantUpdateResult = z.infer<typeof MerchantUpdateResult>;

/** `merchants set-default`, setting or clearing; `after` is null on `--clear`. */
export const MerchantDefaultResult = z.object({
  merchant_id: z.string(),
  before: z.string().nullable(),
  after: z.string().nullable(),
});
export type MerchantDefaultResult = z.infer<typeof MerchantDefaultResult>;

export const MerchantMergeResult = z.object({
  from: z.string(),
  to: z.string(),
  moved_transactions: z.number().int(),
  moved_aliases: z.number().int(),
  /** Present only when the destination had no default account and adopted the source's. */
  adopted_default_account: z.string().optional(),
});
export type MerchantMergeResult = z.infer<typeof MerchantMergeResult>;

export const MERCHANTS_CONTRACTS = {
  "merchants list": { lines: [Merchant, CappedSummary], summary: "capped" },
  "merchants resolve": { lines: [MerchantResolveMiss, MerchantResolveHit] },
  "merchants upsert": { lines: [MerchantUpsertResult] },
  "merchants update": { lines: [MerchantUpdateResult] },
  "merchants set-default": { lines: [MerchantDefaultResult] },
  "merchants merge": { lines: [MerchantMergeResult] },
} as const satisfies Record<string, CommandContract>;
