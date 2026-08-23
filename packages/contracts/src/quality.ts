import * as z from "zod";
import { addIssue } from "./issue.js";

/**
 * Advisory flags attached by whichever component observed the condition. Flags
 * qualify a reading; they never suppress it.
 */
export const QUALITY_FLAGS = [
  "clock_suspect",
  "sensor_fault",
  "out_of_range",
  "interpolated",
  "first_after_gap",
] as const;

export type QualityFlag = (typeof QUALITY_FLAGS)[number];

export const qualityFlagSchema = z.enum(QUALITY_FLAGS);

/** Present means non-empty and deduplicated; omit the field rather than sending `[]`. */
export const qualitySchema = z.array(qualityFlagSchema).superRefine((flags, ctx) => {
  if (flags.length === 0) {
    addIssue(ctx, "quality.empty", "omit quality entirely rather than sending an empty array");
    return;
  }
  const seen = new Set<QualityFlag>();
  for (const [index, flag] of flags.entries()) {
    if (seen.has(flag)) {
      addIssue(ctx, "quality.duplicate", `duplicate quality flag "${flag}"`, [index]);
    }
    seen.add(flag);
  }
});
