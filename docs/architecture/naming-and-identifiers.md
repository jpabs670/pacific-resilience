# Naming and identifiers

Identifiers outlive the code that creates them. This document fixes them before
any row exists, because renaming an identifier scheme after data is stored is a
migration, and renaming a metric is worse — historical series silently split.

## Hierarchy

```
organization
└── site                     (Site 001)
    └── source               (a thing that reports: panel, battery, meter, simulator)
        └── metric           (voltage.rms, load.site.active_power, …)
            └── reading      (one metric value at one instant)
```

`site` and `source` are separated deliberately. Site 001's building transfer
switch and generator are **not** the tenant's equipment, so anything reported
about them comes from a source that observes them indirectly. Collapsing source
into site would erase that distinction, and with it the ability to say why a
value is `inferred` rather than `measured`.

## Identifier format

All identifiers are lowercase ASCII, `[a-z0-9_]`, prefixed by type, stable
forever, and never reused. They are opaque: no code parses meaning out of an
identifier.

| Entity | Format | Slice 0 value |
| --- | --- | --- |
| Organization | `org_<slug>` | `org_dev` |
| Site | `site_<zero-padded-3>` | `site_001` |
| Source | `src_<site-suffix>_<role>` | `src_001_sim_panel`, `src_001_sim_battery`, `src_001_sim_fridge`, `src_001_sim_starlink` |
| Gateway | `gw_<site-suffix>_<n>` | `gw_001_1` |
| Reading | opaque UUID, assigned once at creation | — |
| Event | UUID derived deterministically from type, rule version, and input IDs | — |

Readings and events are the two entities whose identifiers are **not** readable
slugs, and they differ from each other on purpose. A reading gets an opaque random
UUID because two legitimate observations may look identical, so identity cannot be
computed from content. An event gets a deterministic UUID because the same rule over
the same inputs is the same conclusion, and re-derivation must not mint a new record.
Both are specified in `telemetry-envelope-v1.md`.

**"Site 001" is a display name; `site_001` is the identifier.** They are never
interchanged. The display name is editable by a human at any time; the
identifier is not editable at all.

Rationale for readable slugs over opaque ULIDs at this stage: Slice 0 has one
organization and one site, and debuggable fixtures are worth more than
collision resistance we do not need. Sources created by real hardware later
should use ULID suffixes, since their count is unbounded.

## Metric vocabulary

Metric names are `dot.separated.lowercase`, ordered general to specific, and
**closed**: adding a metric requires updating the registry in
`packages/contracts` and its fixtures. An unregistered metric is rejected at
ingest.

### Numeric metrics

| Metric | Unit | Range | Notes |
| --- | --- | --- | --- |
| `voltage.rms` | `V` | 0–300 | RMS volts at the measurement point |
| `frequency` | `Hz` | 0–70 | Zero only when de-energized |
| `load.site.active_power` | `W` | ≥ 0 | Whole-apartment active power |
| `load.refrigerator.active_power` | `W` | ≥ 0 | Critical load |
| `load.starlink.active_power` | `W` | ≥ 0 | Critical load |
| `battery.state_of_charge` | `percent` | 0–100 | Reported SoC, not inferred |
| `battery.runtime_remaining` | `s` | ≥ 0 | Always `derivation: "estimated"` — see R6 |

### State metrics

| Metric | Domain | Values |
| --- | --- | --- |
| `source.active` | `energy_source` | `utility`, `generator`, `battery`, `solar`, `none`, `unknown` |
| `gateway.link` | `link_state` | `online`, `offline`, `unknown` |

`solar` is in the domain but not present at Site 001; the charter's market
includes solar installers, and a domain that must be widened later invalidates
stored data. `unknown` is required and distinct from `none`: "we cannot tell
what is supplying power" and "nothing is supplying power" are different facts,
and conflating them would fabricate outages.

### Naming rules

1. Prefer a new source over a new metric. Two refrigerators are two sources of
   `load.*.active_power`, not `load.refrigerator_2.active_power`.
2. No units in metric names. The unit is a field; `load.site.active_power_w` is
   invalid.
3. No aggregation in metric names. Never `load.site.active_power.hourly_avg`;
   aggregation is a query, and baking it into the name makes it unqueryable.
4. No provenance in metric names. Never `..._simulated`, never `..._estimated`.
   Origin and derivation are fields; encoding either in the name would split the
   series when real hardware arrives — the exact outcome the platform exists to
   avoid.

## Units

Closed registry. Each metric is bound to exactly one unit; conversion happens at
display, never in storage.

| Unit | Meaning | Stored as |
| --- | --- | --- |
| `V` | volts RMS | number |
| `Hz` | hertz | number |
| `W` | watts, active power | number |
| `Wh` | watt-hours | number |
| `percent` | 0–100, not 0–1 | number |
| `s` | seconds | number |

Base units only in storage — watts, not kilowatts; watt-hours, not
kilowatt-hours; seconds, not hours. A single storage unit per quantity removes
an entire class of factor-of-1000 defect. Display may scale freely (`4.2 kW`,
`3 h 20 m`) provided the underlying value is unchanged.

`percent` is 0–100 because that is how SoC is universally reported and displayed;
storing 0–1 guarantees someone eventually renders `0.87%`.

## Time

| Field | Meaning | Authority |
| --- | --- | --- |
| `captured_at` | When the observation occurred | Edge clock — **may be wrong** |
| `received_at` | When the server accepted it | Server clock — authoritative for arrival |
| `occurred_at` | When a derived event began | Derived from `captured_at` values |

Timestamps are observation attributes only. **No identifier is derived from a
timestamp**, so a wrong clock degrades a reading's metadata without corrupting its
identity — see `telemetry-envelope-v1.md`.

Rules:

1. **Wire format**: RFC 3339 with milliseconds, always UTC, always `Z`:
   `2026-07-26T04:15:30.250Z`. Offsets other than `Z` are rejected rather than
   normalized, so a wrong offset surfaces as an error instead of a silent shift.
2. **Storage**: integer epoch milliseconds, UTC.
3. **Display**: `Pacific/Saipan`, UTC+10, **no daylight saving time**. Never
   display raw UTC to an operator reasoning about last night's outage.
4. **Never** the machine's local timezone anywhere in logic.
5. Site 001's gateway may lose time across a power loss. The gateway reports its
   clock offset with each batch; when the offset exceeds the configured
   tolerance, readings are flagged `clock_suspect` and remain usable but visibly
   qualified. Discarding them would lose exactly the data from the outage the
   platform most needs to explain.

## Reserved

- `site_000`, `org_test`, `src_000_*` — reserved for tests, never real data.
- Names beginning `internal.` — reserved for platform diagnostics, excluded from
  customer-facing views.
