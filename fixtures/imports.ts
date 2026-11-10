import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface ImportRef {
  specifier: string;
  isTypeOnly: boolean;
  isDynamic: boolean;
}

export interface SourceFile {
  path: string;
  text: string;
  imports: ImportRef[];
}

// Anchored at line start so a comment or string mentioning "import" never matches.
const STATIC_RE = /^\s*(?:import|export)\s+(type\s+)?([^;=()]*?)\s*from\s*["']([^"']+)["']/gm;
const SIDE_EFFECT_RE = /^\s*import\s+["']([^"']+)["']/gm;
const DYNAMIC_RE = /(typeof\s+)?\bimport\(\s*["']([^"']+)["']\s*\)/g;

/** `import { type A, type B }` is elided from the emitted JS just like `import type`. */
function isAllTypeSpecifiers(clause: string): boolean {
  const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (!named) return false;
  const specifiers = named[1].split(",").map((s) => s.trim()).filter(Boolean);
  return specifiers.length > 0 && specifiers.every((s) => s.startsWith("type "));
}

export function importsOf(text: string): ImportRef[] {
  const statics = [...text.matchAll(STATIC_RE)].map((m) => ({
    specifier: m[3],
    isTypeOnly: !!m[1] || isAllTypeSpecifiers(m[2]),
    isDynamic: false,
  }));
  const sideEffects = [...text.matchAll(SIDE_EFFECT_RE)].map((m) => ({
    specifier: m[1],
    isTypeOnly: false,
    isDynamic: false,
  }));
  const dynamics = [...text.matchAll(DYNAMIC_RE)].map((m) => ({
    specifier: m[2],
    isTypeOnly: !!m[1],
    isDynamic: true,
  }));
  return [...statics, ...sideEffects, ...dynamics];
}

export function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

export function isTestFile(path: string): boolean {
  return /\.test(-d)?\.ts$/.test(path);
}

export function readSources(dir: string): SourceFile[] {
  return listTsFiles(dir).map((path) => {
    const text = readFileSync(path, "utf8");
    return { path, text, imports: importsOf(text) };
  });
}

/** The `.ts` file a relative `./x.js` specifier names, or null for a package. */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  return resolve(dirname(fromFile), specifier).replace(/\.js$/, ".ts");
}
