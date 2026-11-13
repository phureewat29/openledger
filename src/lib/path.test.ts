import { describe, it, expect } from "vitest";
import { resolve, sep } from "node:path";
import { expandHome, homeRelative, relativizeHomeIn } from "./path.js";

// Deliberately not the real home: both directions must honour the home they are given.
const HOME = resolve(sep, "home", "alpaca");

describe("expandHome / homeRelative", () => {
  it("round-trips: what homeRelative prints, expandHome accepts back", () => {
    const abs = resolve(HOME, "statements", "a.pdf");
    const printed = homeRelative(abs, HOME);
    expect(printed).toBe("~" + sep + "statements" + sep + "a.pdf");
    expect(expandHome(printed, HOME)).toBe(abs);
  });

  it("expands bare `~` and leaves non-tilde and non-home paths alone", () => {
    expect(expandHome("~", HOME)).toBe(HOME);
    expect(expandHome("plain/relative", HOME)).toBe("plain/relative");
    expect(homeRelative("disk I/O error", HOME)).toBe("disk I/O error");
    expect(homeRelative(resolve(sep, "srv", "x"), HOME)).toBe(resolve(sep, "srv", "x"));
  });

  it("does not collapse a sibling that merely shares the home's name as a prefix", () => {
    const sibling = resolve(sep, "home", "alpaca-2", "x");
    expect(homeRelative(sibling, HOME)).toBe(sibling);
  });

  it.skipIf(process.platform === "win32")(
    "leaves `~\\x` alone on POSIX, where backslash is a filename byte",
    () => {
      expect(expandHome("~\\x", HOME)).toBe("~\\x");
    },
  );

  it.runIf(process.platform === "win32")(
    "collapses a Windows home spelled in another case or with forward slashes",
    () => {
      const abs = resolve(HOME, "statements", "a.pdf");
      expect(homeRelative(abs.toUpperCase(), HOME)).toBe(`~${sep}STATEMENTS${sep}A.PDF`);
      expect(homeRelative(abs.replaceAll(sep, "/"), HOME)).toBe(`~${sep}statements${sep}a.pdf`);
    },
  );

  it("relativizes every occurrence of the path inside prose", () => {
    const abs = resolve(HOME, "ledger", "db.sqlite");
    const shown = homeRelative(abs, HOME);
    expect(relativizeHomeIn(`open ${abs}: ${abs} is locked`, abs, HOME)).toBe(`open ${shown}: ${shown} is locked`);
    expect(relativizeHomeIn("disk I/O error", abs, HOME)).toBe("disk I/O error");
  });
});
