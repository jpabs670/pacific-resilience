import { describe, expect, it } from "vitest";
import { MAX_BATCH_READINGS, parseTelemetryBatch, safeParseTelemetryBatch } from "../src/batch.js";
import { ContractValidationError } from "../src/errors.js";
import { loadInvalid, loadValid } from "./support/fixtures.js";

const validFixtures = loadValid("batch");
const invalidFixtures = loadInvalid("batch");

describe("telemetry batch — valid fixtures", () => {
  for (const fixture of validFixtures) {
    it(`accepts ${fixture.name}`, () => {
      const result = safeParseTelemetryBatch(fixture.value);
      if (!result.ok) {
        throw new Error(
          `${fixture.name} should be valid — ${fixture.intent}\nissues: ${JSON.stringify(result.issues, null, 2)}`,
        );
      }
      const span = result.value.sequenceEnd - result.value.sequenceStart + 1;
      expect(span).toBe(result.value.readings.length);
    });
  }
});

describe("telemetry batch — invalid fixtures", () => {
  for (const fixture of invalidFixtures) {
    it(`rejects ${fixture.name} with a useful field error`, () => {
      const result = safeParseTelemetryBatch(fixture.value);
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
      }
    });
  }
});

describe("batch rejection is all-or-nothing", () => {
  it("carries the offending reading index", () => {
    const fixture = invalidFixtures.find((entry) => entry.name === "invalid-reading-inside-batch");
    expect(fixture).toBeDefined();
    const result = safeParseTelemetryBatch(fixture?.value);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    const issue = result.issues.find((entry) => entry.code === "lineage.required");
    expect(issue?.index).toBe(1);
    expect(issue?.path).toBe("readings[1].lineage");
  });

  it("throws a ContractValidationError from the throwing parser", () => {
    const fixture = invalidFixtures[0];
    expect(fixture).toBeDefined();
    expect(() => parseTelemetryBatch(fixture?.value)).toThrow(ContractValidationError);
  });
});

describe("batch size bound", () => {
  it("rejects more readings than the documented maximum", () => {
    const valid = validFixtures.find((entry) => entry.name === "single-reading");
    const template = valid?.value as { readonly readings: readonly unknown[] } | undefined;
    const reading = template?.readings[0];
    expect(reading).toBeDefined();

    const count = MAX_BATCH_READINGS + 1;
    const result = safeParseTelemetryBatch({
      schemaVersion: 1,
      gatewayId: "gw_001_1",
      sequenceStart: 1,
      sequenceEnd: count,
      clockOffsetMs: 0,
      readings: Array.from({ length: count }, () => reading),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.issues.some((issue) => issue.code === "batch.readings.too_many")).toBe(true);
  });
});
