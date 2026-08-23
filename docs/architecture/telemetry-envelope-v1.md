# Telemetry envelope v1

The normalized record every reading takes, at every layer, from simulator to
dashboard. This is the platform's most durable interface: the charter names
normalized data as the enduring asset, so this schema outlives every component
that touches it.

Identifiers, metrics, units, and time rules are in `naming-and-identifiers.md`.
Provenance rules are in `data-provenance.md`. This document defines structure,
identity, and validation.

## Envelope

```ts
// packages/contracts — illustrative shape, not implementation
type TelemetryEnvelope = {
  schemaVersion: 1;

  readingId: string;           // UUID, assigned once at creation — see Identity
  siteId: string;              // site_001
  sourceId: string;            // src_001_sim_panel
  metric: string;              // registered metric name
  capturedAt: string;          // RFC 3339, UTC, ms precision, 'Z'

  sample: NumericSample | StateSample;

  origins: Origin[];           // non-empty, canonical order, deduplicated
  derivation: Derivation;      // "direct" | "inferred" | "estimated"
  lineage?: Lineage;           // required iff derivation !== "direct"

  quality?: QualityFlag[];
};

type NumericSample = { kind: "numeric"; value: number; unit: Unit };
type StateSample   = { kind: "state";   state: string;  domain: StateDomain };

type QualityFlag =
  | "clock_suspect"      // gateway clock offset exceeded tolerance
  | "sensor_fault"       // source reported its own fault
  | "out_of_range"       // value outside the metric's declared range
  | "interpolated"       // gap-filled, not observed
  | "first_after_gap";   // first reading after a reporting gap
```

A discriminated `sample` union rather than a nullable `value` plus nullable
`state`: `source.active` is not a number, and a shape permitting
`{value: null, state: null}` makes an unrepresentable state representable. The
discriminant is what lets the validator reject nonsense instead of storing it.

Most readings from a collector are `derivation: "direct"` with a single origin.
The two provenance fields are still required on every one of them — R1 admits no
exception, because the unlabelled case must never be the easy case.

## Batch

Readings cross the network in batches, never singly.

```ts
type TelemetryBatch = {
  schemaVersion: 1;
  gatewayId: string;           // gw_001_1
  sequenceStart: number;       // inclusive, monotonic per gateway
  sequenceEnd: number;         // inclusive
  clockOffsetMs: number;       // gateway's own estimate; 0 if unknown
  readings: TelemetryEnvelope[];  // 1..1000, ordered by sequence
};
```

`sequence` is a **transport** concern — ordering and acknowledgement — and is
deliberately not part of a reading's identity. It lives on the batch envelope and
in the outbox, not in the reading. See `offline-sync-and-idempotency.md`.

## Identity

**`readingId` is an opaque UUID, assigned once, at the moment the reading is
created, by the component that created it.**

1. Generated with Node's built-in `crypto.randomUUID()` (UUID v4). No identifier
   library is added; the built-in is sufficient and adding a dependency for
   formatting is not justified.
2. Written into the durable outbox **with** the reading, before any transmission
   is attempted. The ID is part of the record, not of the send.
3. **Reused unchanged on every retry.** This is what makes at-least-once delivery
   safe: a resent reading is byte-identical, including its ID.
4. Used directly as the server's idempotency key. The server generates nothing.
5. Immutable. A correction is a new reading with a new ID, never an edit.

### Why identity is not derived from the coordinate

An earlier draft derived `readingId` by hashing `(siteId, sourceId, metric,
capturedAt)`. That is wrong, and the reason is worth recording so it is not
reintroduced:

**A timestamp is an observation attribute, not an identity.** Two valid readings
can legitimately share one — the same metric sampled twice within a millisecond,
two collectors observing one source, a device reporting a corrected value for an
instant it already reported. Under a coordinate-derived key, the second is
indistinguishable from a duplicate, and any "first write wins" resolution
**silently discards a legitimate record**. On a platform whose product is a
trusted operational record, quietly dropping a real observation is a worse failure
than storing an extra one.

Consequences of opaque identity:

- **There is no uniqueness constraint on the coordinate.** Two readings sharing
  `(site, source, metric, capturedAt)` are two readings, both stored, both
  distinct. Duplicate detection is the ID's job alone.
- The coordinate remains the descriptive tuple used for querying and for
  detection windows. It is not identity, and no index treats it as unique.
- Duplicate suppression is exact rather than heuristic: the same ID is the same
  record, and nothing else is.

### Duplicate IDs

| Case | Server behaviour |
| --- | --- |
| ID already stored, payload digest identical | Normal retry. No-op, counted as `duplicate` |
| ID already stored, payload digest **differs** | **`409`, whole batch rejected**, offending `readingId` named, alert raised |

