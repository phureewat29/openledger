// A type, not a message shape, so rewording a message can't move the exit
// code; import-free so the CLI can `instanceof` it without loading libsql.
export class DBNotReadyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DBNotReadyError";
  }
}

/** Another process held the ledger's write lock at open; nothing ran, so the same command is safe to re-run. */
export class DBBusyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DBBusyError";
  }
}

/** context.md exists but can't be read; redacting without its terms would print the names it lists. */
export class ContextUnreadableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextUnreadableError";
  }
}

/** libsql carries SQLite's error family on `code`; a plain Error (an unopenable path) has none. */
export function sqliteErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

// SQLITE_BUSY, SQLITE_BUSY_RECOVERY and SQLITE_BUSY_SNAPSHOT all mean locked now, fine later.
export function isBusyError(err: unknown): boolean {
  return sqliteErrorCode(err).startsWith("SQLITE_BUSY");
}
