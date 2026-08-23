import { describe, expect, it } from "vitest";
import { parseScenario, type Scenario } from "../src/scenario.js";
import { createSimulator } from "../src/simulator.js";
import { pinnedIdFactory } from "./support/ids.js";

/**
 * Battery state-of-charge timing.
 *
 * A reading stamped `capturedAt` reports the state *at* that instant. The phase
 * rate therefore describes the interval that follows a tick, not the one before
 * it, which makes tick 0 the scenario's declared initial charge. Applying the rate
 * before emitting published every value one interval early and made the initial
 * charge impossible to observe at all.
 *
 * The rates below are chosen to land on exact values: at a 60s interval,
 * -60 %/h is exactly -1 point per tick and +120 %/h is exactly +2. The
 * assertions are therefore literal, not approximate.
 */

const INTERVAL_MS = 60_000;

function scenario(initialSocPct: number, rates: readonly number[], ticksPerPhase = 5): Scenario {
  return parseScenario(
    {
      name: "battery-timing",
      description: "A scenario used only by the battery timing tests.",
      intervalMs: INTERVAL_MS,
      initialSocPct,
      phases: rates.map((socRatePctPerHour, index) => ({
        label: `phase-${index}`,
        durationMs: INTERVAL_MS * ticksPerPhase,
        source: "battery",
        voltage: { mode: "nominal" },
        served: "critical",
        socRatePctPerHour,
      })),
    },
    "battery-timing",
  );
}

/** The state-of-charge value emitted at each tick, in order. */
function socSeries(built: Scenario): number[] {
  const simulator = createSimulator({
    scenario: built,
    seed: 7,
    startedAt: "2026-07-26T00:00:00.000Z",
    idFactory: pinnedIdFactory(),
  });

  const series: number[] = [];
  while (!simulator.exhausted()) {
    for (const reading of simulator.tick()) {
      if (reading.metric === "battery.state_of_charge" && reading.sample.kind === "numeric") {
        series.push(reading.sample.value);
      }
    }
  }
  return series;
}

describe("state of charge is emitted before the interval's change is applied", () => {
  it("reports the declared initial charge at tick zero", () => {
    expect(socSeries(scenario(50, [-60]))[0]).toBe(50);
    expect(socSeries(scenario(0, [60]))[0]).toBe(0);
    expect(socSeries(scenario(100, [-60]))[0]).toBe(100);
    expect(socSeries(scenario(37.5, [0]))[0]).toBe(37.5);
  });

  it("reflects exactly one interval of change at tick one", () => {
    // -60 %/h over 60s is one point.
    expect(socSeries(scenario(50, [-60]))[1]).toBe(49);
    // +120 %/h over 60s is two points.
    expect(socSeries(scenario(50, [120]))[1]).toBe(52);
    // A zero rate holds the charge where it started.
    expect(socSeries(scenario(50, [0]))[1]).toBe(50);
  });

  it("accumulates one interval per tick and never skips the first", () => {
    expect(socSeries(scenario(50, [-60]))).toEqual([50, 49, 48, 47, 46]);
  });

  it("applies a new phase rate after the boundary tick, not on it", () => {
    // Phase 0 discharges one point per tick across ticks 0..4; phase 1 charges
    // two per tick across ticks 5..9. Tick 5 is the boundary: it reports the
    // charge phase 0 left behind, and phase 1's rate first shows at tick 6.
    const series = socSeries(scenario(50, [-60, 120]));

    expect(series).toEqual([50, 49, 48, 47, 46, 45, 47, 49, 51, 53]);
    expect(series[5]).toBe(45);
    expect(series[6]).toBe(47);
  });

  it("holds a mid-scenario pause flat across its own phase", () => {
    const series = socSeries(scenario(80, [-60, 0, 120], 3));
    expect(series).toEqual([80, 79, 78, 77, 77, 77, 77, 79, 81]);
  });
});

describe("state of charge stays inside 0 to 100", () => {
  it("clamps at zero and stays there while discharging", () => {
    const series = socSeries(scenario(2, [-60], 6));
    expect(series).toEqual([2, 1, 0, 0, 0, 0]);
  });

  it("clamps at one hundred and stays there while charging", () => {
    const series = socSeries(scenario(99, [120], 5));
    expect(series).toEqual([99, 100, 100, 100, 100]);
  });

  it("recovers from a clamped floor once the rate reverses", () => {
    // Clamping must not be sticky: reaching zero is a state, not a latch.
    const series = socSeries(scenario(1, [-60, 120], 3));
    expect(series).toEqual([1, 0, 0, 0, 2, 4]);
  });

  it("stays in range under rates steep enough to overshoot both bounds", () => {
    for (const rates of [[-60], [120], [-600], [600], [0]]) {
      for (const value of socSeries(scenario(50, rates, 20))) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });
});
