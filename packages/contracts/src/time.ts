import * as z from "zod";
import { addIssue } from "./issue.js";

/**
 * RFC 3339, UTC, millisecond precision, `Z` suffix — exactly one wire form per
 * instant. Offsets other than `Z` are rejected rather than normalized, so a
 * wrong offset surfaces as an error instead of a silent shift.
 */
export const RFC3339_UTC_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const NUMERIC_OFFSET_SUFFIX = /[+-]\d{2}:?\d{2}$/;

export type TimestampProblem = { readonly code: string; readonly message: string };

/** Undefined when the value is a valid canonical timestamp. */
export function timestampProblem(value: string): TimestampProblem | undefined {
  if (!RFC3339_UTC_MS_PATTERN.test(value)) {
    if (NUMERIC_OFFSET_SUFFIX.test(value) || value.endsWith("z")) {
      return {
        code: "time.not_utc",
        message: "timestamp must be UTC with a literal uppercase Z suffix",
      };
    }
    return {
      code: "time.format",
      message: "timestamp must be RFC 3339 UTC with exactly three fractional digits",
    };
  }

  const parsed = new Date(value);
  const epochMs = parsed.getTime();
  if (Number.isNaN(epochMs) || parsed.toISOString() !== value) {
    return { code: "time.invalid_calendar", message: "timestamp is not a real calendar instant" };
  }

  return undefined;
}

export const timestampSchema = z.string().superRefine((value, ctx) => {
  const problem = timestampProblem(value);
  if (problem !== undefined) {
    addIssue(ctx, problem.code, problem.message);
  }
});

/** Epoch milliseconds for a validated timestamp. Throws on an invalid value. */
export function toEpochMs(value: string): number {
  const problem = timestampProblem(value);
  if (problem !== undefined) {
    throw new RangeError(`${problem.code}: ${problem.message} (${value})`);
  }
  return new Date(value).getTime();
}
