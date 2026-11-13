import { describe, expect, it } from "vitest";
import { OPENERS, spawnOpener } from "./open.js";

describe("open", () => {
  it("launches an executable on each platform, never a shell builtin such as `start`", () => {
    expect(OPENERS).toEqual({ darwin: "open", win32: "explorer", linux: "xdg-open" });
  });

  it("resolves a missing opener to its spawn error instead of rejecting", async () => {
    expect(await spawnOpener("oled-no-such-opener", ".")).toMatch(/ENOENT/);
  });
});
