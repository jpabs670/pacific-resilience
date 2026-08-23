import * as z from "zod";
import { SCHEMA_VERSION, type TelemetryEnvelope, telemetryEnvelopeSchema } from "./envelope.js";
import {
  ContractValidationError,
  type ParseResult,
  type SafeParseOutcome,
  toParseResult,
} from "./errors.js";
import { gatewayIdSchema } from "./identifiers.js";
import { addIssue } from "./issue.js";

/** Readings cross the network in batches, never singly. */
export const MAX_BATCH_READINGS = 1000;

const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const batchObject = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  gatewayId: gatewayIdSchema,
  sequenceStart: sequenceSchema,
  sequenceEnd: sequenceSchema,
  /** The gateway's own offset estimate; may be negative. */
  clockOffsetMs: z.number().int(),
  readings: z.array(telemetryEnvelopeSchema),
});

export const telemetryBatchSchema = batchObject.superRefine((batch, ctx) => {
  if (batch.readings.length === 0) {
    addIssue(ctx, "batch.readings.empty", "a batch must carry at least one reading", ["readings"]);
  } else if (batch.readings.length > MAX_BATCH_READINGS) {
    addIssue(
      ctx,
      "batch.readings.too_many",
      `a batch carries at most ${MAX_BATCH_READINGS} readings, received ${batch.readings.length}`,
      ["readings"],
    );
  }

  if (batch.sequenceEnd < batch.sequenceStart) {
    addIssue(
      ctx,
      "batch.sequence.range",
      "sequenceEnd must be greater than or equal to sequenceStart",
      ["sequenceEnd"],
    );
    return;
  }

  /**
   * The gateway flushes a contiguous unacknowledged range, so the span and the
   * reading count must agree. A mismatch means the batch does not describe what
   * it contains, which would make `ackedThrough` ambiguous.
   */
  const span = batch.sequenceEnd - batch.sequenceStart + 1;
  if (batch.readings.length > 0 && span !== batch.readings.length) {
    addIssue(
      ctx,
      "batch.sequence.span_mismatch",
      `sequence span ${span} does not match ${batch.readings.length} readings; the flushed range must be contiguous`,
      ["sequenceEnd"],
    );
  }
});

export type TelemetryBatch = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly gatewayId: string;
  readonly sequenceStart: number;
  readonly sequenceEnd: number;
  readonly clockOffsetMs: number;
  readonly readings: readonly TelemetryEnvelope[];
};

export function safeParseTelemetryBatch(input: unknown): ParseResult<TelemetryBatch> {
  return toParseResult<TelemetryBatch>(telemetryBatchSchema.safeParse(input) as SafeParseOutcome);
}

export function parseTelemetryBatch(input: unknown): TelemetryBatch {
  const result = safeParseTelemetryBatch(input);
  if (!result.ok) {
    throw new ContractValidationError(result.issues);
  }
  return result.value;
}
