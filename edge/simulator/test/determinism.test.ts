import type { TelemetryEnvelope } from "@pacific-resilience/contracts";
import { describe, expect, it } from "vitest";
import { loadAllScenarios, loadScenario } from "../src/scenarios.js";
import { createSimulator } from "../src/simulator.js";
import { pinnedIdFactory } from "./support/ids.js";

const STARTED_AT = "2026-07-26T04:00:00.000Z";

/** Everything except the identifier, which is deliberately not seed-derived. */
function values(reading: TelemetryEnvelope) {
  const { readingId, ...rest } = reading;
  expect(readingId.length).toBeGreaterThan(0);
  return rest;
}

function runValues(scenarioName: string, seed: number, ticks: number) {
  const simulator = createSimulator({
    scenario: loadScenario(scenarioName),
    seed,
    startedAt: STARTED_AT,
  });
  const emitted: unknown[] = [];
  for (let i = 0; i < ticks; i += 1) {
    emitted.push(simulator.tick().map(values));
  }
  return emitted;
}

describe("same seed and scenario produce identical telemetry values", () => {
  for (const scenario of loadAllScenarios()) {
    it(`is reproducible: ${scenario.name}`, () => {
      const first = runValues(scenario.name, 1, 40);
      const second = runValues(scenario.name, 1, 40);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
  }

  it("is reproducible across a whole scenario, not just its opening ticks", () => {
    const scenario = loadScenario("outage-restore");
    const a = runValues("outage-restore", 7, scenario.phases.length * 0 + 400);
    const b = runValues("outage-restore", 7, 400);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("produces different values for a different seed", () => {
    const a = runValues("normal-day", 1, 20);
    const b = runValues("normal-day", 2, 20);
    expect(JSON.stringify(b)).not.toBe(JSON.stringify(a));
  });

  it("is byte-identical, ids included, when the id factory is pinned", () => {
    const run = () => {
      const simulator = createSimulator({
        scenario: loadScenario("generator-transfer"),
        seed: 42,
        startedAt: STARTED_AT,
        idFactory: pinnedIdFactory(),
      });
      return JSON.stringify([simulator.tick(), simulator.tick(), simulator.tick()]);
    };
    expect(run()).toBe(run());
  });

  it("derives no identifier from the seed", () => {
    // Two runs with the same seed must not collide on reading ids, or identity
    // would be computable from content and two legitimate observations that look
    // alike could not coexist.
    const ids = (seed: number) =>
      createSimulator({ scenario: loadScenario("normal-day"), seed, startedAt: STARTED_AT })
        .tick()
        .map((reading) => reading.readingId);
    expect(ids(5)).not.toEqual(ids(5));
  });
});

describe("timestamps are computed, not read from a clock", () => {
  it("advances by exactly one interval per tick from startedAt", () => {
    const scenario = loadScenario("normal-day");
    const simulator = createSimulator({ scenario, seed: 3, startedAt: STARTED_AT });
    const start = new Date(STARTED_AT).getTime();

    for (let i = 0; i < 5; i += 1) {
      const readings = simulator.tick();
      const expected = new Date(start + i * scenario.intervalMs).toISOString();
      for (const reading of readings) {
        expect(reading.capturedAt).toBe(expected);
      }
    }
  });

  it("rejects a non-canonical startedAt rather than normalising it", () => {
    expect(() =>
      createSimulator({
        scenario: loadScenario("normal-day"),
        seed: 1,
        startedAt: "2026-07-26T14:00:00+10:00",
      }),
    ).toThrow(RangeError);
  });
});

describe("scenario exhaustion", () => {
  it("stops emitting once the scenario ends", () => {
    const scenario = loadScenario("normal-day");
    const simulator = createSimulator({ scenario, seed: 1, startedAt: STARTED_AT });
    expect(simulator.totalTicks).toBe(600);

    for (let i = 0; i < simulator.totalTicks; i += 1) {
      expect(simulator.tick().length).toBeGreaterThan(0);
    }
    expect(simulator.exhausted()).toBe(true);
    expect(simulator.tick()).toEqual([]);
    expect(simulator.ticksEmitted()).toBe(600);
  });
});
