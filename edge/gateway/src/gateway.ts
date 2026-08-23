import {
  GATEWAY_ID_PATTERN,
  gatewayIdSchema,
  MAX_BATCH_READINGS,
  parseTelemetryBatch,
  type TelemetryBatch,
} from "@pacific-resilience/contracts";
import { validateAck } from "./acknowledgement.js";
import { type BackoffOptions, DEFAULT_BACKOFF, nextDelayMs } from "./backoff.js";
import type { ActiveQuarantine, Outbox } from "./outbox.js";
import type { BatchAck, BatchTransport, SendOutcome } from "./transport.js";

/**
 * Flush engine.
 *
 * At-least-once delivery from the edge, combined with idempotent upsert keyed on
 * each reading's opaque id, yields exactly-once effect. Exactly-once *delivery* is
 * not attempted — it is not achievable over an unreliable network, and pretending
 * otherwise produces systems that lose data while claiming they cannot.
 *
 * The engine never deletes, rewrites, or reorders a reading. A retry re-reads the
 * same outbox rows and therefore resends byte-identical ids.
 */

export type GatewayOptions = {
  readonly outbox: Outbox;
  readonly transport: BatchTransport;
  readonly gatewayId: string;
  readonly batchMaxReadings?: number;
  readonly backoff?: BackoffOptions;
  /** The gateway's own clock-offset estimate; 0 when unknown. */
  readonly clockOffsetMs?: number;
};

export type FlushResult =
  | { readonly kind: "idle" }
  | {
      readonly kind: "flushed";
      readonly sequenceStart: number;
      readonly sequenceEnd: number;
      readonly ack: BatchAck;
      readonly ackedThrough: number;
    }
  | {
      readonly kind: "deferred";
      readonly sequenceStart: number;
      readonly sequenceEnd: number;
      readonly attempt: number;
      readonly delayMs: number;
      readonly reason: string;
    }
  | {
      readonly kind: "quarantined";
      readonly sequenceStart: number;
      readonly sequenceEnd: number;
      readonly reason: string;
      /** The hold blocking this range, including how long it has been held. */
      readonly hold: ActiveQuarantine;
    }
  /**
   * The server answered "accepted" with an acknowledgement that cannot be true.
   * Distinct from `quarantined` because the cause is different in kind: the
   * readings are fine and the transport worked — the peer is misbehaving.
   */
  | {
      readonly kind: "protocol_violation";
      readonly sequenceStart: number;
      readonly sequenceEnd: number;
      readonly reason: string;
      /** Stable contract codes, so violations can be counted by cause. */
      readonly codes: readonly string[];
      readonly hold: ActiveQuarantine;
    };

export class Gateway {
  private readonly outbox: Outbox;
  private readonly transport: BatchTransport;
  private readonly gatewayId: string;
  private readonly batchMaxReadings: number;
  private readonly backoff: BackoffOptions;
  private readonly clockOffsetMs: number;
  private attempt = 0;

