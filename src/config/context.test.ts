import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createContextTemplate, readContext } from "./context.js";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), "oled-context-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readContext", () => {
  it("reads a missing file as empty context", () => {
    expect(readContext(join(dir, "absent.md"))).toEqual({ ok: true, value: "" });
  });

  it("normalizes CRLF so the redactor's `\\n`-anchored sections still match", () => {
    const path = join(dir, "crlf.md");
    writeFileSync(path, "## Family\r\n- Partner: Corgi\r\n");
    expect(readContext(path)).toEqual({ ok: true, value: "## Family\n- Partner: Corgi\n" });
  });

  it("reports a file that exists but cannot be read as an error, never as empty", () => {
    // A directory at the path is the portable stand-in for EACCES: it fails even as root.
    const result = readContext(dir);
    expect(result.ok).toBe(false);
  });

  it.skipIf(process.platform === "win32")("reports a dangling symlink as an error, never as empty", () => {
    const path = join(dir, "dangling.md");
    symlinkSync(join(dir, "moved-away.md"), path);
    expect(readContext(path).ok).toBe(false);
  });
});

describe("createContextTemplate", () => {
  it.skipIf(process.platform === "win32")(
    "never writes through a dangling symlink, where a fresh template would stand in for the moved file",
    () => {
      const target = join(dir, "template-target.md");
      const path = join(dir, "template-link.md");
      symlinkSync(target, path);
      createContextTemplate(path, "Alpaca");
      expect(existsSync(target)).toBe(false);
    },
  );
});
