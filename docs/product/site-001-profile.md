# Site 001 profile

The first development model, per `product-charter.md`: a two-bedroom Saipan
apartment. Site 001 is a **software and telemetry test environment**. It does not
authorize automatic control of the utility, generator, transfer switch, or
breakers, and this document creates no such authorization.

- Identifier: `site_001` · Display name: "Site 001 — Saipan Apartment"
- Organization: `org_dev`
- Timezone: `Pacific/Saipan` (UTC+10, no daylight saving time)

## Verification status

`CLAUDE.md` prohibits claiming support for a vendor, protocol, or device until its
official interface **and exact model** are verified. As of 2026-07-26, **nothing at
Site 001 is verified.** No adapter, no reading with `measured` among its origins, and
no vendor claim may exist in this repository.

This document therefore records what is *believed* about the site and marks every
item's status. The unknowns are the point: an unverified assumption written down
is a task, while an unverified assumption left implicit becomes a false claim in
the product.

| Status | Meaning |
| --- | --- |
| **Unverified** | Believed from the charter or observation; no official documentation reviewed |
| **Unknown** | Not yet determined at all |
| **Verified** | Official interface documentation reviewed for a confirmed exact model, recorded in an ADR |

## Electrical service

| Item | Value | Status |
| --- | --- | --- |
| Utility | Commonwealth Utilities Corporation (CUC) | Unverified |
| Nominal line-to-neutral voltage | 120 V (placeholder) | **Unverified** — see D13 |
| Nominal line-to-line voltage | 240 V (placeholder) | **Unverified** — see D13 |
| Nominal frequency | 60 Hz (placeholder) | **Unverified** — see D13 |
| Service configuration | single-phase three-wire (assumed) | Unverified |
| Utility meter make/model | — | Unknown |
| Utility meter interface | — | Unknown |
| CUC data access (API, portal, bill export) | — | Unknown |
| Account/rate schedule, fuel adjustment mechanism | — | Unknown |

Every event-detection threshold derives from these nominals, which is why they are
expressed as fractions of nominal in `../architecture/event-detection.md` —
correcting the nominal corrects every rule at once. Confirmation sources, in
descending preference: a CUC service document, the apartment panel label, or a
calibrated meter reading.

## Backup and generation

| Item | Value | Status |
| --- | --- | --- |
| Building automatic transfer switch | present | Unverified |
| ATS make/model | — | Unknown |
| ATS transfer type (open/closed transition) | — | Unknown |
| ATS transfer time | — | Unknown |
| Generator | temporary building service | Unverified |
| Generator make/model, rating, fuel | — | Unknown |
| Battery system | Anker SOLIX | **Unverified — model not specified** |
| Battery exact model | — | **Unknown** |
| Battery usable capacity (Wh) | — | **Unknown** — required by the runtime model |
| Battery local interface (LAN, BLE, documented API) | — | **Unknown** |
| Solar | none reported | Unverified |

Three consequences follow directly:

1. **The ATS and generator are building equipment, not the tenant's.** Anything the
   platform says about them is observed indirectly from downstream measurements —
   `derivation: "inferred"` at best, and never with `measured` among its origins until
   a verified interface exists. This is why
   `../architecture/naming-and-identifiers.md` separates `source` from `site`.
2. **Unknown ATS transfer type means transfer detection cannot assume a
   sequence.** The rule in `event-detection.md` deliberately does not assume
   break-before-make.
3. **Unknown battery capacity means the runtime estimate has no real parameter.**
   The simulator uses a declared placeholder, labelled as such. No runtime figure
   derived from a guessed capacity may be presented as characterizing the real
   battery.

### On the Anker SOLIX system

The charter names an "Anker SOLIX battery system" without a model. Per the
verification rule, this repository must not:

- name Anker SOLIX as a supported integration, in code, UI, marketing, or
  package naming;
- build an adapter, or a placeholder adapter, against a presumed interface;
- infer a local API from a mobile application's traffic. That is
  reverse-engineering an unsupported vendor integration, which is an explicit
  approval gate in `CLAUDE.md`.

What is permitted now: naming it in this document as unverified site context, and
simulating a *generic* battery whose readings carry `origins: ["simulated"]`.

Before any integration: identify the exact model, obtain official interface
documentation, record it in an ADR with the evidence, then request approval.

## Critical loads

| Load | Source id | Status | Note |
| --- | --- | --- | --- |
| Standalone refrigerator | `src_001_sim_fridge` | Unverified | Cycling compressor; instantaneous power is a poor basis for runtime |
| Starlink terminal | `src_001_sim_starlink` | Unverified | Also the site uplink — its loss removes visibility |
| Nameplate ratings for both | — | Unknown | |

That Starlink is both a critical load and the uplink is the site's most
interesting property. When it loses power, the platform loses visibility at the
same instant, which is precisely why buffering exists and why
`../architecture/event-detection.md` refuses to treat a data gap as an outage.

## Site conditions

| Condition | Status |
| --- | --- |
| Intermittent utility outages | Unverified (charter) |
| Source transfers occur | Unverified (charter) |
| Older electrical infrastructure | Unverified (charter) |
| Outage frequency and duration | Unknown |
| Typical sag depth and duration | **Unknown** — needed for D14 thresholds |
| Apartment panel: circuits, breaker inventory | Unknown |
| Tenant occupancy pattern | Unknown |

Older infrastructure makes threshold hysteresis a requirement rather than a
refinement: boundary-hovering voltage is expected, not hypothetical.

## Simulated sources for Slice 0

Every reading from these carries `origins: ["simulated"]` and, for a raw observation,
`derivation: "direct"`.

| Source id | Represents | Metrics |
| --- | --- | --- |
| `src_001_sim_panel` | Apartment panel observation point | `voltage.rms`, `frequency`, `load.site.active_power`, `source.active` |
| `src_001_sim_battery` | Generic battery system | `battery.state_of_charge`, `battery.runtime_remaining` |
| `src_001_sim_fridge` | Refrigerator circuit | `load.refrigerator.active_power` |
| `src_001_sim_starlink` | Starlink circuit | `load.starlink.active_power` |
| `gw_001_1` | Site gateway | `gateway.link` |

Named `sim` in the identifier so no simulated source is ever mistaken for a real
one in a database, a log, or a support conversation. A real panel source would be
a new source id, never a re-labelling of this one.

## Data handling

Site 001 is a real dwelling. Its energy data reveals occupancy, sleep schedule,
and appliance use. Under `../security/data-classification.md` this is sensitive
customer data:

- No real Site 001 capture may be committed to this repository, in any form,
  including "anonymized" — a single named site cannot be anonymized.
- No real address, account number, meter serial, or occupant name appears in this
  repository. Note that this document contains none.
- All fixtures are synthetic.

## Open items

| Item | Decision | Blocks |
| --- | --- | --- |
| Confirm nominal voltage and frequency | D13 | Every detection threshold |
| Observe typical sag depth and duration | D14 | Threshold and debounce values |
| Identify exact Anker SOLIX model | D12 | Any future integration; capacity parameter |
| Determine battery usable capacity | D12 | Runtime estimate realism |
| Determine ATS make, model, transfer type | — | Transfer-detection fidelity |
| Determine refrigerator and Starlink nameplate ratings | — | Simulator realism |
| Determine CUC data access path | — | Bill import, rate analysis (post-Slice 0) |

None of these blocks Slice 0. Slice 0 is simulator-only by design, which is what
lets the platform be built correctly while the site is still being characterized.
