/** The local calendar date: a user at 01:00 local gets today, not the UTC day. */
export function todayIso(): string {
  const now = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** ISO calendar date shape (YYYY-MM-DD). Shape only, no calendar validity check. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
