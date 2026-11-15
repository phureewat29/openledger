import { chmodSync } from "node:fs";

/**
 * Owner-only mode on files holding financial or personal data; a refusal throws.
 * No-op on Windows, and for a sidecar that never materialized.
 */
export function chmod600(path: string): void {
  if (process.platform === "win32") return;
  try {
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
