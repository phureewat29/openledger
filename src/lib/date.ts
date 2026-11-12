const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The local calendar date: a user at 01:00 local gets that day, not the UTC one. */
export function localISODate(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** `YYYYMMDD-HHMMSS` in local time. */
export function localStamp(date: Date): string {
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad2).join("");
  return `${localISODate(date).replaceAll("-", "")}-${time}`;
}

/** ISO calendar date shape (YYYY-MM-DD). Shape only, no calendar validity check. */
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
