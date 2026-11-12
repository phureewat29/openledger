import { afterEach, describe, expect, it, vi } from "vitest";
import { localISODate, localStamp } from "./date.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("localISODate", () => {
  it("returns the local calendar date, not the UTC one", () => {
    vi.stubEnv("TZ", "Asia/Bangkok");
    // 01:00 on 2026-03-05 in Bangkok (UTC+7) is still 2026-03-04 in UTC.
    expect(localISODate(new Date("2026-03-04T18:00:00Z"))).toBe("2026-03-05");
  });

  it("zero-pads month and day", () => {
    vi.stubEnv("TZ", "UTC");
    expect(localISODate(new Date("2026-01-02T12:00:00Z"))).toBe("2026-01-02");
  });
});

describe("localStamp", () => {
  it("is the local date and time, fixed width", () => {
    vi.stubEnv("TZ", "Asia/Bangkok");
    expect(localStamp(new Date("2026-03-04T18:04:05Z"))).toBe("20260305-010405");
  });
});
