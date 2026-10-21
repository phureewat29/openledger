import { afterEach, describe, expect, it, vi } from "vitest";
import { todayIso } from "./date.js";

describe("todayIso", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns the local calendar date, not the UTC one", () => {
    vi.stubEnv("TZ", "Asia/Bangkok");
    vi.useFakeTimers();
    // 01:00 on 2026-03-05 in Bangkok (UTC+7) is still 2026-03-04 in UTC.
    vi.setSystemTime(new Date("2026-03-04T18:00:00Z"));
    expect(todayIso()).toBe("2026-03-05");
  });

  it("zero-pads month and day", () => {
    vi.stubEnv("TZ", "UTC");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T12:00:00Z"));
    expect(todayIso()).toBe("2026-01-02");
  });
});
