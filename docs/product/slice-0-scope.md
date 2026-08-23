# Slice 0 — scope and acceptance criteria

`CLAUDE.md` prefers one small, tested vertical slice over broad scaffolding. This
document is that slice's boundary. It is intended to be frozen at approval and
changed only by explicit amendment, because the failure mode for a first slice is
not building the wrong thing — it is building slightly more than the right thing,
repeatedly.

**Slice 0 in one line:** one simulated site, buffered through a disconnect,
arriving exactly once, shown with its provenance.

## Why this is the minimum

Four properties are expensive to retrofit and nearly free to establish now:
normalization, offline durability, idempotent sync, explicit provenance. Each is
load-bearing for everything the charter describes later, and each is invisible in
a demo. A prettier dashboard over a schema-less feed would present better and be
worth nothing — the charter's enduring asset is the data layer, not the view.

Slice 0 also carries **zero vendor risk and zero safety surface**: nothing is
verified at Site 001, and nothing in this slice can command any asset.

## In scope

| # | Deliverable | Package |
| --- | --- | --- |
| 1 | Envelope v1: schema, two-dimension provenance, lineage, units, metric registry, reading and event identity, time rules | `packages/contracts` |
| 2 | Deterministic seeded simulator with scenario files for outage, restoration, and generator transfer | `edge/simulator` |
| 3 | Durable outbox, monotonic sequence, cursor/ack, backoff, quarantine | `edge/gateway` |
| 4 | Ingest endpoint over HTTP on loopback, with validation and idempotent upsert keyed on `readingId`; immutable readings | `apps/api` |
| 5 | Store interface with SQLite implementation | `packages/telemetry-store` |
| 6 | Pure outage, restoration, transfer, abnormal-voltage, and gap detection | `packages/event-detection` |
| 7 | Read API: current values, recent series, events, gateway last-seen | `apps/api` |
| 8 | Single-site dashboard showing origin and derivation per value, SIMULATED banner, staleness, event timeline | `apps/web` |
| 9 | Tests per `../architecture/testing-strategy.md`, including all non-negotiable tests | all |
| 10 | CI running typecheck, lint, and tests | `.github/workflows/` |

One organization (`org_dev`), one site (`site_001`), one gateway (`gw_001_1`).

## Out of scope

### Permanently excluded at this layer

Control of breakers, generators, transfer switches, utility equipment, or any
safety-critical asset. Not deferred — excluded. See
`../security/safety-boundary.md`.

### Deferred, with the trigger that reopens it

| Deferred | Reopens when |
| --- | --- |
| Any vendor, device, protocol, or utility integration | An exact model's official interface is verified and an ADR records the evidence (D12) |
| TLS and gateway authentication | Any non-loopback listener. Mandatory at that point, not optional — see `../security/threat-model.md` |
| Authentication, authorization, tenancy beyond one hard-coded org | A second user or organization exists (charter slice item 1, partially deferred — D16) |
| Configuration-change audit trail | A configuration surface exists to produce entries (charter slice item 9 — D16) |
| PostgreSQL, MQTT, Redis, object storage, containers | Triggers in ADR 0003 |
| Rates, fuel-adjustment charges, cost, savings analysis | Post-Slice 0 product decision. Present in the charter's problem statement; explicitly not in the first slice |
| Trend charts, historical analytics | Phase 5+ (ADR 0005) |
| Evidence uploads (panel photos, nameplates) | Object storage is scoped; brings sensitive-data handling |
| Multi-site, portfolio, tenant sub-metering | After Site 001 proves the data path |
| Native mobile applications | Charter non-goal for the first release |
| Kubernetes, complex cloud infrastructure | Charter non-goal for the first release |

### Charter slice items partially deferred

`product-charter.md` lists nine items for the first slice. Slice 0 delivers items
2–8 in full. Two are reduced (decision **D16**):

- **Item 1, "represent one organization and Site 001"** — delivered as a
  hard-coded organization and site. Identity, authorization, and tenant isolation
  are deferred.
- **Item 9, "preserve an audit trail for configuration changes"** — deferred,
  because Slice 0 has no configuration surface and therefore no changes to audit.
  It becomes required with the first one.

This reduction needs explicit approval; it is the only place Slice 0 delivers less
than the charter's first-slice list.

## Acceptance criteria

Slice 0 is complete when every item passes. Each is observable — no criterion
depends on judgement.

### Contracts — delivered in Phase 1 (`packages/contracts`)
- [x] Valid fixtures accepted; every invalid fixture rejected with a field path
- [x] An envelope missing `origins` or `derivation` is rejected; an empty `origins` is rejected; no default exists anywhere
- [x] `lineage` required when `derivation` is `inferred` or `estimated`, rejected when `direct`
- [x] Mixed-origin inputs produce the deduplicated union in canonical order; no origin dropped, none selected as a winner
- [x] No origin-ranking function exists anywhere in the codebase
- [x] Non-`Z` offsets, `NaN`, `Infinity`, and unregistered metrics rejected
- [x] Unit mismatch rejected, never converted
- [x] `readingId` accepted only as a well-formed UUID; the server never generates one
- [ ] `eventId` identical across re-derivation with unchanged inputs and rule version, and different when `ruleVersion` changes — **deferred to Phase 4**, where events are derived; `packages/contracts` deliberately generates no identifiers

