import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../fixtures/sandbox.js";

// globalSetup (build.setup.ts) builds dist/ (including the contract's
// declaration-only pass) before any case in this suite runs.
const contractDts = resolve(repoRoot, "dist", "contract", "index.d.ts");
const contractEntry = resolve(repoRoot, "dist", "contract", "index.js");

describe("packaged @aquartier/openledger/contract (dist)", () => {
  it("ships a declaration file beside the built JS", () => {
    expect(existsSync(contractDts)).toBe(true);
  });

  it("the built module exposes CONTRACT_VERSION and the full EXIT table", async () => {
    const mod = await import(pathToFileURL(contractEntry).href);
    expect(mod.CONTRACT_VERSION).toBe(1);
    expect(mod.EXIT.BUSY).toBe(8);
  });
});
