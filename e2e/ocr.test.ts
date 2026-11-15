import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSandbox, makeRunCLI, parseOne, repoRoot, type CLIRunner, type Sandbox } from "../fixtures/sandbox.js";
import { scanPDF } from "../fixtures/pdf.js";

let sandbox: Sandbox;
let runCLI: CLIRunner;

const golden = (name: string): { text: string } =>
  JSON.parse(readFileSync(join(repoRoot, "fixtures", "ocr", `${name}.json`), "utf8"));

beforeAll(async () => {
  sandbox = createSandbox("oled-e2e-ocr-");
  runCLI = makeRunCLI(sandbox, "dist");
  copyFileSync(join(repoRoot, "fixtures", "ocr", "statement.png"), join(sandbox.dataDir, "statement.png"));
  writeFileSync(join(sandbox.dataDir, "scan.pdf"), scanPDF());
  const init = await runCLI(["config", "--init", "--json"]);
  expect(init.code, init.stderr).toBe(0);
});

afterAll(() => sandbox.cleanup());

describe("built-in OCR through the packaged CLI", () => {
  it("doctor loads the bundled engine", async () => {
    const res = await runCLI(["doctor", "--json"]);
    const { checks } = parseOne(res.stdout) as { checks: { name: string; ok: boolean }[] };
    expect(checks.find((check) => check.name === "ocr_engine"), res.stdout).toMatchObject({ ok: true });
  });

  it("reads a photo of a statement exactly as the vendor runtime does", async () => {
    const res = await runCLI(["ingest", "prepare", "statement.png", "--json"]);
    expect(res.code, res.stderr).toBe(0);
    const result = parseOne(res.stdout);
    expect(result).toMatchObject({ source: "ocr", text_layer: "none", page_count: 1 });
    expect(readFileSync(result.document, "utf8")).toBe(`--- page 1 ---\n${golden("statement").text}\n`);
  });

  it("routes an image-only PDF through OCR", async () => {
    const res = await runCLI(["ingest", "prepare", "scan.pdf", "--json"]);
    expect(res.code, res.stderr).toBe(0);
    expect(parseOne(res.stdout)).toMatchObject({ source: "ocr", text_layer: "none", page_count: 1 });
  });
});
