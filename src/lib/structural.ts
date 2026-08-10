/** `<type>:<segment>` id suffix, after the currency head, of each ledger's system-owned accounts. */
export const STRUCTURAL_SUFFIX = {
  uncategorized: "expense:uncategorized",
  adjustments: "equity:adjustments",
  opening: "equity:opening",
} as const satisfies Record<string, `${"expense" | "equity"}:${string}`>;