  constructor(options: GatewayOptions) {
    const limit = options.batchMaxReadings ?? MAX_BATCH_READINGS;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_BATCH_READINGS) {
      throw new Error(`batchMaxReadings must be an integer in 1..${MAX_BATCH_READINGS}`);
    }
    /**
     * Configuration is checked here rather than discovered on the first flush.
     *
     * Both of these are batch fields, so a bad value would otherwise pass
     * construction, let the outbox accumulate readings, and then throw out of every
     * flush cycle — a misconfiguration that presents as a delivery outage. The
     * schema that will reject it at the boundary is the one used to reject it now.
     */
    if (!gatewayIdSchema.safeParse(options.gatewayId).success) {
      throw new Error(`gatewayId does not match ${GATEWAY_ID_PATTERN}: ${options.gatewayId}`);
    }
    const offset = options.clockOffsetMs ?? 0;
    if (!Number.isInteger(offset)) {
      throw new Error(`clockOffsetMs must be an integer, received ${String(offset)}`);
    }
    this.outbox = options.outbox;
    this.transport = options.transport;
    this.gatewayId = options.gatewayId;
    this.batchMaxReadings = limit;
    this.backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.clockOffsetMs = options.clockOffsetMs ?? 0;
  }

  /** Consecutive failed attempts against the current range. Zero when healthy. */
  currentAttempt(): number {
    return this.attempt;
  }

  /**
   * One flush cycle. Never throws for a transport failure; a failure is a result.
   *
   * A quarantined range is not retried blindly. The cursor stays put, so the
   * failure stays visible instead of turning into skipped readings.
   */
  async flushOnce(): Promise<FlushResult> {
    const hold = this.outbox.activeQuarantine();
    const rows = this.outbox.readContiguousUnacked(this.batchMaxReadings);
    if (rows.length === 0) {
      return { kind: "idle" };
    }

    const sequenceStart = rows[0]?.sequence ?? 0;
    const sequenceEnd = rows[rows.length - 1]?.sequence ?? 0;

    if (hold !== undefined && hold.fromSequence <= sequenceEnd) {
      // Report the reason recorded when the hold was raised, not a restatement of
      // the fact that it exists. The original diagnosis is what an operator needs,
      // and it is still true however many cycles have passed since.
      return { kind: "quarantined", sequenceStart, sequenceEnd, reason: hold.reason, hold };
    }

    // Validate what we are about to send. The contiguous read guarantees the
    // sequence span matches the reading count; a failure here is a defect in this
    // package, not bad input, so it throws rather than becoming a retry.
    const batch = parseTelemetryBatch({
      schemaVersion: 1,
      gatewayId: this.gatewayId,
      sequenceStart,
      sequenceEnd,
      clockOffsetMs: this.clockOffsetMs,
      readings: rows.map((row) => row.envelope),
    });

    const outcome = await this.send(batch);

    if (outcome.kind === "accepted") {
      const validation = validateAck(outcome.ack, sequenceStart, sequenceEnd);
      if (validation.kind === "invalid") {
        return this.violation(sequenceStart, sequenceEnd, validation.reason, validation.codes);
      }

      const result = this.outbox.acknowledgeThrough(validation.ackedThrough);
      if (result.kind === "refused") {
        // Unreachable through a validated acknowledgement: the range was read
        // contiguously from the cursor, so it cannot rewind, gap, or overrun.
        // Kept as a hard stop rather than an assertion — if the outbox and the
        // validator ever disagree, the cursor must not move on the strength of
        // one of them.
        return this.violation(
          sequenceStart,
          sequenceEnd,
          `outbox refused acknowledgement through ${validation.ackedThrough}: ${result.reason}`,
          [`outbox.refused.${result.reason}`],
        );
      }

      this.attempt = 0;
      return {
        kind: "flushed",
        sequenceStart,
        sequenceEnd,
        ack: outcome.ack,
        ackedThrough: result.ackedThrough,
      };
    }

    if (outcome.kind === "permanent") {
      const raised = this.outbox.quarantine({
        fromSequence: sequenceStart,
        throughSequence: sequenceEnd,
        kind: "permanent",
        reason: outcome.reason,
      });
      return {
        kind: "quarantined",
        sequenceStart,
        sequenceEnd,
        reason: outcome.reason,
        hold: raised,
      };
    }

    this.attempt += 1;
    return {
      kind: "deferred",
      sequenceStart,
      sequenceEnd,
      attempt: this.attempt,
      delayMs: nextDelayMs(this.attempt, this.backoff),
      reason: outcome.reason,
    };
  }

  /**
   * Send, and hold the transport to its contract.
   *
   * A transport is specified to report failure as an outcome rather than throw, so
   * that the flush decision table stays exhaustive. Every realistic implementation
   * will break that promise sooner or later — an HTTP client throws on a DNS failure
   * or an aborted socket long before it gets a status code to report — and an
   * unhandled rejection here would take down the flush loop for a condition that is
   * simply "the network is down".
   *
   * A thrown error is therefore treated as retryable. That is the safe reading: it
   * preserves every reading, advances nothing, and lets backoff do its job. The
   * message is carried through so the cause is still visible in the result.
   */
  private async send(batch: TelemetryBatch): Promise<SendOutcome> {
    try {
      return await this.transport.send(batch);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { kind: "retryable", reason: `transport threw: ${detail}` };
    }
  }

  /**
   * Record an unusable acknowledgement. Nothing is acknowledged, nothing is
   * deleted, and the range is held so the next cycle stops here instead of
   * resending into a peer that has already answered incorrectly once.
   *
   * The attempt counter is left alone: it counts transport failures, and the
   * transport did not fail. Backoff is the wrong instrument for a peer that
   * answers promptly and wrongly.
   */
  private violation(
    sequenceStart: number,
    sequenceEnd: number,
    reason: string,
    codes: readonly string[],
  ): FlushResult {
    const hold = this.outbox.quarantine({
      fromSequence: sequenceStart,
      throughSequence: sequenceEnd,
      kind: "protocol_violation",
      reason,
    });
    return { kind: "protocol_violation", sequenceStart, sequenceEnd, reason, codes, hold };
  }
}