The second case cannot arise from a retry — a retry sends identical bytes — so it
means a component reused an ID for a different observation. That is a defect, and
it is surfaced rather than resolved: neither record is overwritten, neither is
silently dropped. The server stores a digest of each reading's payload precisely so
this case is detectable instead of invisible.

### Event identity

Derived events need a **deterministic** ID so that re-derivation is idempotent —
`randomUUID()` would mint a new event on every pass.

```
eventId = uuidFormat( sha256( "event.v1" ‖ 0x1F ‖ type ‖ 0x1F ‖
                              ruleVersion ‖ 0x1F ‖ sortedInputIds.join(0x1E) ) )
```

- Derived from event type, rule version, and the **sorted** input record IDs.
- Computed with `node:crypto` only. The digest is truncated to 128 bits and
  formatted as a UUID string with the version and variant bits set — the
  documented reason for not using `randomUUID()` here is determinism, and no
  library is added for the formatting.
- `0x1F` separates fields and `0x1E` separates list members, so field and list
  boundaries cannot be forged by content.
- Re-deriving over unchanged inputs with an unchanged rule version reproduces the
  same `eventId` exactly, making re-derivation a no-op. A new rule version yields
  new IDs, which is what lets corrections supersede prior events instead of
  mutating them.

Note the asymmetry, which is intentional: **readings get opaque random IDs because
two identical-looking observations may both be real; events get derived
deterministic IDs because the same rule over the same inputs is the same
conclusion.**

### Fixtures

Test fixtures use **fixed literal UUIDs**, never generated at test time. Fixture
IDs are drawn from a reserved block documented in the fixture directory so a
fixture ID can never collide with a runtime one. This keeps every fixture-driven
test deterministic, per `testing-strategy.md`.

## Field rules

| Field | Rule on violation |
| --- | --- |
| `schemaVersion` | Must equal `1`. Unknown version → `422`, never best-effort parse |
| `readingId` | Required. Canonical **lowercase** UUID, versions 1–8, variant 8/9/a/b — the nil and max UUIDs are excluded. Absent, uppercase, or malformed → `422`. The server never generates one |
| `siteId`, `sourceId` | Must match the identifier format and be known to the server. Unknown → `422`. Auto-creating a site on first sight would let a typo found a new site |
| `metric` | Must be in the registry. Unregistered → `422` |
| `capturedAt` | RFC 3339, UTC, `Z` suffix, **exactly three fractional digits**. `…30Z`, `…30.25Z`, `…30.2500Z`, and a lowercase `z` are all rejected, so one instant has one wire form. A non-`Z` offset is rejected rather than normalized, so a wrong offset surfaces as an error instead of a silent shift. A value more than 24 h ahead of `receivedAt` → reject as implausible |
| `sample.value` | Finite number. `NaN`, `Infinity`, `null` → reject. Outside the metric's range → **accept**; the caller attaches `out_of_range`. Range is advisory and lives in the registry, so the contracts package reports it (`isOutOfRange`) rather than mutating the record |
| `sample.unit` | Must equal the metric's registered unit exactly. Mismatch → `422`, never converted |
| `sample.state` | Must be in the metric's declared domain. Unknown value → `422` |
| `origins` | Required, non-empty, members from the four values, **already deduplicated and in canonical order**. Absent, empty, duplicated, or out of order → `422`. See "Canonical wire form" below |
| `derivation` | Required, one of the three. Absent → `422` |
| `lineage` | Required when `derivation` is `inferred` or `estimated`; **forbidden** when `direct`. `rule` is lower_snake_case, `ruleVersion` is `major.minor.patch`, and `inputIds` is non-empty with no duplicates. Input order is preserved rather than required to be sorted, since for some rules it is meaningful |
| `quality` | Optional. When present, non-empty and deduplicated — **omit the field rather than sending `[]`**, so "no flags" has one representation |
| Unknown keys | Rejected anywhere in the envelope, so a typo cannot be silently dropped |

### Batch fields

| Field | Rule on violation |
| --- | --- |
| `readings` | 1–1000 per batch, non-empty. Empty batch → `422` |
| `sequenceStart`, `sequenceEnd` | Non-negative safe integers, `sequenceEnd >= sequenceStart` |
| Sequence span | `sequenceEnd - sequenceStart + 1` **must equal** `readings.length`. The gateway flushes a contiguous unacknowledged range, so a mismatch means the batch does not describe what it contains, which would make `ackedThrough` ambiguous |
| `clockOffsetMs` | Integer milliseconds; may be negative |

### Canonical wire form

