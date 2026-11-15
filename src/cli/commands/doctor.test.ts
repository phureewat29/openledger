import { describe, it, expect } from "vitest";
import { err, ok } from "../../lib/result.js";
import { ocrEngineCheck } from "./doctor.js";

describe("ocrEngineCheck", () => {
  it("passes with no detail once the engine loads", () => {
    expect(ocrEngineCheck(ok({}))).toEqual({ name: "ocr_engine", ok: true });
  });

  it("fails with the load error and the reinstall command", () => {
    expect(ocrEngineCheck(err("models/ocr/det.onnx: ENOENT"))).toEqual({
      name: "ocr_engine",
      ok: false,
      detail: "models/ocr/det.onnx: ENOENT: reinstall the CLI (npm install -g @aquartier/openledger)",
    });
  });
});
