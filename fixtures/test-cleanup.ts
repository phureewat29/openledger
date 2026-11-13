import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { createSandbox, type Sandbox } from "./sandbox.js";

/** A throwaway directory under the OS tmpdir, removed when the current test ends. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A sandbox removed when the current test ends; one shared from `beforeAll` comes from `createSandbox`. */
export function createTestSandbox(prefix: string): Sandbox {
  const sandbox = createSandbox(prefix);
  onTestFinished(sandbox.cleanup);
  return sandbox;
}
