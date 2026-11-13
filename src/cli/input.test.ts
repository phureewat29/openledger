import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readStdinBatch } from "./input.js";
import { tempDir } from "../../fixtures/sandbox.js";

describe("readStdinBatch: --input decoding", () => {
  it("decodes UTF-16LE and BOM'd UTF-8 files (PowerShell redirect defaults)", async () => {
    const dir = tempDir("oled-output-");
    const utf16 = resolve(dir, "utf16.json");
    writeFileSync(
      utf16,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[{"a":1}]', "utf16le")]),
    );
    await expect(readStdinBatch(utf16)).resolves.toEqual([{ a: 1 }]);

    const bom8 = resolve(dir, "bom8.json");
    writeFileSync(bom8, '\uFEFF[{"b":2}]');
    await expect(readStdinBatch(bom8)).resolves.toEqual([{ b: 2 }]);
  });
});
