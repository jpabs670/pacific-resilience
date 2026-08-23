import { describe, expect, it } from "vitest";
import {
  isMetricName,
  isOutOfRange,
  METRIC_NAMES,
  metricSpec,
  STATE_DOMAINS,
} from "../src/metrics.js";
import { isUnit, UNITS } from "../src/units.js";

describe("unit registry", () => {
  it("is exactly the documented base units", () => {
    expect([...UNITS]).toEqual(["V", "Hz", "W", "Wh", "percent", "s"]);
  });

  it("rejects unregistered and scaled units", () => {
    expect(isUnit("V")).toBe(true);
    expect(isUnit("kW")).toBe(false);
    expect(isUnit("kWh")).toBe(false);
    expect(isUnit("volts")).toBe(false);
    expect(isUnit("")).toBe(false);
  });
});

describe("metric registry", () => {
  it("contains every metric documented for Site 001", () => {
    expect([...METRIC_NAMES].sort()).toEqual(
      [
        "battery.runtime_remaining",
        "battery.state_of_charge",
        "frequency",
        "gateway.link",
        "load.refrigerator.active_power",
        "load.site.active_power",
        "load.starlink.active_power",
        "source.active",
        "voltage.rms",
      ].sort(),
    );
  });

  it("rejects unregistered metrics", () => {
    expect(isMetricName("voltage.rms")).toBe(true);
    expect(isMetricName("voltage.peak")).toBe(false);
    expect(isMetricName("")).toBe(false);
  });

  it("binds each numeric metric to exactly one unit", () => {
    for (const name of METRIC_NAMES) {
      const spec = metricSpec(name);
      expect(spec).toBeDefined();
      if (spec?.kind === "numeric") {
        expect(isUnit(spec.unit)).toBe(true);
      }
    }
  });

  it("encodes no unit, aggregation, or provenance in any metric name", () => {
    for (const name of METRIC_NAMES) {
      expect(name).not.toMatch(/_(w|wh|v|hz|s|percent)$/);
      expect(name).not.toMatch(/(avg|mean|sum|total|hourly|daily)/);
      expect(name).not.toMatch(/(simulated|measured|estimated|inferred|manual|imported)/);
    }
  });

  it("keeps unknown distinct from none in the energy_source domain", () => {
    const spec = metricSpec("source.active");
    expect(spec?.kind).toBe("state");
    if (spec?.kind !== "state") {
      return;
    }
    expect(spec.domain).toBe("energy_source");
    expect(spec.values).toContain("none");
    expect(spec.values).toContain("unknown");
    expect(spec.values).toContain("solar");
  });

  it("declares only documented state domains", () => {
    expect([...STATE_DOMAINS]).toEqual(["energy_source", "link_state"]);
  });

  it("reports no range violation for state metrics", () => {
    expect(isOutOfRange("source.active", 1)).toBe(false);
    expect(isOutOfRange("not.a.metric", 999)).toBe(false);
  });

  it("applies an open upper bound where the documentation declares one", () => {
    expect(isOutOfRange("load.site.active_power", 1_000_000)).toBe(false);
    expect(isOutOfRange("load.site.active_power", -1)).toBe(true);
  });
});
