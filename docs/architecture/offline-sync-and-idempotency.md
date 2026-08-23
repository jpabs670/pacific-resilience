# Offline sync and idempotency

`CLAUDE.md` requires edge collection to tolerate intermittent connectivity and
synchronize idempotently. Site 001 makes this concrete: intermittent utility
outages, source transfers, and a Starlink uplink that can drop. The readings most
worth having are the ones taken while the connection was down.

The guarantee: **at-least-once delivery from the edge, combined with idempotent
upsert keyed on an opaque reading ID, yields exactly-once effect.** Neither half is
sufficient alone, and exactly-once *delivery* is not attempted — it is not
achievable over an unreliable network, and pretending otherwise produces systems
that lose data while claiming they cannot.

## Transport in Slice 0

Slice 0 runs on **one local machine**, with the gateway, ingest API, and dashboard
all on loopback, and no certificates of any kind.

- **Slice 0 uses plain HTTP over loopback** (`http://127.0.0.1:4000`). This is
  permitted **only** for the local simulated environment.
- Slice 0 implements **no TLS**, and this document claims no transport security
  from it. Nothing in Slice 0 rejects plaintext, because there is nothing to
  reject it in favour of.
- **Before any gateway communicates across a network — any listener beyond
  loopback, any real site — TLS and per-gateway authentication become mandatory.**
  These are requirements 1 and 2 in `../security/threat-model.md`, tripwired to the
  first non-loopback listener.

Batching, sequencing, durability, and idempotency are all transport-agnostic, so
adding TLS later changes configuration and deployment, not this protocol.

## Reading identity

Each reading carries an opaque `readingId` — a UUID from Node's built-in
`crypto.randomUUID()` — assigned **once**, when the reading is created, by the
component that created it. Full specification in `telemetry-envelope-v1.md`.

Three properties make the sync protocol work:

1. The ID is written into the outbox **with** the reading, before any transmission.
2. It is **reused unchanged on every retry**, so a resend is byte-identical.
3. The server uses it directly as the idempotency key and generates nothing.

`sequence` is a separate, transport-only field: it orders readings within a gateway
and drives acknowledgement. It is not part of a reading's identity, and it is not
stored on the reading. Conflating the two would make identity depend on delivery
order, which is exactly what must not happen when a gateway resends.

## Outbox

The gateway owns a durable append-only outbox.

```sql
CREATE TABLE outbox (
  sequence    INTEGER PRIMARY KEY,  -- monotonic per gateway, never reused
  reading_id  TEXT NOT NULL UNIQUE, -- assigned at creation, immutable
  payload     TEXT NOT NULL,        -- serialized envelope, immutable
  created_at  INTEGER NOT NULL,     -- epoch ms, gateway clock
  acked_at    INTEGER               -- NULL until server acknowledged
);
```

Invariants:

1. **Durable before network.** A reading is committed to the outbox before any send
   is attempted. This ordering is what the whole guarantee rests on: a reading that
   exists only in memory is a reading that a power loss deletes — at a site whose
   defining characteristic is power loss.
2. **Immutable.** `payload` and `reading_id` are never rewritten. A correction is a
   new reading with a new ID, not an edit.
3. **Monotonic, gap-free `sequence`.** Assigned by the outbox, never by the
   simulator, never reused. Gaps mean data loss and are an alertable defect.
4. **Bounded, and reclaimed from delivered rows first.** The cap bounds disk. On
   reaching it the outbox first deletes **acknowledged** rows, which are history
   rather than backlog because they are already safe at the other end. Only if that
   frees nothing does it refuse the tick and record the drop count.

   It never discards an unsent reading. On a resilience platform the oldest unsent
   readings are the outage itself; dropping them to keep recording the calm
   afterwards inverts the product's purpose. The guarantee is enforced by the single
   `DELETE` statement in the outbox, which cannot match an unacknowledged row, rather
   than by each caller remembering to be careful.

   Reclaiming on demand rather than leaving it to an operator is deliberate. Nothing
   else in Slice 0 prunes, so at the sampling cadence an entirely healthy gateway
   would otherwise fill with delivered rows within the hour and then start refusing
   live observations — a self-inflicted outage with no external cause.
5. **Writes take the SQLite write lock up front.** Every write path reads state and
   then commits a decision based on it: the capacity check, the sequence counter, the
   cursor, the active hold. Transactions are `IMMEDIATE`, so two handles on one file
   — which a supervisor restart produces routinely — serialise instead of one
   discovering at commit time that its read was stale.

