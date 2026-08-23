import * as z from "zod";
import { addIssue } from "./issue.js";
import { STATE_DOMAINS } from "./metrics.js";
import { unitSchema } from "./units.js";

/**
 * A discriminated union rather than a nullable value plus a nullable state.
 *
 * `source.active` is not a number, and a shape permitting both fields to be null
 * would make an unrepresentable state representable. The discriminant is what
 * lets the validator reject nonsense instead of storing it.
 */

export const numericSampleSchema = z
  .strictObject({
    kind: z.literal("numeric"),
    value: z.number(),
    unit: unitSchema,
  })
  .superRefine((sample, ctx) => {
    if (!Number.isFinite(sample.value)) {
      addIssue(ctx, "sample.value.not_finite", "sample value must be a finite number", ["value"]);
    }
  });

export const stateSampleSchema = z.strictObject({
  kind: z.literal("state"),
  state: z.string().min(1),
  domain: z.enum(STATE_DOMAINS),
});

export const sampleSchema = z.discriminatedUnion("kind", [numericSampleSchema, stateSampleSchema]);

export type NumericSample = z.infer<typeof numericSampleSchema>;
export type StateSample = z.infer<typeof stateSampleSchema>;
export type Sample = NumericSample | StateSample;
