# Threat model — Slice 0

Scope: the Slice 0 architecture in `../architecture/system-overview.md`. A
STRIDE-lite pass over each trust boundary, stating what is mitigated, what is
accepted, and what must be resolved before real data or real deployment.

Slice 0 runs entirely on one developer machine with simulated data. That makes
its real risk small and its *design* risk large: decisions made now determine
whether the eventual deployment can be secured at all.

## Assets

| Asset | Class | Why it matters |
| --- | --- | --- |
| Interval telemetry | C2 (C1 in Slice 0) | Reveals occupancy and behaviour — `data-classification.md` |
| Event record | C2 (C1 in Slice 0) | The operational record is the product; its integrity is the trust claim |
| Provenance (`origins`, `derivation`, `lineage`) | C1 | The platform's integrity claim. Corruption here is worse than data loss |
| Gateway credentials | C3 | Do not exist yet; would allow telemetry forgery |
| **Physical assets** | — | Protected by having no control path at all — `safety-boundary.md` |

Provenance deserves its place on this list. Losing readings is recoverable and visible.
Silently relabelling an origin from `simulated` to `measured`, or dropping a
`derivation` of `estimated`, is neither — and it destroys the one thing the platform
claims over vendor apps.

## Boundaries

| # | Boundary | Slice 0 exposure |
| --- | --- | --- |
| B1 | Simulator → outbox | In-process, trusted |
| B2 | Gateway → ingest | **Plain HTTP on loopback** in Slice 0; hostile network in deployment |
| B3 | Store → read API | In-process, trusted |
| B4 | Read API → browser | **Plain HTTP on loopback** in Slice 0 |
| B5 | Repository → the world | Real, now — this is the live boundary in Slice 0 |

Slice 0 has **no TLS and no certificates**. Nothing below claims otherwise, and the
"before deployment" column describes requirements, not current behaviour.

## B2 — Gateway to ingest

The boundary that matters, because it is where untrusted input enters and where
deployment changes everything.

| Threat | Slice 0 | Before deployment |
| --- | --- | --- |
| **S** Spoofed gateway forges telemetry | **Accepted** — loopback, no auth | Per-gateway credential; server binds `gatewayId` to it. A platform whose outage record can be forged has no product |
| **T** Tampered batch in transit | **Accepted** — plain HTTP on loopback, no integrity protection | Require TLS; refuse plaintext connections |
| **T** Forged provenance (`simulated` claimed as `measured`) | **Partly mitigated** — `measured` is unreachable while no interface is verified | Server derives `origins` from the authenticated source's registration; it must not accept the sender's word for it |
| **T** Forged or stripped `derivation` (an estimate claimed as `direct`) | **Partly mitigated** — schema requires `lineage` whenever `derivation` is not `direct` | Same registration-based derivation; reject a `direct` claim from a source registered as a deriving component |
| **T** Reused `readingId` overwrites a stored reading | **Mitigated** — a duplicate ID with a differing payload returns `409` and changes nothing | Same |
| **R** Gateway denies sending | Sequence + `receivedAt` recorded | Signed batches if disputes ever matter |
| **I** Telemetry disclosed in transit | **Accepted** — plain HTTP, loopback, simulated data | Require TLS |
| **I** Telemetry disclosed via logs | Mitigated — rule D-3, identifiers only | Same, plus log access control |
| **D** Oversized or flooding batches | Partly — 1000-reading cap, size limit | Rate limit per gateway; bounded body |
| **D** Storage exhaustion by volume | **Accepted** | Quotas, retention (D15) |
| **E** Ingest input drives code execution | Mitigated — schema validation, parameterized SQL, no eval, no dynamic import | Same |
| **E** Unknown site auto-created by typo | Mitigated — unknown `siteId` rejected | Same |

The provenance-forgery rows are the design-shaping ones. If ingest trusts `origins` and
`derivation` from the wire, any compromised or buggy gateway can promote simulated
values to `measured`, or present a model output as a direct observation. The mitigation
is architectural: **provenance is asserted by registration, not by payload.** Slice 0
does not need it — `measured` is unreachable while nothing is verified — but these
fields must never become authoritative from the sender, or retrofitting is a schema
break.

