/**
 * ACCOUNT_TYPES, FILE_STATUSES and NOTE_CATEGORIES mirror CHECK constraints in db/migrations (pinned by schema.test.ts).
 */
export const ACCOUNT_TYPES = ["asset", "liability", "income", "expense", "equity"] as const;

/** At rest only; `ingest list` adds the display states `new` and `unreadable`. */
export const FILE_STATUSES = ["pending", "ingested", "failed"] as const;

export const NOTE_CATEGORIES = ["rule", "preference", "fact"] as const;

export const INSTITUTION_KINDS = [
  "bank",
  "card_issuer",
  "wallet",
  "payment_rail",
  "broker",
  "crypto_exchange",
  "insurer",
  "gov",
  "telco",
  "utility",
] as const;
