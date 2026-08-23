import { describe, expect, it } from "vitest";
import { safeParseTelemetryEnvelope } from "../src/envelope.js";
import { isOutOfRange } from "../src/metrics.js";
import { loadInvalid, loadValid } from "./support/fixtures.js";

const validFixtures = loadValid("envelope");
const invalidFixtures = loadInvalid("envelope");

describe("telemetry envelope v1 — valid fixtures", () => {
  it("has a non-trivial corpus", () => {
    expect(validFixtures.length).toBeGreaterThanOrEqual(8);
  });

  for (const fixture of validFixtures) {
    it(`accepts ${fixture.name}`, () => {
      const result = safeParseTelemetryEnvelope(fixture.value);
      if (!result.ok) {
        throw new Error(
          `${fixture.name} should be valid — ${fixture.intent}\nissues: ${JSON.stringify(result.issues, null, 2)}`,
        );
      }
      expect(result.value.schemaVersion).toBe(1);
      expect(result.value.origins.length).toBeGreaterThan(0);
    });
  }
});

describe("telemetry envelope v1 — invalid fixtures", () => {
  it("covers a broad rejection surface", () => {
    expect(invalidFixtures.length).toBeGreaterThanOrEqual(30);
  });

  for (const fixture of invalidFixtures) {
    it(`rejects ${fixture.name} with a useful field error`, () => {
      const result = safeParseTelemetryEnvelope(fixture.value);
      if (result.ok) {
        throw new Error(`${fixture.name} should be rejected — ${fixture.intent}`);
      }

      const actual = JSON.stringify(result.issues, null, 2);
      for (const expected of fixture.expect) {
        const match = result.issues.find(
          (issue) => issue.path === expected.path && issue.code === expected.code,
        );
        if (match === undefined) {
          throw new Error(
            `expected ${expected.code} at ${expected.path} — ${fixture.intent}\nactual: ${actual}`,
          );
        }
        expect(match.message.trim().length).toBeGreaterThan(0);
        expect(match.segments.length >= 0).toBe(true);
      }
    });
  }
});

describe("range handling", () => {
  it("accepts an out-of-range value and reports it separately", () => {
    const fixture = validFixtures.find((entry) => entry.name === "out-of-range-accepted");
    expect(fixture).toBeDefined();
    const result = safeParseTelemetryEnvelope(fixture?.value);
    expect(result.ok).toBe(true);
    // Range is advisory: the schema accepts, and callers decide to flag.
    expect(isOutOfRange("voltage.rms", 412)).toBe(true);
    expect(isOutOfRange("voltage.rms", 118.4)).toBe(false);
  });

  it("treats declared bounds as inclusive", () => {
    expect(isOutOfRange("battery.state_of_charge", 0)).toBe(false);
    expect(isOutOfRange("battery.state_of_charge", 100)).toBe(false);
    expect(isOutOfRange("battery.state_of_charge", 100.1)).toBe(true);
    expect(isOutOfRange("battery.state_of_charge", -0.1)).toBe(true);
  });
});

describe("values JSON cannot express", () => {
  const base = {
    schemaVersion: 1,
    readingId: "00000000-0000-4000-8000-000000000001",
    siteId: "site_001",
    sourceId: "src_001_sim_panel",
    metric: "voltage.rms",
    capturedAt: "2026-07-26T04:15:30.250Z",
    origins: ["simulated"],
    derivation: "direct",
  };

  it("rejects a non-finite sample value", () => {
    const result = safeParseTelemetryEnvelope({
      ...base,
      sample: { kind: "numeric", value: Number.POSITIVE_INFINITY, unit: "V" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.path === "sample.value")).toBe(true);
  });

  it("rejects NaN", () => {
    const result = safeParseTelemetryEnvelope({
      ...base,
      sample: { kind: "numeric", value: Number.NaN, unit: "V" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.path === "sample.value")).toBe(true);
  });
});
