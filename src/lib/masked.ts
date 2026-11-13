/**
 * Canonical key behind both the stored form (`accounts.account_number_masked`)
 * and the fuzzy matcher, so `••7652`, `••7652-0` and `76520` resolve alike.
 */

/** Characters statements use to blank the hidden middle of an account number. */
const MASK_CHARS = "Xx•*…";

/** Splits after the LAST mask char, so a masked run isn't mistaken for a check-digit separator. */
export function tailAfterMask(s: string): string {
  const lastAt = Math.max(...[...MASK_CHARS].map((ch) => s.lastIndexOf(ch)));
  return lastAt === -1 ? s : s.slice(lastAt + 1);
}

/** Tolerates a trailing check digit (`xxx-7652-0` and `xxx-7652` resolve alike); digits before the mask are stripped first. */
export function accountNumberKey(raw: string | null | undefined): string {
  const tail = tailAfterMask(String(raw ?? ""));
  const digits = tail.replace(/\D+/g, "");
  if (!digits) return "";
  const core = digits.length >= 5 ? digits.slice(0, -1) : digits;
  return core.slice(-4);
}

/**
 * Normalizes for storage so a trailing check digit can't split one account
 * into two. Preserves the leading mask prefix, defaulting to `••` when there isn't one.
 */
export function normalizeMaskedAccountNumber(
  masked: string | null | undefined,
): string | null {
  if (masked == null) return null;
  const s = String(masked);
  const key = accountNumberKey(s);
  if (!key) return s;
  const prefix = /^\D+/.exec(s)?.[0] ?? "••";
  return prefix + key;
}
