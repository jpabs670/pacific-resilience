/**
 * `@pacific-resilience/simulator` — deterministic Site 001 telemetry.
 *
 * Constraints, asserted by `test/architecture.test.ts`:
 *
 * - Every emitted reading is `origins: ["simulated"]`, `derivation: "direct"`.
 *   This package models sensors; derived values belong to event detection.
 * - No `Math.random`, no clock reads. Same seed and scenario, same values.
 * - No device, serial, or network access. Nothing here can act on equipment.
 */

export { createRandom, jitter, type Random, round } from "./prng.js";
export {
  ENERGY_SOURCES,
  type EnergySource,
  parseScenario,
  phaseAt,
  type Scenario,
  type ScenarioPhase,
  SERVED_LOADS,
  type ServedLoads,
  scenarioSchema,
  totalTicks,
  VOLTAGE_MODES,
  type VoltageMode,
} from "./scenario.js";
export { loadAllScenarios, loadScenario, scenarioNames } from "./scenarios.js";
export {
  createSimulator,
  type IdFactory,
  READINGS_PER_TICK,
  type Simulator,
  type SimulatorOptions,
} from "./simulator.js";
export { JITTER, LOADS, NOMINAL, SITE_001 } from "./site-001.js";
