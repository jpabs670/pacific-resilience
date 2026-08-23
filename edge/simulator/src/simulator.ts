import { randomUUID } from "node:crypto";
import {
  parseTelemetryEnvelope,
  type TelemetryEnvelope,
  timestampProblem,
} from "@pacific-resilience/contracts";
import { createRandom, jitter, type Random, round } from "./prng.js";
import { phaseAt, type Scenario, type ScenarioPhase, totalTicks } from "./scenario.js";
import { JITTER, LOADS, NOMINAL, SITE_001 } from "./site-001.js";

/**
 * Deterministic Site 001 telemetry generator.
 *
 * Every reading it emits is `origins: ["simulated"]` and `derivation: "direct"`.
 * That pairing is the whole contract of this package: a simulator models
 * *sensors*, and a sensor reports observations. Inferred and estimated values are
 * produced by `packages/event-detection`, not here — emitting a derived value from
 * a simulator would put a rule's output inside the sensor layer, where its lineage
 * could not be checked.
 *
 * The generator reads no clock. Timestamps are computed arithmetically from
 * `startedAt` and the tick index, so a run is reproducible on any machine at any
 * time.
 */

export type IdFactory = () => string;

export type SimulatorOptions = {
  readonly scenario: Scenario;
  readonly seed: number;
  /** Canonical RFC 3339 UTC instant for tick 0. */
  readonly startedAt: string;
  /**
   * Reading-ID source. Defaults to `crypto.randomUUID`.
   *
   * IDs are deliberately **not** derived from the seed: identity must not be
   * computable from content, or two legitimate observations that happen to look
   * alike would collide. Determinism therefore covers telemetry *values*, not
   * identifiers. Tests that need byte-identical output inject a counter here.
   */
  readonly idFactory?: IdFactory;
};

export type Simulator = {
  /** One tick's readings, or an empty array once the scenario is exhausted. */
  tick(): TelemetryEnvelope[];
  readonly totalTicks: number;
  ticksEmitted(): number;
  exhausted(): boolean;
};

function voltageFor(phase: ScenarioPhase, random: Random): number {
  switch (phase.voltage.mode) {
    case "dead":
      return 0;
    case "nominal":
      return round(jitter(random, NOMINAL.voltageV, JITTER.voltageV), 1);
    case "unstable":
      return round(jitter(random, NOMINAL.voltageV, JITTER.voltageV * 6), 1);
    case "sag":
      return round(
        jitter(random, NOMINAL.voltageV * (phase.voltage.fraction ?? 1), JITTER.voltageV),
        1,
      );
  }
}

function frequencyFor(phase: ScenarioPhase, random: Random): number {
  if (phase.voltage.mode === "dead") {
    // De-energized. Zero frequency is meaningful, not missing data.
    return 0;
  }
  return round(jitter(random, NOMINAL.frequencyHz, JITTER.frequencyHz), 2);
}

function refrigeratorFor(phase: ScenarioPhase, elapsedMs: number, random: Random): number {
  if (phase.served === "none") {
    return 0;
  }
  const positionMs = elapsedMs % LOADS.refrigeratorPeriodMs;
  const running = positionMs < LOADS.refrigeratorPeriodMs * LOADS.refrigeratorDutyCycle;
  const centre = running ? LOADS.refrigeratorRunningW : LOADS.refrigeratorIdleW;
  return Math.max(0, round(jitter(random, centre, running ? JITTER.refrigeratorW : 0.5), 1));
}

function starlinkFor(phase: ScenarioPhase, random: Random): number {
  if (phase.served === "none") {
    return 0;
  }
  return Math.max(0, round(jitter(random, LOADS.starlinkW, JITTER.starlinkW), 1));
}

function householdFor(phase: ScenarioPhase, random: Random): number {
  if (phase.served !== "all") {
    return 0;
  }
  return Math.max(0, round(jitter(random, LOADS.householdBaseW, JITTER.householdW), 1));
}

export function createSimulator(options: SimulatorOptions): Simulator {
  const problem = timestampProblem(options.startedAt);
  if (problem !== undefined) {
    throw new RangeError(`startedAt is not a canonical timestamp: ${problem.message}`);
  }

  const { scenario } = options;
  const random = createRandom(options.seed);
  const newId: IdFactory = options.idFactory ?? randomUUID;
  const startEpochMs = new Date(options.startedAt).getTime();
  const total = totalTicks(scenario);

  let tickIndex = 0;
  let socPct = scenario.initialSocPct;

  const emit = (
    sourceId: string,
    metric: string,
    capturedAt: string,
    sample: TelemetryEnvelope["sample"],
  ): TelemetryEnvelope =>
    parseTelemetryEnvelope({
      schemaVersion: 1,
      readingId: newId(),
      siteId: SITE_001.siteId,
      sourceId,
      metric,
      capturedAt,
      sample,
      origins: ["simulated"],
      derivation: "direct",
    });

  return {
    totalTicks: total,
    ticksEmitted: () => tickIndex,
    exhausted: () => tickIndex >= total,

    tick(): TelemetryEnvelope[] {
      if (tickIndex >= total) {
        return [];
      }
      const elapsedMs = tickIndex * scenario.intervalMs;
      const capturedAt = new Date(startEpochMs + elapsedMs).toISOString();
      const phase = phaseAt(scenario, tickIndex);

      const voltage = voltageFor(phase, random);
      const frequency = frequencyFor(phase, random);
      const refrigerator = refrigeratorFor(phase, elapsedMs, random);
      const starlink = starlinkFor(phase, random);
      const household = householdFor(phase, random);
      const siteLoad = round(refrigerator + starlink + household, 1);

      const { sources } = SITE_001;
      const readings: TelemetryEnvelope[] = [
        emit(sources.panel, "voltage.rms", capturedAt, {
          kind: "numeric",
          value: voltage,
          unit: "V",
        }),
        emit(sources.panel, "frequency", capturedAt, {
          kind: "numeric",
          value: frequency,
          unit: "Hz",
        }),
        emit(sources.panel, "source.active", capturedAt, {
          kind: "state",
          state: phase.source,
          domain: "energy_source",
        }),
        emit(sources.panel, "load.site.active_power", capturedAt, {
          kind: "numeric",
          value: siteLoad,
          unit: "W",
        }),
        emit(sources.refrigerator, "load.refrigerator.active_power", capturedAt, {
          kind: "numeric",
          value: refrigerator,
          unit: "W",
        }),
        emit(sources.starlink, "load.starlink.active_power", capturedAt, {
          kind: "numeric",
          value: starlink,
          unit: "W",
        }),
        emit(sources.battery, "battery.state_of_charge", capturedAt, {
          kind: "numeric",
          value: round(socPct, 1),
          unit: "percent",
        }),
      ];

      // Advance the battery only after the reading has been emitted. A reading
      // timestamped `capturedAt` reports the state *at* that instant, so tick 0
      // must report the scenario's initial charge; the phase rate describes the
      // interval that follows the tick, not the one before it. Applying it first
      // published every value one interval early and made the initial charge
      // unobservable.
      const deltaPct = (phase.socRatePctPerHour * scenario.intervalMs) / 3_600_000;
      socPct = Math.min(100, Math.max(0, socPct + deltaPct));

      tickIndex += 1;
      return readings;
    },
  };
}

/** Readings per tick. Fixed by the Site 001 signal set above. */
export const READINGS_PER_TICK = 7;
