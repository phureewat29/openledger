import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod600 } from "./perms.js";
import { removeTree } from "../../fixtures/sandbox.js";

const dirs: string[] = [];

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oled-perms-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    await removeTree(dir);
  }
});

describe("chmod600", () => {
  // chmod600 is a no-op on Windows, which keeps no POSIX mode bits.
  it.skipIf(process.platform === "win32")("narrows an existing file to owner-only", () => {
    const path = join(scratchDir(), "secret.json");
    writeFileSync(path, "{}", { mode: 0o644 });
    chmod600(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("ignores a path that never materialized, as a refused WAL sidecar does", () => {
    expect(() => chmod600(join(scratchDir(), "absent-wal"))).not.toThrow();
  });

  it("propagates a refusal, so a broken 0600 promise cannot pass silently", (ctx) => {
    // Root and Windows cannot be denied search permission; report that as skipped, never as passed.
    ctx.skip(process.platform === "win32" || process.getuid?.() === 0, "needs an unprivileged posix uid");
    const dir = scratchDir();
    const path = join(dir, "locked.json");
    writeFileSync(path, "{}");
    // No search permission on the parent: the chmod is refused (EACCES), not merely absent.
    chmodSync(dir, 0o000);
    expect(() => chmod600(path)).toThrow(/EACCES/);
  });
});
