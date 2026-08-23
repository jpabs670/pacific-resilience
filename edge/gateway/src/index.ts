/**
 * `@pacific-resilience/gateway` — durable buffering and synchronisation.
 *
 * Constraints, asserted by `test/architecture.test.ts`:
 *
 * - Read-only toward physical equipment. Nothing here commands a breaker,
 *   generator, transfer switch, battery, or utility asset, and no device, serial,
 *   or vendor channel exists to command one through.
 * - No *unsent* reading is deleted, rewritten, or reordered, and a retry resends
 *   byte-identical reading ids. Acknowledged rows may be reclaimed to bound disk;
 *   the single `DELETE` in the outbox cannot match an unacknowledged row.
 * - Acknowledgement advances only through a contiguous prefix, and only after the
 *   server's acknowledgement is proved internally consistent against the range
 *   that was actually transmitted.
 * - At capacity the outbox reclaims delivered rows and, failing that, refuses the
 *   new tick rather than discarding an unsent one.
 * - A quarantined range is held, never skipped. The only exit is an attributable
 *   release that retries the same readings; no operation advances the cursor past
 *   a held range.
 */

export { type AckValidation, validateAck } from "./acknowledgement.js";
export {
  type BackoffOptions,
  DEFAULT_BACKOFF,
  nextDelayMs,
} from "./backoff.js";
export { type FlushResult, Gateway, type GatewayOptions } from "./gateway.js";
export {
  type AckOutcome,
  type ActiveQuarantine,
  type AppendResult,
  META_ACKED_THROUGH,
  META_LAST_SEQUENCE,
  OUTBOX_PRAGMAS,
  OUTBOX_SCHEMA,
  Outbox,
  type OutboxCounts,
  type OutboxOptions,
  type OutboxRow,
  type QuarantineKind,
  type QuarantineRecord,
  type QuarantineStatus,
  type ReleaseOutcome,
  type ReleaseRequest,
} from "./outbox.js";
export type { BatchAck, BatchTransport, SendOutcome } from "./transport.js";
