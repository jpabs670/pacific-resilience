import * as z from "zod";
import {
  ContractValidationError,
  type ParseResult,
  type SafeParseOutcome,
  toParseResult,
} from "./errors.js";
import { addIssue, type RefinementSink } from "./issue.js";

/**
 * Batch acknowledgement — the response half of the telemetry batch boundary.
 *
 * It lives beside `telemetryBatchSchema` on purpose. The acknowledgement is the
 * one input that decides how far a gateway's outbox cursor advances, and an
 * over-advanced cursor makes readings that were never stored eligible for
 * reclamation. If the gateway and the ingest API each carried their own idea of
 * this shape, the two would drift and the drift would be silent data loss. One
 * schema, used by the sender to verify and by the receiver to construct.
 *
 * ## The counters describe the acknowledged prefix, not the request
 *
 * This is the contract's load-bearing decision. `received` counts the readings
 * covered by `ackedThrough`, so it is derivable from the position the server
 * claims — which is precisely what lets the response cross-check itself:
 *
 *     received === ackedThrough - sequenceStart + 1
 *
 * Had `received` meant "envelopes in the request", it would carry no information
 * about `ackedThrough` and could not contradict it, so a server claiming to have
 * stored more than it was sent would be indistinguishable from a healthy one.
 * A server that durably stored only part of a batch therefore reports the part it
 * stored. A server wanting to report how much it *received* on the wire needs a
 * different field; this one is spoken for.
 *
 * ## An accepted batch acknowledges at least one reading
 *
 * `ackedThrough` must land inside the transmitted range, which makes "accepted,
 * but nothing was stored" unrepresentable. That state is a retryable failure and
 * belongs in a `5xx`, not in a success body — leaving it expressible here would
 * create a success response that means the same thing as an error.
 *
 * ## Strict by design
 *
 * Unknown keys are rejected, as everywhere else on this boundary. A field the
 * gateway does not understand is a version mismatch worth surfacing loudly, not
 * something to skip past while advancing a cursor on the rest of the message.
 *
 * Validation here is pure: no clock, no I/O, no identifier generation.
 */

const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const batchAckObject = z.strictObject({
  /** Highest sequence the server has durably committed. */
  ackedThrough: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  /** Readings covered by `ackedThrough` — not the size of the request. */
  received: countSchema,
  /** Newly stored. */
  inserted: countSchema,
  /** `readingId` already present with an identical payload — a no-op. */
  duplicate: countSchema,
  /** Stored, but held with quality flags. Omitted by a server that flags nothing. */
  flagged: countSchema.optional(),
});

/**
 * Invariants that hold whatever range was transmitted.
 *
 * Kept separate from the range checks so a server can validate a response it is
 * about to send, before it knows anything about the caller's bookkeeping.
 */
function checkTotals(ack: z.infer<typeof batchAckObject>, sink: RefinementSink): void {
  if (ack.inserted + ack.duplicate !== ack.received) {
    addIssue(
      sink,
      "ack.totals.mismatch",
      `inserted ${ack.inserted} plus duplicate ${ack.duplicate} does not equal received ${ack.received}`,
      ["received"],
    );
  }
  // `flagged` marks readings stored but held for review: a subset of what was
  // received, never a separate population added to it.
  if (ack.flagged !== undefined && ack.flagged > ack.received) {
    addIssue(
      sink,
      "ack.flagged.exceeds_received",
      `flagged ${ack.flagged} exceeds received ${ack.received}`,
      ["flagged"],
    );
  }
}

export const batchAckSchema = batchAckObject.superRefine((ack, ctx) => {
  checkTotals(ack, ctx);
});

export type BatchAck = {
  readonly ackedThrough: number;
  readonly received: number;
  readonly inserted: number;
  readonly duplicate: number;
  readonly flagged?: number;
};

/** The sequence span a batch actually carried. */
export type SequenceRange = {
  readonly sequenceStart: number;
  readonly sequenceEnd: number;
};

/**
 * A malformed range is a defect in the caller, not untrusted input, so it throws
 * rather than becoming a validation issue an operator would have to interpret.
 */
function assertRange(range: SequenceRange): void {
  const { sequenceStart, sequenceEnd } = range;
  if (!Number.isInteger(sequenceStart) || !Number.isInteger(sequenceEnd)) {
    throw new RangeError("sequenceStart and sequenceEnd must be integers");
  }
  if (sequenceStart < 0) {
    throw new RangeError(`sequenceStart must be non-negative, received ${sequenceStart}`);
  }
  if (sequenceEnd < sequenceStart) {
    throw new RangeError(
      `sequenceEnd ${sequenceEnd} must be greater than or equal to sequenceStart ${sequenceStart}`,
    );
  }
}

/**
 * The acknowledgement schema for one transmitted range.
 *
 * Built per call because the invariants are relative to the range: the same body
 * is valid against the batch that carried it and invalid against any other.
 */
export function batchAckSchemaForRange(range: SequenceRange) {
  assertRange(range);
  const { sequenceStart, sequenceEnd } = range;

  return batchAckObject.superRefine((ack, ctx) => {
    // Position first: `received` is checked against `ackedThrough`, so an
    // out-of-range cursor would otherwise produce a second, derivative complaint
    // about a count that was never the real problem.
    if (ack.ackedThrough < sequenceStart || ack.ackedThrough > sequenceEnd) {
      addIssue(
        ctx,
        "ack.acked_through.out_of_range",
        `ackedThrough ${ack.ackedThrough} is outside the transmitted range ${sequenceStart}..${sequenceEnd}`,
        ["ackedThrough"],
      );
      checkTotals(ack, ctx);
      return;
    }

    const covered = ack.ackedThrough - sequenceStart + 1;
    if (ack.received !== covered) {
      addIssue(
        ctx,
        "ack.received.mismatch",
        `received ${ack.received} contradicts ackedThrough ${ack.ackedThrough}, which covers ${covered} of the transmitted readings`,
        ["received"],
      );
    }
    checkTotals(ack, ctx);
  });
}

/** Shape and range-independent totals only. For a server checking its own reply. */
export function safeParseBatchAck(input: unknown): ParseResult<BatchAck> {
  return toParseResult<BatchAck>(batchAckSchema.safeParse(input) as SafeParseOutcome);
}

export function parseBatchAck(input: unknown): BatchAck {
  const result = safeParseBatchAck(input);
  if (!result.ok) {
    throw new ContractValidationError(result.issues);
  }
  return result.value;
}

/** Full validation against the range the batch actually carried. */
export function safeParseBatchAckForRange(
  input: unknown,
  range: SequenceRange,
): ParseResult<BatchAck> {
  return toParseResult<BatchAck>(
    batchAckSchemaForRange(range).safeParse(input) as SafeParseOutcome,
  );
}

export function parseBatchAckForRange(input: unknown, range: SequenceRange): BatchAck {
  const result = safeParseBatchAckForRange(input, range);
  if (!result.ok) {
    throw new ContractValidationError(result.issues);
  }
  return result.value;
}
