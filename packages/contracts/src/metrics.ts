import * as z from "zod";
import { addIssue } from "./issue.js";
import type { Unit } from "./units.js";

/**
 * Closed metric registry. Adding a metric is an additive schema change; an
 * unregistered metric is rejected at the boundary.
 *
 * Ranges are advisory, not gates: an out-of-range voltage may be the single most
 * important reading in an outage, so it is accepted and flagged rather than
 * rejected. See `isOutOfRange`.
 */

export const STATE_DOMAINS = ["energy_source", "link_state"] as const;
export type StateDomain = (typeof STATE_DOMAINS)[number];

export type NumericMetricSpec = {
  readonly kind: "numeric";
  readonly unit: Unit;
  readonly min: number;
  readonly max?: number;
};

export type StateMetricSpec = {
  readonly kind: "state";
  readonly domain: StateDomain;
  readonly values: readonly string[];
};

export type MetricSpec = NumericMetricSpec | StateMetricSpec;

/**
 * `unknown` is deliberately distinct from `none` in `energy_source`: "we cannot
 * tell what is supplying power" and "nothing is supplying power" are different
 * facts, and conflating them would fabricate outages. `solar` is present though
 * absent at Site 001, so the domain does not have to widen later.
 */
const METRIC_REGISTRY = {
  "voltage.rms": { kind: "numeric", unit: "V", min: 0, max: 300 },
  frequency: { kind: "numeric", unit: "Hz", min: 0, max: 70 },
  "load.site.active_power": { kind: "numeric", unit: "W", min: 0 },
  "load.refrigerator.active_power": { kind: "numeric", unit: "W", min: 0 },
  "load.starlink.active_power": { kind: "numeric", unit: "W", min: 0 },
  "battery.state_of_charge": { kind: "numeric", unit: "percent", min: 0, max: 100 },
  "battery.runtime_remaining": { kind: "numeric", unit: "s", min: 0 },
  "source.active": {
    kind: "state",
    domain: "energy_source",
    values: ["utility", "generator", "battery", "solar", "none", "unknown"],
  },
  "gateway.link": {
    kind: "state",
    domain: "link_state",
    values: ["online", "offline", "unknown"],
  },
} as const satisfies Record<string, MetricSpec>;

export type MetricName = keyof typeof METRIC_REGISTRY;

export const METRIC_NAMES: readonly MetricName[] = Object.keys(METRIC_REGISTRY) as MetricName[];

const SPECS: ReadonlyMap<string, MetricSpec> = new Map<string, MetricSpec>(
  Object.entries(METRIC_REGISTRY),
);

export function metricSpec(name: string): MetricSpec | undefined {
  return SPECS.get(name);
}

export function isMetricName(name: string): name is MetricName {
  return SPECS.has(name);
}

/**
 * Whether a numeric value falls outside its metric's declared range.
 *
 * Callers attach the `out_of_range` quality flag; this package does not mutate
 * records. Returns false for unknown or state metrics.
 */
export function isOutOfRange(metric: string, value: number): boolean {
  const spec = metricSpec(metric);
  if (spec === undefined || spec.kind !== "numeric") {
    return false;
  }
  if (value < spec.min) {
    return true;
  }
  return spec.max !== undefined && value > spec.max;
}

export const metricSchema = z.string().superRefine((value, ctx) => {
  if (!isMetricName(value)) {
    addIssue(ctx, "metric.unknown", `unregistered metric "${value}"`);
  }
});
