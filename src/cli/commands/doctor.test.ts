import { basename, dirname, sep } from "node:path";
import { describe, it, expect } from "vitest";
import { err, ok } from "../../lib/result.js";
import { PACKAGE_ROOT } from "../../lib/version.js";
import { ocrEngineCheck } from "./doctor.js";

describe("ocrEngineCheck", () => {
  it("passes with no detail once the engine loads", () => {
    expect(ocrEngineCheck(ok({}), "/home/x")).toEqual({ name: "ocr_engine", ok: true });
  });

  it("fails with the load error and the reinstall command", () => {
    expect(ocrEngineCheck(err("engine file: ENOENT"), "/home/x")).toEqual({
      name: "ocr_engine",
      ok: false,
      detail: "engine file: ENOENT: reinstall the CLI (npm install -g @aquartier/openledger)",
    });
  });

  it("shows the install path home-relative", () => {
    const home = dirname(PACKAGE_ROOT);
    const check = ocrEngineCheck(err(`${PACKAGE_ROOT}/models: ENOENT`), home);
    expect(check.detail).toContain(`~${sep}${basename(PACKAGE_ROOT)}`);
    expect(check.detail).not.toContain(home + sep);
  });
});
