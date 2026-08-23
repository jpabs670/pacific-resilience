import { describe, expect, it } from "vitest";
import type { DerivedEnvelope, DirectEnvelope, TelemetryEnvelope } from "../src/envelope.js";
import { isDerived, parseTelemetryEnvelope } from "../src/envelope.js";
import type { Lineage } from "../src/lineage.js";

/**
 * The lineage rule holds in the type system as well as at runtime. Every
 * `@ts-expect-error` below must remain an error: `npm run typecheck` fails if
 * one stops being one, which is what keeps these assertions honest.
 */

const READING_ID = "00000000-0000-4000-8000-000000000001";

const LINEAGE: Lineage = {
  rule: "outage",
  ruleVersion: "1.0.0",
  inputIds: ["00000000-0000-4000-8000-000000000010"],
};

const direct: TelemetryEnvelope = {
  schemaVersion: 1,
  readingId: READING_ID,
  siteId: "site_001",
  sourceId: "src_001_sim_panel",
  metric: "voltage.rms",
  capturedAt: "2026-07-26T04:15:30.250Z",
  sample: { kind: "numeric", value: 118.4, unit: "V" },
  origins: ["simulated"],
  derivation: "direct",
};

const inferred: TelemetryEnvelope = {
  schemaVersion: 1,
  readingId: READING_ID,
  siteId: "site_001",
  sourceId: "src_001_sim_panel",
  metric: "load.site.active_power",
  capturedAt: "2026-07-26T04:15:30.250Z",
  sample: { kind: "numeric", value: 1840, unit: "W" },
  origins: ["simulated"],
  derivation: "inferred",
  lineage: LINEAGE,
};

// @ts-expect-error a direct record has no chain, so lineage has nowhere to go
const lineageOnDirect: DirectEnvelope["lineage"] = LINEAGE;

// @ts-expect-error a derived record cannot omit lineage
const lineageOnDerived: DerivedEnvelope["lineage"] = undefined;

describe("envelope types encode the lineage rule", () => {
  it("permits a direct record without lineage", () => {
    expect(direct.derivation).toBe("direct");
    expect(isDerived(direct)).toBe(false);
  });

  it("narrows a derived record to one that has lineage", () => {
    expect(isDerived(inferred)).toBe(true);
    if (!isDerived(inferred)) {
      return;
    }
    expect(inferred.lineage.rule).toBe("outage");
  });

  it("keeps the compile-time assertions referenced", () => {
    // The declarations above exist for their @ts-expect-error directives; the
    // values themselves are incidental.
    expect(lineageOnDirect).toBeDefined();
    expect(lineageOnDerived).toBeUndefined();
  });
});

describe("the type-level rule and the runtime rule agree", () => {
  it("refuses lineage on a direct record at runtime too", () => {
    const invalid = { ...direct, lineage: LINEAGE };
    expect(() => parseTelemetryEnvelope(invalid)).toThrow(/lineage/);
  });

  it("requires lineage on a derived record at runtime too", () => {
    const invalid = { ...direct, derivation: "inferred" };
    expect(() => parseTelemetryEnvelope(invalid)).toThrow(/lineage/);
  });
});

describe("origins keeps its closed vocabulary in the type", () => {
  it("rejects a value outside the vocabulary", () => {
    const valid: TelemetryEnvelope["origins"] = ["simulated"];
    // @ts-expect-error "guessed" is not an Origin
    const invalid: TelemetryEnvelope["origins"] = ["guessed"];
    expect(valid.length).toBe(1);
    expect(invalid.length).toBe(1);
  });
});