### Durability mechanics

Durability comes from SQLite transactions and PRAGMA configuration, not from any
manual `fsync` call. Slice 0 performs no explicit `fsync`, and nothing here should
be read as promising one.

| PRAGMA | Outbox (edge) | Server store | Reason |
| --- | --- | --- | --- |
| `journal_mode` | `WAL` | `WAL` | Concurrent read during write; well-understood crash recovery |
| `synchronous` | `FULL` | `NORMAL` | See below |
| `busy_timeout` | `5000` | `5000` | Avoids spurious `SQLITE_BUSY` under WAL |
| `foreign_keys` | `ON` | `ON` | Lineage links must resolve |

`synchronous = FULL` on the outbox means SQLite flushes the WAL at **each commit**,
so a committed reading survives process crash and host power loss — to the extent
the operating system and storage hardware honour the flush, which a consumer device
with a volatile write cache may not fully. That caveat is stated rather than
papered over.

`synchronous = NORMAL` on the server store is the deliberate asymmetry: the server
store can be **re-fed from the edge**, because the gateway retains readings until
acknowledged. The outbox cannot be re-created from anywhere. Durability effort
belongs where loss is unrecoverable.

Readings are committed per sampling tick, one transaction per tick, not one per
reading. At the Slice 0 cadence of one tick per second this is a handful of commits
per second — negligible, and it keeps a tick's readings atomic.

## Flush protocol

```
      ┌── idle ──┐  interval elapsed / unsent rows exist
      │          ▼
      │      building ── read contiguous unacked range, cap 1000
      │          │
      │          ▼
      │       sending ── POST /v1/telemetry:batch   (HTTP, loopback in Slice 0)
      │        │  │  │
      │  2xx ──┘  │  └── 5xx / timeout / network → backoff, retry same range
      │           └───── 4xx / 409 → quarantine range, alert, do not retry blindly
      │  advance cursor to ackedThrough
      └──────────┘
```

1. Read the **contiguous** unacknowledged range from the cursor, up to 1000
   readings. Contiguity matters: out-of-order acknowledgement would make the cursor
   meaningless, and the boundary enforces it — `sequenceEnd - sequenceStart + 1`
   must equal `readings.length`, or the batch is rejected as not describing what it
   contains.
2. POST the batch.
3. On `2xx`, **validate the acknowledgement before it moves anything** (see
   *Response* below), then mark `acked_at` through `ackedThrough` and advance the
   cursor. An acknowledgement is the one input that decides how far the cursor
   advances, and an over-advanced cursor makes readings that were never stored
   eligible for pruning — so a `2xx` body is checked, not trusted. An
   acknowledgement that fails validation advances nothing, deletes nothing, and is
   reported as a protocol violation rather than a successful flush.
4. On `5xx`, timeout, or network failure, **retry the identical range** — identical
   bytes, identical `readingId`s. This is where at-least-once becomes safe: a retry
   after a lost response is indistinguishable from the first attempt, and both are
   no-ops after the first.
5. On `4xx` or `409`, the batch is malformed, references unknown entities, or has
   reused an ID. Retrying will never succeed. Quarantine the range, surface it, and
   do not advance the cursor past it — a permanently stuck cursor is a visible
   failure, whereas skipping is silent loss. See *Quarantine and recovery*.
6. Backoff: exponential from 1 s to a 5 min ceiling, with jitter. Jitter matters
   once multiple gateways share a site and a restoration reconnects them together.
   Backoff answers an *unreachable* server, so it is deliberately not applied to a
   peer that answers promptly and wrongly; that is a quarantine, not a wait.
7. A transport that throws rather than returning an outcome — an HTTP client on a DNS
   failure, an aborted socket — is treated as a `5xx`. Preserving everything and
   retrying is the safe reading of an unknown failure, and it keeps a network
   condition from terminating the flush loop.

### Response

```ts
type BatchAck = {
  ackedThrough: number;   // highest sequence durably stored
  received: number;       // envelopes covered by the acknowledged prefix
  inserted: number;       // newly stored
  duplicate: number;      // readingId already present, identical payload — no-op
  flagged?: number;       // stored, but held with quality flags
};
```

The counters describe **the acknowledged prefix, not the request**. A server that
durably stored only part of a batch reports the part it stored, so `received` is
derivable from the position it claims and must agree with it. Every field is
checked against the range the gateway actually transmitted:

| Rule | Rejects |
| --- | --- |
| `ackedThrough` is an integer in `sequenceStart..sequenceEnd` | a claim on readings never sent; a claim below the range, which reports success while acknowledging nothing |
| `received === ackedThrough - sequenceStart + 1` | counters that contradict the claimed position |
| `inserted + duplicate === received` | a response that does not describe a real write |
| `flagged <= received`, when present | a flag count larger than the population it flags |
| all counters are non-negative integers | `NaN`, fractions, negatives, non-numbers |

A response failing any rule is not a partial success to be salvaged: if the
counters cannot be reconciled, the position they accompany cannot be trusted
either. The gateway advances nothing, preserves every reading, quarantines the
range so the next cycle stops instead of resending into a peer that has already
answered incorrectly, and reports a diagnostic naming the values that failed.
Backoff is deliberately *not* applied — it answers an unreachable server, and this
server answered promptly and wrongly.

The shape and these rules live in `@pacific-resilience/contracts` (`src/ack.ts`),
beside `telemetryBatchSchema`, and are exported as `batchAckSchemaForRange`. The
gateway that verifies an acknowledgement and the ingest API that constructs one use
the same schema deliberately: if each carried its own copy, the two would drift, and
drift in this particular shape is silent data loss. Issue codes
(`ack.acked_through.out_of_range`, `ack.received.mismatch`, `ack.totals.mismatch`,
`ack.flagged.exceeds_received`) are stable, so violations can be counted by cause.

**On partial acknowledgement.** The Slice 0 server commits one transaction per batch,
so it will always acknowledge through `sequenceEnd` or fail the batch outright —
`ackedThrough` below the end is a state it cannot produce. The contract still defines
it, for two reasons. A server that later commits incrementally needs no gateway
change to be safe; and, more importantly, defining `received` in terms of the
acknowledged prefix is what lets the counters contradict the position at all. Had
`received` meant "envelopes in the request" it would carry no information about
`ackedThrough`, and a server claiming to have stored more than it was sent would be
indistinguishable from a healthy one — which is precisely the defect this rule set
was written to close.

A duplicate `readingId` whose payload **differs** is not counted here — it fails the
whole batch with `409`, because it means an ID was reused for a different
observation. See `telemetry-envelope-v1.md`; nothing is overwritten and nothing is
dropped.

Acknowledgement is sent **only after the server has durably committed**. An
acknowledgement before commit converts at-least-once into at-most-once and silently
loses data on server crash.

## Quarantine and recovery

A quarantine holds a range that cannot be delivered, so it stops being resent while
staying visible and intact. Two causes raise one:

| Kind | Cause | What is wrong |
| --- | --- | --- |
| `permanent` | `4xx` / `409` from the transport | the batch: malformed, unknown entity, reused ID |
| `protocol_violation` | an acknowledgement that failed validation | the peer: the readings and the transport were fine |

A hold records the range, the kind, the **reason as diagnosed at the time**, and when
it was raised. Re-raising an active hold is idempotent and keeps the original
timestamp and reason: age-of-oldest-hold is the number an operator escalates on, and
a retry must not reset the clock and make a day-old problem look new. Holds and their
releases are durable and survive restart — restarting the gateway is not a way to
clear one, and never destroys the record of one.

### Recovery is a release, and a release is a retry

There is exactly one exit, `Outbox.releaseQuarantine`, and it means *try this range
again*. It advances nothing and deletes nothing; the next flush re-reads the same rows
and resends byte-identical reading IDs. A release is therefore safe even when the
operator is wrong about the cause — the worst outcome is the same quarantine again,
with a second entry in the log recording the attempt.

A release requires three things, and refuses without them:

- `expectedFromSequence` — compare-and-set. Quarantine state outlives the session
  that read it, so a decision taken against one hold must not silently release a
  different one raised in the meantime. A mismatch returns `stale` with the hold that
  is actually active.
- `operator` — who authorised it. A release is never anonymous.
- `note` — what was done about the cause, for whoever reads the log next.

### There is deliberately no "skip"

No operation anywhere advances the cursor past a held range. That is the one
cheap-looking fix an operator under pressure would reach for, and it is silent data
loss wearing the costume of a recovery tool: the readings would still be in the
outbox, marked delivered, never sent. Abandoning observations must remain an explicit,
recorded decision — not a button on the gateway. `edge/gateway/test/architecture.test.ts`
fails the build if such an operation is added.

### Observability

