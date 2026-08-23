import * as z from "zod";
import { addIssue } from "./issue.js";

/**
 * Closed unit registry. Base units only in storage and on the wire — watts not
 * kilowatts, watt-hours not kilowatt-hours, seconds not hours. A single storage
 * unit per quantity removes an entire class of factor-of-1000 defect; display
 * may scale freely. `percent` is 0-100, not 0-1.
 */
export const UNITS = ["V", "Hz", "W", "Wh", "percent", "s"] as const;

export type Unit = (typeof UNITS)[number];

const UNIT_SET: ReadonlySet<string> = new Set(UNITS);

export function isUnit(value: string): value is Unit {
  return UNIT_SET.has(value);
}

export const unitSchema = z.string().superRefine((value, ctx) => {
  if (!isUnit(value)) {
    addIssue(ctx, "unit.unknown", `unknown unit "${value}"; expected one of ${UNITS.join(", ")}`);
  }
});
