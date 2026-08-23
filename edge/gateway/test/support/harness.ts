import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelemetryBatch, TelemetryEnvelope } from "@pacific-resilience/contracts";
import { Outbox } from "../../src/outbox.js";
import type { BatchAck, BatchTransport, SendOutcome } from "../../src/transport.js";

/** Reserved synthetic block, shared with the contracts fixtures. */
const RESERVED_PREFIX = "00000000-0000-4000-8000-";

let idCounter = 0;

export function nextReadingId(): string {
  idCounter += 1;
  return `${RESERVED_PREFIX}${String(idCounter).padStart(12, "0")}`;
}

/**
 * A synthetic, schema-valid reading. Built locally rather than imported from the
 * simulator: `edge/*` packages never depend on each other (ADR 0004).
 */
export function reading(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  return {
    schemaVersion: 1,
    readingId: nextReadingId(),
    siteId: "site_001",
    sourceId: "src_001_sim_panel",
    metric: "voltage.rms",
    capturedAt: "2026-07-26T04:15:30.250Z",
    sample: { kind: "numeric", value: 118.4, unit: "V" },
    origins: ["simulated"],
    derivation: "direct",
    ...overrides,
  } as TelemetryEnvelope;
}

export function readings(count: number): TelemetryEnvelope[] {
  return Array.from({ length: count }, () => reading());
}

export type Harness = {
  readonly path: string;
  outbox: Outbox;
  /** Abandon the handle without closing, then reopen — the restart case. */
  reopenAfterAbandon(maxReadings?: number): Outbox;
  reopen(maxReadings?: number): Outbox;
  cleanup(): void;
};

export function openHarness(maxReadings = 10_000, now?: () => number): Harness {
  const dir = mkdtempSync(join(tmpdir(), "pr-outbox-"));
  const path = join(dir, "outbox.sqlite");
  const options = now === undefined ? { path, maxReadings } : { path, maxReadings, now };
  let current = Outbox.open(options);

  const harness: Harness = {
    path,
    get outbox() {
      return current;
    },
    set outbox(next: Outbox) {
      current = next;
    },
    reopen(nextMax = maxReadings) {
      current.close();
      current = Outbox.open({ path, maxReadings: nextMax });
      return current;
    },
    reopenAfterAbandon(nextMax = maxReadings) {
      // No close(): the previous handle is simply dropped, as it would be if the
      // process had gone away.
      current = Outbox.open({ path, maxReadings: nextMax });
      return current;
    },
    cleanup() {
      try {
        current.close();
      } catch {
        // Already closed.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Transport doubles. Phase 2 ships no real transport, so every flush path is
// exercised through these.
// ---------------------------------------------------------------------------

export type RecordingTransport = BatchTransport & {
  readonly sent: TelemetryBatch[];
  sentReadingIds(): string[][];
};

function record(
  sent: TelemetryBatch[],
  respond: (batch: TelemetryBatch, attempt: number) => SendOutcome,
): RecordingTransport {
  return {
    sent,
    sentReadingIds: () => sent.map((batch) => batch.readings.map((r) => r.readingId)),
    send(batch) {
      sent.push(batch);
      return Promise.resolve(respond(batch, sent.length));
    },
  };
}

export function acceptAll(): RecordingTransport {
  return record([], (batch) => ({
    kind: "accepted",
    ack: {
      ackedThrough: batch.sequenceEnd,
      received: batch.readings.length,
      inserted: batch.readings.length,
      duplicate: 0,
    },
  }));
}

/**
 * Accepts, but acknowledges only part of the range — a partial durable write.
 *
 * The counters are derived from `ackedThrough` rather than from the batch length,
 * because a server that stored a prefix reports the prefix it stored. Reporting
 * the whole batch alongside a partial cursor is precisely the inconsistency the
 * gateway now rejects, so a double that did so could not stand in for a
 * well-behaved server.
 */
export function acceptPartially(ackedThrough: number): RecordingTransport {
  return record([], (batch) => {
    const received = ackedThrough - batch.sequenceStart + 1;
    return {
      kind: "accepted",
      ack: { ackedThrough, received, inserted: received, duplicate: 0 },
    };
  });
}

/**
 * Accepts with an acknowledgement the test dictates outright, consistent or not.
 * Used to drive misbehaving-peer cases without weakening the honest doubles.
 */
export function acceptWithAck(build: (batch: TelemetryBatch) => BatchAck): RecordingTransport {
  return record([], (batch) => ({ kind: "accepted", ack: build(batch) }));
}

export function alwaysRetryable(reason = "connection reset"): RecordingTransport {
  return record([], () => ({ kind: "retryable", reason }));
}

export function alwaysPermanent(reason = "422 unknown source"): RecordingTransport {
  return record([], () => ({ kind: "permanent", reason }));
}

/** Fails the first `failures` attempts, then accepts. */
export function failThenAccept(failures: number): RecordingTransport {
  return record([], (batch, attempt) =>
    attempt <= failures
      ? { kind: "retryable", reason: `attempt ${attempt} failed` }
      : {
          kind: "accepted",
          ack: {
            ackedThrough: batch.sequenceEnd,
            received: batch.readings.length,
            inserted: batch.readings.length,
            duplicate: 0,
          },
        },
  );
}

/** Lets a test inspect durable state at the moment of transmission. */
export function inspecting(
  observe: (batch: TelemetryBatch) => void,
  inner: RecordingTransport = acceptAll(),
): RecordingTransport {
  return {
    sent: inner.sent,
    sentReadingIds: () => inner.sentReadingIds(),
    send(batch) {
      observe(batch);
      return inner.send(batch);
    },
  };
}

/** Deterministic jitter for backoff assertions. */
export const noJitter = () => 0;