`Outbox.quarantineStatus()` reports the active hold with its age in milliseconds, plus
cumulative raised and released counts. `Outbox.quarantineHistory()` returns the audit
trail, newest first, with each release's author and note. Between them they supply the
quarantine-event count and the age of the oldest stuck cursor that operating metrics
need, and they are the surface a health endpoint should read rather than inferring
state from log lines.

An operator tool or CLI is **not** part of Slice 0: the gateway ships no runner yet,
so a command would have nothing to attach to. The API above is the contract that tool
will call.

## Server-side idempotency

Ingest performs `INSERT … ON CONFLICT (reading_id) DO NOTHING` inside one
transaction per batch, then compares the stored payload digest against the incoming
one for each conflicting ID.

- The database enforces uniqueness on `reading_id`. An application-level check has a
  race between check and insert; a unique constraint does not.
- **There is no uniqueness constraint on `(site, source, metric, capturedAt)`.** Two
  valid readings may legitimately share a timestamp, and both are stored as
  distinct records. Duplicate suppression is the ID's job alone.
- Readings are immutable. No `UPDATE` path exists for a reading value anywhere in
  the codebase.
- The whole batch is one transaction. A partially applied batch would leave
  `ackedThrough` ambiguous.

## Clock skew

Site 001's gateway can lose time across a power loss, so `capturedAt` is not
trusted. Note that reading identity does not depend on it — an opaque ID is
unaffected by a wrong clock, whereas a timestamp-derived key would have been
corrupted by one.

1. The gateway estimates its offset from the server response's `Date` header and
   reports it as `clockOffsetMs`.
2. Readings whose gateway offset exceeded `EDGE_CLOCK_TOLERANCE_MS` are flagged
   `clock_suspect` — stored and usable, but visibly qualified.
3. `capturedAt` more than 24 h ahead of `receivedAt` is rejected as implausible; a
   gateway that thinks it is next week would corrupt every series it touches.
4. `receivedAt` is always the server clock and is authoritative for arrival
   ordering.
5. Backfill is normal and unlimited in the past. A gateway offline for three weeks
   must be able to deliver three weeks of readings, and no freshness rule may
   reject them.

> **TO CONFIRM (D14)** — clock offset tolerance before `clock_suspect` is flagged.
> Proposed: **2000 ms** (`EDGE_CLOCK_TOLERANCE_MS`). Sampling is at 1 s cadence, so
> an offset above two intervals can reorder observations relative to real events.

## Gateway liveness

Absence of data is itself a signal. The server records `lastSeenAt` per gateway and
derives `gateway.link`:

| Condition | State |
| --- | --- |
| Batch received within 3× flush interval | `online` |
| No batch beyond that | `offline` |
| No batch ever received | `unknown` |

A gateway going `offline` is **not** an outage and must never be rendered as one. It
means the platform cannot see the site — possibly because the uplink failed,
possibly because power failed. Conflating "we lost visibility" with "the site lost
power" would fabricate outages at a site whose outage record is the product.
`event-detection.md` treats visibility loss as a gap, not an event.

## Proof obligations

Slice 0 is not complete until each is a passing test.

| # | Property | Test |
| --- | --- | --- |
| P1 | Durability precedes network | Kill the process mid-flush; every reading committed before the kill is present in the outbox on restart |
| P2 | No loss across disconnect | Sever the link for N intervals; after restore the server holds exactly the readings the simulator produced |
| P3 | Replay is a no-op | POST an identical batch twice; second response is `inserted: 0`, `duplicate: n`; row count unchanged |
| P4 | Cursor never skips | On `4xx`/`409`, the cursor does not advance past the quarantined range; no operation exists that would, and releasing a hold retries the range rather than skipping it |
| P5 | Partial batch impossible | Inject a store failure mid-batch; zero rows committed |
| P6 | ID stability across retries | The `readingId` in the outbox is byte-identical in every retransmission of the same reading |
| P7 | Backfill accepted | Deliver 21 days of buffered readings in one session; none rejected for age |
| P8 | Shared timestamps both stored | Two readings with the same `(site, source, metric, capturedAt)` and different IDs are both stored as distinct rows |
| P9 | Bounded outbox refuses rather than discards | Fill to cap; oldest unsent readings survive, drop count increments |
| P10 | ID reuse is surfaced, not resolved | Send a stored `readingId` with a different payload; `409`, batch rejected, stored row unchanged, nothing dropped silently |

P8 and P10 are the pair that replaced the previous coordinate-keyed design. Together
they assert the property that matters: **a legitimate reading is never discarded as
a duplicate, and a genuine ID collision is never quietly resolved.**
