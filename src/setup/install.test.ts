import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_SKILLS_DIR, installSkill, installedVersion, skillMd } from "./install.js";
import { getVersion } from "../lib/version.js";
import {
  createSandbox,
  makeRunCLI,
  type CLIRunner,
  type Sandbox,
} from "../../fixtures/sandbox.js";
import { tempDir } from "../../fixtures/test-cleanup.js";

// No yaml dep: key: value pairs between the fences.
function parseFrontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  expect(m, "SKILL.md should start with a --- frontmatter block").toBeTruthy();
  const out: Record<string, string> = {};
  for (const line of m![1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

describe("skillMd (checked-in skills/openledger/SKILL.md)", () => {
  it("carries name/description frontmatter and no version key", () => {
    const fm = parseFrontmatter(skillMd());
    expect(fm.name).toBe("openledger");
    expect(fm.description.length).toBeGreaterThan(20);
    expect(fm.version).toBeUndefined();
  });

  it("defers usage guidance to the CLI's own help", () => {
    const skill = skillMd();
    expect(skill).toContain("oled <noun> --help");
    expect(skill).toContain("--json");
  });

  it("keeps banned vocabulary out", () => {
    expect(skillMd()).not.toContain("record ");
  });

  it("carries the two facts a model cannot infer from output alone", () => {
    const skill = skillMd();
    expect(skill).toContain("has_more");
    expect(skill).toContain("never add two currencies");
  });

  it("carries the Setup bootstrap section (install + first-run for a bare environment)", () => {
    const skill = skillMd();
    expect(skill).toContain("## Setup");
    expect(skill).toContain("node --version");
    expect(skill).toContain("npm install -g @aquartier/openledger");
  });
});

// For --dir cases, which never resolve against the roots; a stray default install fails loudly here.
const UNUSED_ROOTS = { cwd: "/nonexistent/oled-cwd", home: "/nonexistent/oled-home" };

describe("installSkill: target resolution", () => {
  it("--dir D is the skills dir itself: the pack lands at D/openledger, nothing appended", () => {
    const dir = tempDir("oled-install-dir-");
    const target = installSkill({ dir }, UNUSED_ROOTS);
    const skillDir = join(dir, "openledger");
    expect(target).toEqual({ ok: true, path: skillDir, version: getVersion() });
    expect(existsSync(join(skillDir, "SKILL.md"))).toBe(true);
    expect(installedVersion(dir)).toBe(getVersion());
    const fm = parseFrontmatter(readFileSync(join(skillDir, "SKILL.md"), "utf8"));
    expect(fm.name).toBe("openledger");
  });

  it("--dir <host skills dir> does not append a second skills segment", () => {
    const base = tempDir("oled-install-host-dir-");
    const dir = join(base, ".claude", "skills");
    const target = installSkill({ dir }, UNUSED_ROOTS);
    expect(target).toMatchObject({ ok: true, path: join(base, ".claude", "skills", "openledger") });
    expect(existsSync(join(dir, "openledger", "SKILL.md"))).toBe(true);
  });

  it("a relative --dir resolves against the cwd it is given", () => {
    const cwd = tempDir("oled-install-relative-");
    const target = installSkill({ dir: "skills" }, { cwd, home: cwd });
    expect(target).toMatchObject({ ok: true, path: join(cwd, "skills", "openledger") });
  });

  it(`defaults to ${DEFAULT_SKILLS_DIR} under the cwd, or under home with --global`, () => {
    const cwd = tempDir("oled-install-default-cwd-");
    const home = tempDir("oled-install-default-home-");
    const local = installSkill({}, { cwd, home });
    expect(local).toEqual({
      ok: true,
      path: join(cwd, ...DEFAULT_SKILLS_DIR.split("/"), "openledger"),
      version: getVersion(),
    });
    const global = installSkill({ global: true }, { cwd, home });
    expect(global).toMatchObject({ ok: true, path: join(home, ...DEFAULT_SKILLS_DIR.split("/"), "openledger") });
    expect(installedVersion(join(home, DEFAULT_SKILLS_DIR))).toBe(getVersion());
  });
});

describe("installSkill: version guard", () => {
  it("is idempotent when re-installed at the same version", () => {
    const dir = tempDir("oled-install-idem-");
    installSkill({ dir }, UNUSED_ROOTS);
    expect(installSkill({ dir }, UNUSED_ROOTS)).toMatchObject({ ok: true });
    expect(installedVersion(dir)).toBe(getVersion());
  });

  it("refuses a version clash without --force, leaving the pack untouched, and overwrites with it", () => {
    const dir = tempDir("oled-install-clash-");
    installSkill({ dir }, UNUSED_ROOTS);
    writeFileSync(join(dir, "openledger", "VERSION"), "0.0.1\n");

    const clash = installSkill({ dir }, UNUSED_ROOTS);
    expect(clash).toMatchObject({
      ok: false,
      reason: "version_mismatch",
      path: join(dir, "openledger"),
      installedVersion: "0.0.1",
      cliVersion: getVersion(),
    });
    expect(installedVersion(dir)).toBe("0.0.1");

    expect(installSkill({ dir, force: true }, UNUSED_ROOTS)).toMatchObject({ ok: true });
    expect(installedVersion(dir)).toBe(getVersion());
  });
});

describe("installedVersion", () => {
  it("is null for a skills dir with no pack", () => {
    const dir = tempDir("oled-install-none-");
    expect(installedVersion(dir)).toBeNull();
  });
});

let sandbox: Sandbox;
let runCLI: CLIRunner;

beforeAll(() => {
  sandbox = createSandbox("oled-setup-cli-it-");
  runCLI = makeRunCLI(sandbox);
});

afterAll(() => {
  sandbox.cleanup();
});

describe("setup CLI (subprocess)", () => {
  it(
    "--print emits raw SKILL.md with parseable frontmatter",
    async () => {
      const res = await runCLI(["setup", "--print"]);
      expect(res.code).toBe(0);
      expect(res.stdout.startsWith("---\n")).toBe(true);
      const fm = parseFrontmatter(res.stdout);
      expect(fm.name).toBe("openledger");
    },
    30000,
  );

  it(
    "--dir installs the pack and reports its path as JSON",
    async () => {
      const dir = tempDir("oled-cli-install-");
      const res = await runCLI(["setup", "--dir", dir, "--json"]);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout.trim());
      expect(parsed.installed[0]).toMatchObject({ path: join(dir, "openledger") });
      expect(existsSync(join(dir, "openledger", "SKILL.md"))).toBe(true);
    },
    30000,
  );

  it(
    "--global and --dir together is a usage error",
    async () => {
      const dir = tempDir("oled-cli-install-conflict-");
      const res = await runCLI(["setup", "--global", "--dir", dir, "--json"]);
      expect(res.code).toBe(2); // EXIT.USAGE
      expect(JSON.parse(res.stderr.trim()).error.code).toBe("E_USAGE");
    },
    30000,
  );

  it(
    "--global installs under the shared home skills dir",
    async () => {
      const res = await runCLI(["setup", "--global", "--json"]);
      expect(res.code).toBe(0);
      const parsed = JSON.parse(res.stdout.trim());
      const expected = join(sandbox.home, ".agents", "skills", "openledger");
      expect(parsed.installed[0]).toMatchObject({ path: expected });
      expect(existsSync(join(expected, "SKILL.md"))).toBe(true);
    },
    30000,
  );
});