Splitting provenance into two dimensions narrows this surface rather than widening it:
`derivation` is checkable against the schema (anything other than `direct` must carry
resolvable `lineage`), so a stripped derivation is detectable at ingest without
consulting registration at all.

## B4 — Read API to browser

| Threat | Slice 0 | Before deployment |
| --- | --- | --- |
| **S** Unauthenticated read of a site's data | **Accepted** — plain HTTP on loopback, simulated | Authentication; org-scoped queries at the data layer (D16) |
| **T** A mutating request reaches an asset | **Structurally impossible** — no such endpoint exists (S1, S2) | Same, permanently |
| **I** Cross-tenant read | Not applicable — one org | Isolation per `data-classification.md` |
| **I** Stale value read as current | Mitigated — staleness required in UI | Same |
| **D** Expensive unbounded queries | **Accepted** | Pagination, bounded ranges |
| **E** XSS via stored values | Mitigated — React escaping, no `dangerouslySetInnerHTML`, closed metric and state vocabularies | Same, plus CSP |

Closed vocabularies are quietly doing security work here: because metrics and
state values are registry-constrained at ingest, no attacker-controlled string
reaches the DOM as a label.

## B5 — Repository to the world

The only boundary with real exposure in Slice 0, and the one an owner is most
likely to overlook because it does not look like a system boundary.

| Threat | Mitigation |
| --- | --- |
| Committed credentials | `.gitignore` covers `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`; `scripts/check-secrets.mjs` scans every tracked and staged file on each `npm run check` and in CI; `CLAUDE.md` prohibits it |
| Committed real site data | Rule D-1; tested; simulator exists so real captures are never needed for debugging |
| Personal data in Git history | No real address, name, or account number in the repository. **History is effectively permanent** — a later removal is a rewrite, so the only reliable control is never committing it |
| Publishing before licensing is decided | **Resolved (D10)** — the repository is private and proprietary. No open-source license is present, and none is to be added. Publishing remains unapproved and the repository has no remote |
| Author identity leaked into commit history | **Resolved (D9)** — repository-local identity only, using a GitHub `users.noreply.github.com` address, so no personal or institutional email enters commit history. Nothing is set globally |

## Accepted residual risk in Slice 0

Accepted because Slice 0 is a single-machine simulator with no real data, no
credentials, and no network exposure:

1. No authentication on ingest or read.
2. **No transport encryption.** Slice 0 speaks plain HTTP on loopback and has no
   certificates. This is permitted for the local simulated environment only, and it is
   the reason Slice 0 must never be exposed beyond loopback — not even briefly for a
   demonstration.
3. No rate limiting or quotas.
4. No audit log of reads.
5. No tenant isolation (one hard-coded organization).

Each is unacceptable the moment any of the following becomes true — these are the
tripwires, not a schedule:

- a real device produces a reading with `measured` among its origins;
- the API listens on anything but loopback;
- a second organization or user exists;
- the repository gains a remote or is published.

## Required before real data or deployment

| # | Requirement | Tripwire |
| --- | --- | --- |
| 1 | Per-gateway authentication; `gatewayId` bound to credential | Any non-loopback listener |
| 2 | **TLS on both network boundaries, with plaintext connections refused.** Not implemented in Slice 0 | Same |
| 3 | `origins` and `derivation` asserted by source registration, never accepted from payload | First reading with `measured` among its origins |
| 4 | User authentication and org-scoped data access | Second user or org |
| 5 | Rate limits, body-size limits, query pagination | Any non-loopback listener |
| 6 | Retention and deletion policy implemented (D15) | First real reading stored |
| 7 | Secret scanning in CI | **Implemented** 2026-07-26 — `scripts/check-secrets.mjs`, in `npm run check` and in CI |
| 8 | Incident response process and notification obligations | First real reading stored |

Requirement 3 is the one that cannot be added late without a schema break, which
is why it appears in a Slice 0 document at all.

## Explicitly out of scope

Physical safety threats — wrong command, backfeed, unsafe transfer — are out of
scope **because no control path exists**. They are addressed by absence, not by
mitigation. Should the safety boundary ever be revisited, `safety-boundary.md`
requires a dedicated failure analysis, and this threat model would need a full
physical-safety section that it does not currently pretend to have.