### Simulator and gateway
- [ ] Same seed produces byte-identical output
- [ ] Scenario files reproduce outage, restoration, and generator transfer
- [ ] P1 durability precedes network — `kill -9` mid-flush loses nothing acknowledged
- [ ] P2 no loss across a severed link
- [ ] P4 cursor does not advance past a quarantined `4xx`/`409` range
- [ ] P6 a retransmitted reading carries a byte-identical `readingId`
- [ ] P7 21 days of backfill accepted, none rejected for age
- [ ] P9 full outbox refuses new readings; oldest unsent readings survive

### Ingest and store
- [ ] P3 identical batch replayed → `inserted: 0`, `duplicate: n`, row count unchanged
- [ ] P8 two readings sharing `(site, source, metric, capturedAt)` with different IDs are both stored; no unique index on the coordinate
- [ ] P10 stored `readingId` resent with a differing payload → `409`, batch rejected, stored row unchanged, nothing dropped
- [ ] P5 store failure mid-batch → zero rows committed
- [ ] Malformed batch → `422` naming index and field path; whole batch rejected
- [ ] `inserted + duplicate === received` on every success
- [ ] No `UPDATE` path exists for a reading value
- [ ] Outbox PRAGMAs are `journal_mode=WAL`, `synchronous=FULL`; server store `synchronous=NORMAL`

### Event detection
- [ ] Every fixture in `../architecture/event-detection.md` produces its stated result
- [ ] `momentary-sag` and `unknown-source` produce no events
- [ ] `boundary-flutter` produces exactly one outage pair
- [ ] `uplink-loss` produces a gap, never an outage
- [ ] `occurredAt` is condition onset, not detection time
- [ ] Re-derivation over an unchanged window creates no new events
- [ ] Events over simulated inputs carry `origins: ["simulated"]` **and** `derivation: "inferred"` — both disclosed, neither collapsed
- [ ] Every event's `lineage` resolves to existing reading IDs
- [ ] `shared-timestamp` fixture: both readings consumed, neither dropped

### Dashboard
- [ ] Shows active source, voltage, frequency, whole-site load, refrigerator load, Starlink load, SoC, runtime estimate, event timeline, gateway last-seen
- [ ] Every value displays **both** origin and derivation, e.g. "Simulated · Direct", "Simulated · Estimated"; no bare value renders and neither dimension is hidden behind a hover
- [ ] Multiple origins are all shown, e.g. "Measured + Manual · Inferred"
- [ ] SIMULATED banner present whenever any value has `simulated` among its origins
- [ ] Values older than 2× their interval render as stale, not as current
- [ ] Runtime estimate labelled estimated, whole-minute resolution, model linked
- [ ] Usable at 375 px and 1280 px
- [ ] **No control affordance anywhere**, verified by test

### Safety and integrity
- [ ] Route-table test: no endpoint commands any physical asset — Phase 3, with the API
- [x] Dependency test: no Modbus, serial, or vendor SDK package present
- [x] No fixture derives from real Site 001 data
- [x] No real address, name, account number, or meter serial in the repository
- [x] `packages/contracts` declares no workspace dependency
- [x] No file under `packages/` imports from `apps/` or `edge/`

### Repository hygiene
- [ ] CI runs typecheck, lint, and tests on every PR and blocks on failure
- [ ] Coverage floors met per `../architecture/testing-strategy.md`
- [ ] `.env.example` keys match exactly what the code reads
- [ ] No source, config, or document claims TLS or HTTPS for Slice 0
- [ ] `README.md` status section reflects reality on completion

## Scaffold defects from the 2026-07-26 review

| Defect | Resolution | Decision |
| --- | --- | --- |
| `.gitignore` used the unanchored pattern `data/`, ignoring any `data` directory at any depth and silently swallowing future fixtures | **Applied** — narrowed to `/data/` | D8 |
| `.env.example` declared PostgreSQL, MQTT, Redis, and object storage; none decided, all unreachable (Docker absent) | **Applied** — reduced to keys Slice 0 reads | D7, ADR 0003 |
| `APP_URL=http://localhost:3000` presumed a framework and port never decided | **Applied** — replaced by `API_PORT` | D7, ADR 0005 |
| Charter list items 5, 8, and 9 began lowercase, inconsistent with the rest | **Applied** — capitalized. (The earlier review also named item 6; item 6 was already correct) | — |
| Repository had no configured Git identity | **Applied** — repository-local identity configured externally, using a GitHub `users.noreply.github.com` address. Nothing set globally | D9 |
| Licensing undecided | **Decided** — the repository is private and proprietary. No open-source license, and none to be added | D10 |
| Repository has **zero commits** and no remote | Open — initial commit awaits owner approval; no remote, no push, no GitHub repository | D9 |
| `.github/workflows/` empty though `README.md` lists CI as a repository area | Open — add CI in Phase 6, now that the toolchain is accepted | Phase 6 |

## Definition of done

All acceptance criteria pass; every `TO CONFIRM` block in the architecture documents is
either resolved or explicitly carried forward with the owner's acknowledgement; and
Slice 0 runs from a clean clone with `node` and `npm` alone — no Docker, no global
installs, no service credentials, and never a listener beyond loopback.

ADRs 0002–0005 were accepted on 2026-07-26, which unblocks Phase 1.
