import { createHash, randomUUID } from "crypto";

const hash16 = (material: string): string =>
  createHash("sha256").update(material).digest("hex").slice(0, 16);

/**
 * `tx:` + sha256("<hash>|<page>|<row>[|<leg>]"), deterministic, so re-ingesting the
 * same file is idempotent. Omitting `legIndex` makes the hash match `deriveGroupId`'s.
 */
export function deriveTransactionId(
  fileHash: string,
  page: number,
  rowIndex: number,
  legIndex?: number,
): string {
  const base = `${fileHash}|${page}|${rowIndex}`;
  return "tx:" + hash16(legIndex !== undefined ? `${base}|${legIndex}` : base);
}

/** `tg:` + the same hash as legless `deriveTransactionId(fileHash, page, rowIndex)`. */
export function deriveGroupId(fileHash: string, page: number, rowIndex: number): string {
  return "tg:" + hash16(`${fileHash}|${page}|${rowIndex}`);
}

/**
 * Account ids are `<currency>:<type>(:<segment>)*`, lowercase. Mirrors the
 * `upper(substr(a.id,1,3))` projection (accounts/queries.ts) and the
 * trigger's `substr(id,1,4)` compare — change them together.
 */
export function currencyOf(accountId: string): string {
  return accountId.slice(0, 3).toUpperCase();
}

/** "" when the id has no second segment. */
export function typeFromId(accountId: string): string {
  return accountId.split(":")[1] ?? "";
}

/** True when the id opens with a lowercase 3-letter currency head; whether that ledger exists is separate. */
export function isLedgerScopedId(accountId: string): boolean {
  return /^[a-z]{3}:/.test(accountId);
}

/** Dash where every sibling uses a colon: the id doubles as a cache directory
 *  name, and ':' is illegal in an NTFS path component. */
export function newFileId(): string {
  return `sf-${randomUUID()}`;
}

/** Groups a commit run's raised questions. */
export function newBatchId(): string {
  return `ib:${randomUUID()}`;
}

/** For a row without deterministic source coordinates. */
export function newTransactionId(): string {
  return `tx:${randomUUID()}`;
}

export function newGroupId(): string {
  return `tg:${randomUUID()}`;
}

/** `<type>:<segment>` id suffix, after the currency head, of each ledger's system-owned accounts. */
export const STRUCTURAL_SUFFIX = {
  uncategorized: "expense:uncategorized",
  adjustments: "equity:adjustments",
  opening: "equity:opening",
} as const satisfies Record<string, `${"expense" | "equity"}:${string}`>;
