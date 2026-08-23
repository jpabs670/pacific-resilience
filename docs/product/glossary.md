# Glossary

Shared vocabulary for this repository. Where a term has a precise meaning in the
platform, that meaning governs — including where common usage is looser.

## Site and electrical

**ATS — automatic transfer switch.** Equipment that switches a load between
sources, typically utility and generator, without human action. At Site 001 the
ATS is *building* equipment, not the tenant's; its make, model, and transfer type
are unknown. The platform observes its effects and never commands it.

**Critical load.** A load whose loss matters within the backup window. At Site
001: the standalone refrigerator and the Starlink terminal. A product term, not
an electrical classification — nothing in the platform enforces it.

**CUC — Commonwealth Utilities Corporation.** The electric utility for the
CNMI, and Site 001's utility source. Its data access paths are unknown; no
integration is claimed.

**De-energized.** No voltage present. Distinguished from an outage: a panel can be
de-energized for maintenance without an outage having occurred.

**Nominal voltage / frequency.** The service's design values, from which all
detection thresholds are derived as fractions. **Unverified at Site 001** — see
decision D13.

**Sag / brownout.** Voltage below nominal but present. Becomes an outage only when
it crosses the threshold for longer than the debounce window; otherwise it is an
abnormal-voltage condition or nothing.

**SoC — state of charge.** Battery energy remaining as a percentage, 0–100 as
stored. Reported by the battery system, not inferred by the platform. Not
reliably linear in energy, which is one reason runtime is `estimated`.

**Source.** In electrical terms, what is supplying power: utility, generator,
battery, solar, none, or unknown. See also *source* under Platform, which is a
different thing — an unfortunate but unavoidable overlap.

**Source transfer.** A change between two *live* sources. A change through `none`
is an outage followed by a restoration, not a transfer.

**Whole-site load.** Total active power at the site's observation point, as
distinct from the sum of individually monitored circuits — which will not match,
because not every circuit is monitored.

## Platform

**Envelope.** The normalized record one reading takes at every layer. Specified in
`../architecture/telemetry-envelope-v1.md`.

**Gateway.** The edge component that buffers readings durably and synchronizes
them. Assumes no connectivity by default.

**Metric.** A registered named quantity (`voltage.rms`, `load.site.active_power`).
The registry is closed; unregistered metrics are rejected at ingest.

**Outbox.** The gateway's durable append-only buffer. Readings are committed to it
before any network attempt.

**Reading.** One metric value from one source at one instant. Immutable.

**`readingId`.** A reading's opaque UUID, assigned once when the reading is created
and reused unchanged on every retry. It is the server's idempotency key. Deliberately
**not** derived from the reading's content or timestamp — see *Coordinate*.

**`eventId`.** A derived event's identifier, computed deterministically from event
type, rule version, and sorted input record IDs, so that re-deriving the same
conclusion produces the same event rather than a new one.

**Site.** One physical location. `site_001` is the identifier; "Site 001" is the
display name; they are never interchanged.

**Source (platform sense).** A thing that reports readings — a panel observation
point, a battery system, a circuit, a simulator. Separate from *site* so that
indirect observation stays visible.

**Coordinate.** The descriptive tuple (site, source, metric, instant) locating an
observation. It is **not** an identity: two legitimate readings may share a
coordinate — the same metric sampled twice within a millisecond, or a corrected value
for an instant already reported — and both are stored as distinct records. No
uniqueness constraint and no identifier is derived from it, because treating a
timestamp as identity means silently discarding a real observation.

## Provenance

Provenance has **two independent dimensions**, not one enum. Full definitions and
rules in `../architecture/data-provenance.md`.

**Origin.** Where the underlying data came from. A record carries a **set** of
origins, since a derived record may draw on several.

- **`measured`** — read from a device through a *verified* official interface for a
  *confirmed exact model*. Nothing in this repository may currently carry it.
- **`imported`** — taken from an external system's own record, unchanged in meaning.
- **`manual`** — entered by a human. Displayed as "Manually entered".
- **`simulated`** — produced by the simulator. Never real.

**Derivation.** How this particular record was produced.

- **`direct`** — the record is the observation; nothing was computed.
- **`inferred`** — produced by a deterministic documented rule with no error model.
  Can be wrong only if its inputs are wrong.
- **`estimated`** — produced by a model with error. Can be wrong even with perfect
  inputs.

The dimensions vary independently, which is the whole reason for separating them: a
runtime estimate from a real battery and one from the simulator share a method and
share nothing else. Displayed together — "Simulated · Inferred", "Measured ·
Estimated".

**Origin union (R2).** A derived record's origins are the union of its inputs'
origins. Nothing is dropped, collapsed, or ranked. In Slice 0 every reading is
simulated, so an outage event is `origins: ["simulated"]` with
`derivation: "inferred"` — both facts disclosed. There is **no** "weakest provenance"
ordering and nothing selects a winner among origins.

**Lineage.** The input record IDs a derived record came from, plus the rule or model
name and version. Required whenever `derivation` is not `direct`; a provenance label
that cannot be traced back is an assertion, not provenance.

## Sync

**At-least-once delivery.** The edge may send a batch more than once. Combined
with idempotent upsert, this yields exactly-once *effect*. Exactly-once
*delivery* is not attempted.

**Backfill.** Delivery of readings captured earlier, after a connection returns.
Normal and unlimited in the past; a gateway may be offline for weeks.

**Cursor.** The gateway's high-water mark of acknowledged sequences. Advances only
on server acknowledgement.

**Data gap.** A period with no readings. A *visibility* event carrying no claim
about power — rendering it as an outage would let an uplink drop manufacture an
outage record.

**Debounce.** The minimum duration a condition must persist before an event is
recorded. Prevents momentary sags from becoming outages.

**Hysteresis.** Using a stricter threshold to enter a condition than to leave it,
so a value hovering at the boundary cannot flap.

**Idempotent.** Applying an operation repeatedly has the same effect as applying
it once.

**Quarantine.** A hold on a range that cannot be delivered — the server permanently
rejected it (`4xx`), or its acknowledgement could not be trusted. The range stops
being resent but is kept intact, and the cursor does not advance past it: a stuck
cursor is visible, whereas skipping is silent loss. The only exit is a **release**,
which retries the same readings; there is no operation that skips them.

**Release (of a quarantine).** An operator lifting a hold once the cause is dealt
with, so the same readings are sent again. Requires the sequence the operator believes
they are releasing, who authorised it, and what was done — all recorded. Advances and
deletes nothing, so a release made in error costs a retry, never data.

**Sequence.** The gateway's monotonic, gap-free, never-reused ordinal per reading,
used for ordering and acknowledgement. A gap indicates data loss. It is a transport
concern and is deliberately **not** part of a reading's identity.

**Loopback-only transport.** Slice 0 speaks plain HTTP on `127.0.0.1` with no TLS and
no authentication, permitted because every component runs on one machine with
simulated data. TLS and per-gateway authentication become mandatory before any gateway
communicates across a network.

**Staleness.** A value older than twice its expected interval. Displayed as stale
rather than as current.

## Process

**ADR — architecture decision record.** A numbered decision document in
`../architecture/adr/`. Process in ADR 0001.

**Slice 0.** The first vertical slice, scoped in `slice-0-scope.md`.

**TO CONFIRM.** A marked block holding a placeholder that must be replaced with a
verified value before the surrounding rule can be trusted.

**Unverified.** Believed, but with no official documentation reviewed. Under
`CLAUDE.md`, an unverified device, protocol, or vendor may not be claimed as
supported.
