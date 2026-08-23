import { describe, expect, it } from "vitest";
import { timestampProblem, toEpochMs } from "../src/time.js";

describe("canonical timestamps", () => {
  it("accepts RFC 3339 UTC with millisecond precision", () => {
    expect(timestampProblem("2026-07-26T04:15:30.250Z")).toBeUndefined();
    expect(timestampProblem("1970-01-01T00:00:00.000Z")).toBeUndefined();
  });

  it("rejects a numeric offset rather than normalizing it", () => {
    // Silent normalization would turn a wrong offset into a silent time shift.
    expect(timestampProblem("2026-07-26T14:15:30.250+10:00")?.code).toBe("time.not_utc");
    expect(timestampProblem("2026-07-26T14:15:30.250-0500")?.code).toBe("time.not_utc");
  });

  it("rejects a lowercase z", () => {
    expect(timestampProblem("2026-07-26T04:15:30.250z")?.code).toBe("time.not_utc");
  });

  it("rejects missing or over-precise fractional digits", () => {
    expect(timestampProblem("2026-07-26T04:15:30Z")?.code).toBe("time.format");
    expect(timestampProblem("2026-07-26T04:15:30.2500Z")?.code).toBe("time.format");
    expect(timestampProblem("2026-07-26T04:15:30.25Z")?.code).toBe("time.format");
  });

  it("rejects a well-shaped string that is not a real instant", () => {
    expect(timestampProblem("2026-02-30T04:15:30.250Z")?.code).toBe("time.invalid_calendar");
    expect(timestampProblem("2026-13-01T04:15:30.250Z")?.code).toBe("time.invalid_calendar");
    expect(timestampProblem("2026-07-26T25:15:30.250Z")?.code).toBe("time.invalid_calendar");
  });

  it("accepts a real leap day", () => {
    expect(timestampProblem("2028-02-29T00:00:00.000Z")).toBeUndefined();
  });

  it("rejects an empty string and obvious non-timestamps", () => {
    expect(timestampProblem("")?.code).toBe("time.format");
    expect(timestampProblem("yesterday")?.code).toBe("time.format");
  });
});

describe("epoch conversion", () => {
  it("round-trips through epoch milliseconds", () => {
    const value = "2026-07-26T04:15:30.250Z";
    const epochMs = toEpochMs(value);
    expect(new Date(epochMs).toISOString()).toBe(value);
  });

  it("throws rather than guessing on an invalid value", () => {
    expect(() => toEpochMs("2026-07-26T04:15:30+10:00")).toThrow(RangeError);
  });
});