`origins` must arrive already deduplicated and in canonical order. The boundary
**rejects** a non-canonical set rather than normalizing it, for the same reason a
unit mismatch is rejected rather than converted: silent repair means two byte
sequences map to one accepted record, which would make payload digests — and so
the ID-reuse detection above — meaningless. Producers canonicalize before sending;
`packages/contracts` exports `normalizeOrigins` and `unionOrigins` for exactly
that, and `unionOrigins` is the implementation of rule R2.

The lineage rule is enforced twice: in the schema at runtime, and in the exported
`DirectEnvelope` / `DerivedEnvelope` types, so a direct record has nowhere to put
lineage and a derived one cannot omit it.

### Out of range accepts, unit mismatch rejects

These look inconsistent and are not. An out-of-range voltage may be the single most
important reading in an outage — a genuine sag or surge — so it is stored and
flagged. A unit mismatch means the *sender is wrong about what it is sending*,
which makes the number meaningless rather than surprising. Silent conversion is how
a factor-of-1000 error becomes permanent.

## Validation

Validation happens **once**, at the ingest boundary, and produces typed values for
everything downstream. `packages/contracts` owns the schema; no component
re-implements it. Schema definitions are the single source of truth and static
types are derived from them, not maintained in parallel.

Rejection is **all-or-nothing per batch**. One invalid envelope rejects the batch
with a `422` naming the offending index and field path. Partial acceptance would
force the gateway to reason about which readings survived, and that bookkeeping is
where sync bugs live.

Errors are structured: `{ index, path, code, message }`. `code` is stable and
machine-readable; `message` is for humans and may change.

## Wire example

```json
{
  "schemaVersion": 1,
  "gatewayId": "gw_001_1",
  "sequenceStart": 41204,
  "sequenceEnd": 41206,
  "clockOffsetMs": 0,
  "readings": [
    {
      "schemaVersion": 1,
      "readingId": "0f8d3c1e-6b2a-4d17-9c54-8a1e2f6b7c01",
      "siteId": "site_001",
      "sourceId": "src_001_sim_panel",
      "metric": "voltage.rms",
      "capturedAt": "2026-07-26T04:15:30.250Z",
      "sample": { "kind": "numeric", "value": 118.4, "unit": "V" },
      "origins": ["simulated"],
      "derivation": "direct"
    },
    {
      "schemaVersion": 1,
      "readingId": "0f8d3c1e-6b2a-4d17-9c54-8a1e2f6b7c02",
      "siteId": "site_001",
      "sourceId": "src_001_sim_panel",
      "metric": "source.active",
      "capturedAt": "2026-07-26T04:15:30.250Z",
      "sample": { "kind": "state", "state": "utility", "domain": "energy_source" },
      "origins": ["simulated"],
      "derivation": "direct"
    },
    {
      "schemaVersion": 1,
      "readingId": "0f8d3c1e-6b2a-4d17-9c54-8a1e2f6b7c03",
      "siteId": "site_001",
      "sourceId": "src_001_sim_battery",
      "metric": "battery.runtime_remaining",
      "capturedAt": "2026-07-26T04:15:30.250Z",
      "sample": { "kind": "numeric", "value": 15120, "unit": "s" },
      "origins": ["simulated"],
      "derivation": "estimated",
      "lineage": {
        "rule": "runtime_estimate",
        "ruleVersion": "1.0.0",
        "inputIds": [
          "0f8d3c1e-6b2a-4d17-9c54-8a1e2f6b7c04",
          "0f8d3c1e-6b2a-4d17-9c54-8a1e2f6b7c05"
        ]
      }
    }
  ]
}
```

The third reading shows the two dimensions doing their job: a runtime estimate over
simulated inputs is `origins: ["simulated"]` **and** `derivation: "estimated"` —
both facts preserved, with lineage to the readings it came from. The same estimate
over a verified battery would differ in exactly one field.

## Versioning

`schemaVersion` is an integer, present on both batch and envelope.

**Additive within v1** — no bump: adding an optional field; adding a metric or
quality flag; widening a numeric range; adding a state-domain value where
consumers already handle `unknown`.

**Requires v2 and an ADR** — removing or renaming a field; changing a field's type
or unit; making an optional field required; changing `eventId` derivation; changing
the meaning of an existing metric or state value; adding an origin or derivation
value.

Changing `eventId` derivation re-identifies every stored event and requires a
dual-write migration plan in its ADR. Reading IDs are opaque and externally
assigned, so they are immune to this class of change — a further advantage of not
deriving them from content.

The server accepts only versions it explicitly supports and rejects others rather
than guessing. Edge gateways are assumed to lag the server, never lead it: a
gateway at Site 001 may be offline for weeks and cannot be assumed updated.
