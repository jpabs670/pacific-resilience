import type { BatchAck, TelemetryBatch } from "@pacific-resilience/contracts";

/**
 * Batch transport boundary.
 *
 * Phase 2 defines the interface and ships **no** implementation. There is no HTTP
 * client, no socket, and no device channel in this package: the ingest endpoint
 * does not exist yet, and adding a network client now would put an untestable
 * dependency in the durability path. The flush engine is written against this
 * interface and is exercised by in-memory doubles.
 *
 * When the ingest API arrives, the transport it gets is plain HTTP over loopback
 * for the local simulated environment only — TLS and per-gateway authentication
 * become mandatory before any gateway communicates across a network.
 */

/**
 * Re-exported, not redeclared. The acknowledgement is one half of a boundary the
 * ingest API owns the other half of, so its shape and its invariants live in
 * `@pacific-resilience/contracts`; a second copy here would be a second thing to
 * keep in step. See that package's `ack.ts` for why the counters describe the
 * acknowledged prefix rather than the request.
 */
export type { BatchAck };

/**
 * A transport reports outcomes rather than throwing, so the flush engine's
 * decision table is exhaustive and every branch is reachable in a test.
 */
export type SendOutcome =
  | { readonly kind: "accepted"; readonly ack: BatchAck }
  /** Transient: retry the identical range. Lost response, timeout, 5xx. */
  | { readonly kind: "retryable"; readonly reason: string }
  /** Permanent: retrying will never succeed. Malformed batch, unknown entity, reused id. */
  | { readonly kind: "permanent"; readonly reason: string };

export type BatchTransport = {
  send(batch: TelemetryBatch): Promise<SendOutcome>;
};
