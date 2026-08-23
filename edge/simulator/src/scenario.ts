import * as z from "zod";

/**
 * Scenario schema.
 *
 * Scenarios are declarative data, not code, so that a new situation at Site 001
 * can be reproduced without touching the generator. They are read from disk,
 * which makes them a system boundary and therefore validated explicitly.
 *
 * Phases declare what the site is doing rather than what any model computes: the
 * supplying source, how the voltage behaves, which loads are served, and how the
 * battery's state of charge moves. Nothing here derives values from a battery
 * capacity model — the exact battery at Site 001 is unverified (D12), and a
 * declared rate is honest where a derived one would imply knowledge we lack.
 */

export const ENERGY_SOURCES = [
  "utility",
  "generator",
  "battery",
  "solar",
  "none",
  "unknown",
] as const;

/** Which loads the site is carrying during a phase. */
export const SERVED_LOADS = ["all", "critical", "none"] as const;

export const VOLTAGE_MODES = ["nominal", "sag", "dead", "unstable"] as const;

const phaseSchema = z.strictObject({
  label: z.string().min(1),
  durationMs: z.number().int().positive(),
  source: z.enum(ENERGY_SOURCES),
  voltage: z.strictObject({
    mode: z.enum(VOLTAGE_MODES),
    /** Fraction of nominal. Required for `sag`, forbidden otherwise. */
    fraction: z.number().positive().max(2).optional(),
  }),
  served: z.enum(SERVED_LOADS),
  /** Signed percentage points per hour. Positive charges, negative discharges. */
  socRatePctPerHour: z.number(),
});

export const scenarioSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z][a-z0-9-]*$/, "scenario name must be lower-kebab-case"),
    description: z.string().min(10),
    intervalMs: z.number().int().positive(),
    initialSocPct: z.number().min(0).max(100),
    phases: z.array(phaseSchema).min(1),
  })
  .superRefine((scenario, ctx) => {
    for (const [index, phase] of scenario.phases.entries()) {
      const path = ["phases", index, "voltage"] as const;
      if (phase.voltage.mode === "sag" && phase.voltage.fraction === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "fraction"],
          message: 'voltage.fraction is required when mode is "sag"',
        });
      }
      if (phase.voltage.mode !== "sag" && phase.voltage.fraction !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "fraction"],
          message: `voltage.fraction is forbidden when mode is "${phase.voltage.mode}"`,
        });
      }
      if (phase.durationMs % scenario.intervalMs !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["phases", index, "durationMs"],
          message: `durationMs must be a whole number of ${scenario.intervalMs}ms ticks`,
        });
      }
    }
  });

export type EnergySource = (typeof ENERGY_SOURCES)[number];
export type ServedLoads = (typeof SERVED_LOADS)[number];
export type VoltageMode = (typeof VOLTAGE_MODES)[number];
export type ScenarioPhase = z.infer<typeof phaseSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;

export function parseScenario(input: unknown, label: string): Scenario {
  const result = scenarioSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid scenario ${label} — ${detail}`);
  }
  return result.data;
}

export function totalTicks(scenario: Scenario): number {
  const durationMs = scenario.phases.reduce((sum, phase) => sum + phase.durationMs, 0);
  return durationMs / scenario.intervalMs;
}

/** The phase covering a tick, and how far into it the tick falls. */
export function phaseAt(scenario: Scenario, tickIndex: number): ScenarioPhase {
  let elapsedMs = tickIndex * scenario.intervalMs;
  for (const phase of scenario.phases) {
    if (elapsedMs < phase.durationMs) {
      return phase;
    }
    elapsedMs -= phase.durationMs;
  }
  const last = scenario.phases.at(-1);
  if (last === undefined) {
    throw new Error("scenario has no phases");
  }
  return last;
}
