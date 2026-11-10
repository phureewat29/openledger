import { describe, it, expect } from "vitest";
import { isBuiltin } from "node:module";
import { basename, join, relative, sep } from "node:path";
import { repoRoot } from "../fixtures/sandbox.js";
import { isTestFile, readSources, resolveRelative, type ImportRef, type SourceFile } from "../fixtures/imports.js";

const SRC = join(repoRoot, "src");
const PRODUCTION = readSources(SRC).filter((file) => !isTestFile(file.path));

const rel = (path: string): string => relative(SRC, path).split(sep).join("/");
const under = (path: string, dir: string): boolean => rel(path).startsWith(`${dir}/`);
const isBoundary = (path: string): boolean => /(^|-)cli\.ts$/.test(basename(path)) || under(path, "cli");
const isStore = (path: string): boolean => /(^|-)queries\.ts$/.test(basename(path));

const SHELL = ["cli/output.ts", "cli/errors.ts", "cli/input.ts", "cli/format.ts"];
const NATIVE_LOADER: Record<string, string> = { libsql: "db/connection.ts", mupdf: "extract/pdf.ts" };
const LIB_PACKAGES = new Set(["es-toolkit", "zod"]);

type Rule = (file: SourceFile, ref: ImportRef, target: string | null) => boolean;

function violations(files: SourceFile[], isViolation: Rule): string[] {
  return files.flatMap((file) =>
    file.imports
      .filter((ref) => isViolation(file, ref, resolveRelative(file.path, ref.specifier)))
      .map((ref) => `${rel(file.path)}: imports "${ref.specifier}"`),
  );
}

// `.exec(` on a regex is not SQL: a regex literal or a `*RE` constant is the receiver.
const SQL_CALL_RE = /(\w+|\/[a-z]*)\.(prepare|exec|pragma)\(/g;

function sqlCalls(text: string): string[] {
  return [...text.matchAll(SQL_CALL_RE)]
    .filter(([, receiver, method]) => method !== "exec" || !(receiver.startsWith("/") || /RE$/.test(receiver)))
    .map(([call]) => call);
}

// Runtime edges only: type-only imports are erased (extract/cards has a type-only cycle).
function findCycle(files: SourceFile[]): string[] | null {
  const edges = new Map(
    files.map((file) => [
      file.path,
      file.imports
        .filter((ref) => !ref.isTypeOnly)
        .map((ref) => resolveRelative(file.path, ref.specifier))
        .filter((target): target is string => target !== null),
    ]),
  );
  const done = new Set<string>();
  const visit = (node: string, path: string[]): string[] | null => {
    if (path.includes(node)) return [...path.slice(path.indexOf(node)), node];
    if (done.has(node)) return null;
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next, [...path, node]);
      if (cycle) return cycle;
    }
    done.add(node);
    return null;
  };
  for (const node of edges.keys()) {
    const cycle = visit(node, []);
    if (cycle) return cycle.map(rel);
  }
  return null;
}

describe("module boundaries", () => {
  it("sees the production tree's imports", () => {
    const entry = PRODUCTION.find((file) => rel(file.path) === "cli/index.ts");
    expect(entry?.imports.length).toBeGreaterThan(0);
  });

  it("src/lib imports only node built-ins, es-toolkit, zod and src/lib", () => {
    const lib = PRODUCTION.filter((file) => under(file.path, "lib"));
    expect(
      violations(lib, (_, ref, target) =>
        target ? !under(target, "lib") : !isBuiltin(ref.specifier) && !LIB_PACKAGES.has(ref.specifier),
      ),
    ).toEqual([]);
  });

  it("libsql and mupdf load only through their one dynamic import", () => {
    expect(
      violations(PRODUCTION, (file, ref) => {
        const loader = NATIVE_LOADER[ref.specifier];
        if (!loader) return false;
        if (ref.isDynamic) return rel(file.path) !== loader;
        return !ref.isTypeOnly;
      }),
    ).toEqual([]);
  });

  it("nothing below the CLI boundary imports src/cli or a slice's cli module", () => {
    const core = PRODUCTION.filter((file) => !isBoundary(file.path));
    expect(violations(core, (_, __, target) => target !== null && isBoundary(target))).toEqual([]);
  });

  it("the shell imports no slice", () => {
    const shell = PRODUCTION.filter((file) => SHELL.includes(rel(file.path)));
    expect(shell).toHaveLength(SHELL.length);
    const allowed = (target: string): boolean =>
      SHELL.includes(rel(target)) || ["lib", "db", "contract"].some((dir) => under(target, dir));
    expect(violations(shell, (_, __, target) => target !== null && !allowed(target))).toEqual([]);
  });

  it("SQL runs only in *queries.ts modules and src/db", () => {
    const outside = PRODUCTION.filter((file) => !isStore(file.path) && !under(file.path, "db"));
    const found = outside.flatMap((file) => sqlCalls(file.text).map((call) => `${rel(file.path)}: ${call}`));
    expect(found).toEqual([]);
  });

  it("the runtime module graph is acyclic", () => {
    expect(findCycle(PRODUCTION)).toBeNull();
  });
});
