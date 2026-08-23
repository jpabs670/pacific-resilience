# Testing strategy

`CLAUDE.md` requires a test with each behavior change. This document defines what
that means per layer, so the requirement is checkable rather than aspirational.

The platform's value rests on four claims — normalization, offline durability,
idempotent sync, explicit provenance. Each is a property that can hold on
Tuesday and fail on Wednesday without any visible symptom. Tests are how they
stay true.

## Layers

| Layer | What is tested | Style |
| --- | --- | --- |
| `packages/contracts` | Schema accept/reject, provenance rules, `eventId` derivation, unit registry, time parsing | Table-driven over fixtures |
| `packages/event-detection` | Every rule in `event-detection.md` | Fixture series in, expected events out |
| `packages/telemetry-store` | Interface contract, idempotent upsert, immutability | Against a temporary database file |
| `edge/gateway` | Durability, cursor, backoff, quarantine | Integration, including process kill |
| `edge/simulator` | Determinism from seed, scenario fidelity | Snapshot over a fixed seed |
| `apps/api` | Validation responses, batch accounting, read shapes | Integration against a real store |
| `apps/web` | Provenance rendering, staleness, safety constraints | Component tests |

Pure packages (`contracts`, `event-detection`) get the deepest coverage because
they are pure, cheap to test exhaustively, and every other layer depends on them.

## Non-negotiable tests

These encode requirements from `CLAUDE.md`, the charter, and
`../security/safety-boundary.md`. They are not deletable without an ADR, and each
cites the rule it defends.

### Safety

| Test | Defends |
| --- | --- |
| The API route table contains no path that commands a breaker, generator, transfer switch, battery, or utility asset | No-control boundary |
| No HTTP method other than `GET` exists outside `/v1/telemetry:batch` and explicitly listed configuration endpoints | Same |
| No rendered component exposes a control affordance | Same |
| The dependency graph contains no Modbus, serial, or vendor SDK package | Verified-integrations-only rule |

The route-table test is the one that matters most in practice. A control endpoint
is far more likely to arrive by someone's convenient scaffolding than by a
decision, and a boundary that fails CI catches that; a boundary written only in a
document does not.

### Provenance

| Test | Defends |
| --- | --- |
| A record missing `origins` or `derivation` is rejected; an empty `origins` is rejected | R1 |
| No type, schema, or column supplies a default for either dimension | R1 |
| Derivation over simulated inputs yields `origins: ["simulated"]` **and** `derivation: "inferred"` — not one collapsed label | R2 |
| Mixed-origin inputs yield the full union, deduplicated, in canonical order; no origin is dropped and none is selected as a winner | R2 |
| No ranking function over origins exists anywhere in the codebase | R2 |
| A deterministic rule over an estimated input produces `derivation: "inferred"`, with lineage resolving to the estimated input | R3 |
| No rendered value node lacks **both** an origin and a derivation label | R4 |
| `lineage` is required when `derivation` is `inferred` or `estimated`, and rejected when `direct` | R5 |
| Every derived record's `lineage.inputIds` resolve to existing records | R5 |

The second and third rows exist because the previous design collapsed both dimensions
into one "weakest provenance" value. A test asserting that no ranking function exists
is the cheapest guard against that reappearing as a convenience helper.

### Identity

| Test | Defends |
| --- | --- |
| A `readingId` is a well-formed UUID; the server never generates one | Opaque identity |
| The same reading retransmitted carries a byte-identical `readingId` (P6) | Retry safety |
| Two readings sharing `(site, source, metric, capturedAt)` with different IDs are both stored (P8) | A legitimate reading is never discarded as a duplicate |
| No unique index exists on the coordinate tuple | Same |
| A stored `readingId` resent with a differing payload returns `409` and changes nothing (P10) | ID reuse is surfaced, not resolved |
| `eventId` is identical across re-derivation with unchanged inputs and rule version | Idempotent derivation |
| `eventId` changes when `ruleVersion` changes | Corrections supersede rather than mutate |
| Fixtures contain fixed literal UUIDs, never generated at test time | Determinism |

### Sync

P1–P10 in `offline-sync-and-idempotency.md`, verbatim. Each is a named test.

### Data handling

| Test | Defends |
| --- | --- |
| No fixture contains a real address, name, account number, or meter serial | `data-classification.md` |
| No fixture is sourced from a real Site 001 capture | Same |

## Fixtures

- **Synthetic only.** No real Site 001 data enters the repository, ever, in any
  form — including "anonymized" captures. Anonymization of a single known site is
  not anonymization.
- Fixtures live in `<package>/test/fixtures/` as JSON, readable and diffable.
- Every fixture states its intent in a top-level comment field. A fixture whose
  purpose is unclear becomes a fixture nobody dares change.

> **Resolved (decision D8).** `.gitignore` previously used the unanchored pattern
> `data/`, which ignored any directory named `data` at any depth and would have
> silently swallowed a `test/data/` fixture directory — CI passing against files that
> were never committed. It is now anchored to `/data/`, which ignores only the
> repository-root runtime directory holding the SQLite files. Fixture directories are
> named `fixtures/` regardless.

## Determinism

Every test is deterministic. Specifically:

- No wall-clock reads in assertions. Time is injected.
- No unseeded randomness. The simulator takes an explicit seed.
- No network access, no real broker, no shared database.
- No test depends on another test's ordering or leftover state.

The simulator is the one component that would naturally reach for randomness, and
the one where determinism pays most: an outage scenario that cannot be replayed
byte-for-byte cannot be used to debug the detector that consumes it.

## Coverage

Line coverage is a weak proxy, so it is used as a floor rather than a target:

| Package | Floor |
| --- | --- |
| `packages/contracts` | 95% |
| `packages/event-detection` | 95% |
| `packages/telemetry-store` | 85% |
| `edge/*`, `apps/api` | 80% |
| `apps/web` | No floor — the non-negotiable tests above are the requirement |

Branch coverage is enforced on `event-detection`, where the branches *are* the
specification.

## Property-based testing

Deferred as a dependency (`fast-check`), noted here because two properties are
better expressed as invariants than examples, and are the intended first
adopters:

- For any batch and any partition into resends in any order, the final stored set
  equals the batch's distinct coordinates.
- For any reading series, re-deriving events over any window partition yields the
  same event set as one whole-range derivation.

Both are exactly the kind of property that example tests approximate and never
quite pin down.

## What is not tested in Slice 0

Stated so the gaps are known rather than assumed covered:

- No load or performance testing. One gateway, one site.
- No end-to-end browser automation (`playwright` deferred).
- No security or penetration testing; Slice 0 runs over plain HTTP on loopback with no
  authentication and no TLS, and its threat model records that as accepted residual
  risk. No test asserts transport security, because Slice 0 provides none.
- No hardware-in-the-loop testing. Nothing is verified, so there is nothing to
  test against.
