import { describe, expect, it } from "vitest";
import { DEFAULT_BACKOFF, nextDelayMs } from "../src/backoff.js";

const noJitter = () => 0;

describe("bounded exponential backoff", () => {
  it("doubles up to the ceiling and never beyond", () => {
    const options = { initialMs: 1_000, ceilingMs: 300_000, random: noJitter };
    expect(nextDelayMs(1, options)).toBe(1_000);
    expect(nextDelayMs(2, options)).toBe(2_000);
    expect(nextDelayMs(3, options)).toBe(4_000);
    expect(nextDelayMs(9, options)).toBe(256_000);
    expect(nextDelayMs(10, options)).toBe(300_000);
    expect(nextDelayMs(50, options)).toBe(300_000);
  });

  it("stays bounded for an attempt count that would overflow a naive exponent", () => {
    const options = { initialMs: 1_000, ceilingMs: 300_000, random: noJitter };
    expect(nextDelayMs(1_000_000, options)).toBe(300_000);
    expect(Number.isFinite(nextDelayMs(1_000_000, options))).toBe(true);
  });

  it("applies full jitter within (0, base]", () => {
    const options = { initialMs: 1_000, ceilingMs: 300_000 };
    for (const draw of [0, 0.25, 0.5, 0.99]) {
      const delay = nextDelayMs(3, { ...options, random: () => draw });
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(4_000);
    }
  });

  it("never returns zero, so a retry always waits", () => {
    // A zero delay would turn backoff into a hot loop against a failing endpoint.
    const delay = nextDelayMs(1, { initialMs: 1, ceilingMs: 10, random: () => 0.999999 });
    expect(delay).toBeGreaterThanOrEqual(1);
  });

  it("is deterministic for a given random source", () => {
    const options = { initialMs: 1_000, ceilingMs: 60_000, random: () => 0.4 };
    expect(nextDelayMs(4, options)).toBe(nextDelayMs(4, options));
  });

  it("rejects nonsense configuration rather than guessing", () => {
    expect(() => nextDelayMs(0, { initialMs: 1, ceilingMs: 2 })).toThrow();
    expect(() => nextDelayMs(1.5, { initialMs: 1, ceilingMs: 2 })).toThrow();
    expect(() => nextDelayMs(1, { initialMs: 0, ceilingMs: 2 })).toThrow();
    expect(() => nextDelayMs(1, { initialMs: 10, ceilingMs: 5 })).toThrow();
  });

  it("defaults to the documented 1s-to-5min envelope", () => {
    expect(DEFAULT_BACKOFF).toEqual({ initialMs: 1_000, ceilingMs: 300_000 });
  });
});
