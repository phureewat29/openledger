import { describe, it, expect } from "vitest";
import { join, sep } from "node:path";
import { repoRoot } from "../../fixtures/sandbox.js";
import { readSources, resolveRelative } from "../../fixtures/imports.js";

const contractRoot = join(repoRoot, "src", "contract");
const SOURCES = readSources(join(repoRoot, "src"));
const inContract = (path: string): boolean => path.startsWith(contractRoot + sep);

const LEAF_MODULES = ["exit", "version", "enums"];
const ALLOWED_VALUE_IMPORTS = new Set(LEAF_MODULES.map((name) => join(contractRoot, `${name}.ts`)));

describe("contract module purity (schemas must never load on the CLI startup path)", () => {
  it("exit.ts, version.ts and enums.ts import nothing: the only contract modules src/ may value-import", () => {
    for (const path of ALLOWED_VALUE_IMPORTS) {
      const leaf = SOURCES.find((file) => file.path === path);
      expect(leaf?.imports, `${path} must not import anything`).toEqual([]);
    }
  });

  it("no file outside src/contract/ value-imports a schema module: only exit.js, version.js, enums.js, or `import type`", () => {
    const problems = SOURCES.filter((file) => !inContract(file.path)).flatMap((file) =>
      file.imports
        .filter((ref) => {
          const target = resolveRelative(file.path, ref.specifier);
          return target !== null && inContract(target) && !ref.isTypeOnly && !ALLOWED_VALUE_IMPORTS.has(target);
        })
        .map((ref) => `${file.path}: value-imports "${ref.specifier}"`),
    );
    expect(problems).toEqual([]);
  });
});
