import { statSync } from "node:fs";
import { expect } from "vitest";

/** Windows keeps no POSIX permission bits, so the mode is asserted only elsewhere. */
export function expectMode(path: string, mode: number): void {
  if (process.platform === "win32") return;
  expect(statSync(path).mode & 0o777).toBe(mode);
}
