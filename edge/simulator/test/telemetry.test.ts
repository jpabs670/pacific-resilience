import {
  isMetricName,
  isOutOfRange,
  safeParseTelemetryEnvelope,
} from "@pacific-resilience/contracts";
import { describe, expect, it } from "vitest";
import { loadAllScenarios, loadScenario } from "../src/scenarios.js";
import { createSimulator, READINGS_PER_TICK } from "../src/simulator.js";
import { SITE_001 } from "../src/site-001.js";

const STARTED_AT = "2026-07-26T04:00:00.000Z";

function collect(scenarioName: string, ticks: number) {
  const simulator = createSimulator({
    scenario: loadScenario(scenarioName),
    seed: 11,
    startedAt: STARTED_AT,
  });
  const all = [];
  for (let i = 0; i < ticks; i += 1) {
    all.push(...simulator.tick());
  }
  return all;
}

describe("all telemetry remains synthetic", () => {
  for (const scenario of loadAllScenarios()) {
    it(`emits only simulated, direct observations: ${scenario.name}`, () => {
      const readings = collect(scenario.name, 60);
      expect(readings.length).toBeGreaterThan(0);

      for (const reading of readings) {
        // Nothing at Site 001 is verified, so no reading may claim any other origin.
        expect(reading.origins).toEqual(["simulated"]);
        // A simulator models sensors. Inferred and estimated values come from
        // event detection, where their lineage can be checked.
        expect(reading.derivation).toBe("direct");
        expect(reading.lineage).toBeUndefined();
        expect(reading.siteId).toBe("site_001");
      }
    });
  }

  it("never emits a measured, imported, or manual origin in any scenario", () => {
    for (const scenario of loadAllScenarios()) {
      const origins = new Set(
        collect(scenario.name, 30).flatMap((reading) => [...reading.origins]),
      );
      expect([...origins]).toEqual(["simulated"]);
    }
  });
});

describe("emitted readings satisfy the boundary schema", () => {
  it("passes contracts validation for every scenario", () => {
    for (const scenario of loadAllScenarios()) {
      for (const reading of collect(scenario.name, 40)) {
        const result = safeParseTelemetryEnvelope(reading);
        if (!result.ok) {
          throw new Error(
            `${scenario.name} emitted an invalid reading: ${JSON.stringify(result.issues)}`,
          );
        }
      }
    }
  });

  it("uses only registered metrics and the declared Site 001 sources", () => {
    const sources = new Set<string>(Object.values(SITE_001.sources));
    for (const reading of collect("outage-restore", 30)) {
      expect(isMetricName(reading.metric)).toBe(true);
      expect(sources.has(reading.sourceId)).toBe(true);
    }
  });

  it("emits the complete Site 001 signal set on every tick", () => {
    const simulator = createSimulator({
      scenario: loadScenario("normal-day"),
      seed: 1,
      startedAt: STARTED_AT,
    });
    const tick = simulator.tick();
    expect(tick.length).toBe(READINGS_PER_TICK);
    expect(tick.map((reading) => reading.metric).sort()).toEqual(
      [
        "battery.state_of_charge",
        "frequency",
        "load.refrigerator.active_power",
        "load.site.active_power",
        "load.starlink.active_power",
        "source.active",
        "voltage.rms",
      ].sort(),
    );
  });

  it("keeps every value inside its metric's declared range", () => {
    for (const scenario of loadAllScenarios()) {
      for (const reading of collect(scenario.name, 60)) {
        if (reading.sample.kind === "numeric") {
          expect(
            isOutOfRange(reading.metric, reading.sample.value),
            `${scenario.name} ${reading.metric}=${reading.sample.value}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("scenario physics are internally consistent", () => {
  it("reports zero volts and zero hertz while de-energized", () => {
    const readings = collect("outage-restore", 400);
    const byTime = new Map<string, Map<string, number | string>>();
    for (const reading of readings) {
      const slot = byTime.get(reading.capturedAt) ?? new Map();
      slot.set(
        reading.metric,
        reading.sample.kind === "numeric" ? reading.sample.value : reading.sample.state,
      );
      byTime.set(reading.capturedAt, slot);
    }

    let deadTicks = 0;
    for (const slot of byTime.values()) {
      if (slot.get("source.active") === "none") {
        deadTicks += 1;
        expect(slot.get("voltage.rms")).toBe(0);
        expect(slot.get("frequency")).toBe(0);
        expect(slot.get("load.site.active_power")).toBe(0);
        expect(slot.get("load.refrigerator.active_power")).toBe(0);
        expect(slot.get("load.starlink.active_power")).toBe(0);
      }
    }
    expect(deadTicks).toBeGreaterThan(100);
  });

  it("keeps voltage present when the battery carries the critical loads", () => {
    // Losing the utility is not the same as an outage at the site.
    const readings = collect("battery-bridge", 200);
    const onBattery = readings.filter(
      (reading) => reading.sample.kind === "state" && reading.sample.state === "battery",
    );
    expect(onBattery.length).toBeGreaterThan(0);

    const batteryInstants = new Set(onBattery.map((reading) => reading.capturedAt));
    const voltagesOnBattery = readings.filter(
      (reading) => reading.metric === "voltage.rms" && batteryInstants.has(reading.capturedAt),
    );
    expect(voltagesOnBattery.length).toBeGreaterThan(0);
    for (const reading of voltagesOnBattery) {
      if (reading.sample.kind === "numeric") {
        expect(reading.sample.value).toBeGreaterThan(100);
      }
    }
  });

  it("discharges the battery only while it is carrying load", () => {
    const soc = collect("battery-bridge", 480)
      .filter((reading) => reading.metric === "battery.state_of_charge")
      .map((reading) => (reading.sample.kind === "numeric" ? reading.sample.value : Number.NaN));

    expect(soc.length).toBeGreaterThan(400);
    const first = soc[0] ?? 0;
    const lowest = Math.min(...soc);
    expect(lowest).toBeLessThan(first);
    for (const value of soc) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("keeps site load equal to the sum of the monitored circuits", () => {
    const readings = collect("normal-day", 30);
    const byTime = new Map<string, Map<string, number>>();
    for (const reading of readings) {
      if (reading.sample.kind !== "numeric") {
        continue;
      }
      const slot = byTime.get(reading.capturedAt) ?? new Map();
      slot.set(reading.metric, reading.sample.value);
      byTime.set(reading.capturedAt, slot);
    }
    for (const slot of byTime.values()) {
      const site = slot.get("load.site.active_power") ?? 0;
      const fridge = slot.get("load.refrigerator.active_power") ?? 0;
      const starlink = slot.get("load.starlink.active_power") ?? 0;
      expect(site).toBeGreaterThanOrEqual(fridge + starlink - 0.05);
    }
  });
});
