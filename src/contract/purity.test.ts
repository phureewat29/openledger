import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This file lives in src/contract/, so the repo root is two levels up.
const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const srcRoot = join(repoRoot, "src");
const contractRoot = join(srcRoot, "contract");

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listTsFiles(full, out);
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

interface ImportRef {
  isTypeOnly: boolean;
  specifier: string;
}

// Matches both single-line and multi-line `import {...} from "...";`, which this
// repo's source uses often enough that a single-line-only regex would miss them.
const IMPORT_RE = /import\s+(type\s+)?[\s\S]*?from\s+["']([^"']+)["']/g;

function importsOf(source: string): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const m of source.matchAll(IMPORT_RE)) refs.push({ isTypeOnly: !!m[1], specifier: m[2] });
  return refs;
}

/** The absolute path a relative specifier resolves to, or null when it can't reach contract/. */
function resolvesIntoContract(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = resolve(dirname(fromFile), specifier);
  return resolved.startsWith(contractRoot + sep) ? resolved : null;
}

const ALLOWED_VALUE_IMPORTS = new Set([join(contractRoot, "exit.js"), join(contractRoot, "version.js")]);

describe("contract module purity (schemas must never load on the CLI startup path)", () => {
  it("exit.ts and version.ts import nothing: the only contract modules src/ may value-import", () => {
    for (const name of ["exit.ts", "version.ts"]) {
      const source = readFileSync(join(contractRoot, name), "utf8");
      expect(importsOf(source), `${name} must not import anything`).toEqual([]);
    }
  });

  it("no file outside src/contract/ value-imports a schema module: only exit.js/version.js, or `import type`", () => {
    const problems: string[] = [];
    for (const file of listTsFiles(srcRoot)) {
      if (file.startsWith(contractRoot + sep)) continue; // contract/ may import its own siblings freely
      const source = readFileSync(file, "utf8");
      for (const { isTypeOnly, specifier } of importsOf(source)) {
        const resolved = resolvesIntoContract(file, specifier);
        if (!resolved || isTypeOnly || ALLOWED_VALUE_IMPORTS.has(resolved)) continue;
        problems.push(`${file}: value-imports "${specifier}"`);
      }
    }
    expect(problems).toEqual([]);
  });
});
