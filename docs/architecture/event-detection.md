# Event detection

Charter slice item 6 requires outage and restoration detection. This document
specifies what counts as each event, the thresholds, the debounce, and the
battery-runtime model — because "the power went out" is not self-evident in data. A
momentary sag, a source transfer, a de-energized main during maintenance, and a lost
uplink can all look alike in a raw series.

`packages/event-detection` is pure: reading series in, events out. No storage, no
clock, no configuration reads. Thresholds arrive as parameters, which is what makes
every rule below testable against fixtures.

## Unconfirmed inputs

Every threshold here derives from nominal voltage and frequency, and **neither is
verified**. `CLAUDE.md` forbids claiming verified facts about equipment or
utilities, so these are proposals to correct, not settled values.

> **TO CONFIRM (D13) — electrical nominals at Site 001**
>
> | Quantity | Proposed placeholder | Status |
> | --- | --- | --- |
> | Nominal line-to-neutral voltage | 120 V | **Unverified** |
> | Nominal line-to-line voltage | 240 V | **Unverified** |
> | Nominal frequency | 60 Hz | **Unverified** |
> | Service configuration | single-phase three-wire | **Unverified** |
>
> Placeholders pending confirmation from a CUC service document, the apartment panel
> label, or a meter reading. Nothing in the repository asserts them as fact, and
> every threshold below is expressed as a *fraction of nominal* so that correcting
> the nominal corrects every rule at once.

> **TO CONFIRM (D14) — thresholds and debounce.** The values below are engineering
> defaults, not observations of CUC behaviour. They need the owner's operational
> judgement: how deep and how long a sag runs at Site 001 before it is meaningfully
> an outage, and how quickly the building transfer switch acts. Wrong values here
> crash nothing — they quietly produce a wrong outage record, which is worse.

## Detected events

| Event | Meaning |
| --- | --- |
| `outage.started` | Usable power at the site ceased |
| `outage.ended` | Usable power returned |
| `source.transferred` | The supplying source changed between two live sources |
| `voltage.abnormal.started` / `.ended` | Sustained out-of-tolerance voltage while energized |
| `data.gap.started` / `.ended` | The platform lost visibility — **not** a power event |

## Rules

### Outage

**Enter** — either condition, sustained for the debounce window:

- `source.active` becomes `none`; **or**
- `voltage.rms` < `outageEnterFraction` × nominal.

**Exit** — both, sustained for the restore window:

- `source.active` is a live source (`utility`, `generator`, `battery`, `solar`);
  **and**
- `voltage.rms` ≥ `outageExitFraction` × nominal.

| Parameter | Proposed | Reasoning |
| --- | --- | --- |
| `outageEnterFraction` | 0.85 | Below this, motor loads and the refrigerator compressor cannot be considered served |
| `outageExitFraction` | 0.90 | **Deliberately above enter** — hysteresis |
| `outageEnterDebounceMs` | 5000 | Rides through transfer-switch operation and motor-start sags |
| `outageExitDebounceMs` | 10000 | Longer than enter: CUC restoration can be unstable, and a restoration retracted seconds later is worse than one reported 10 s late |

Hysteresis is required, not a refinement. With a single threshold, voltage hovering
at the boundary emits an unbounded stream of start/end pairs — and the older
infrastructure at Site 001 makes boundary-hovering likely, not hypothetical.

`unknown` source state **never** triggers an outage. It means we cannot tell what is
supplying power; asserting an outage from it fabricates history.

### Source transfer

`source.active` changes between two distinct live sources, sustained for
`transferDebounceMs` (proposed **3000 ms**).

- A transfer through `none` is **not** a transfer — it is an outage followed by a
  restoration on a different source. Site 001's building ATS behaviour is
  unverified, so the rule must not assume a break-before-make or make-before-break
  design.
- `unknown` is never an endpoint of a transfer.
- Recorded with both endpoints (`from`, `to`).

### Abnormal voltage

While a live source is present, `voltage.rms` outside ±`abnormalFraction` (proposed
**0.10**) of nominal for `abnormalDebounceMs` (proposed **30000 ms**).

Distinct from an outage: power is present but out of tolerance, which is what damages
equipment over time. An outage supersedes it — an outage in progress suppresses
abnormal-voltage events rather than emitting both.

### Data gap

No readings for a metric for longer than 3× its expected interval.

A gap is a **visibility** event and carries no claim about power. Rendering a gap as
an outage would let a Starlink drop manufacture an outage record. Where a real outage
caused the gap, the gateway's buffered readings arrive on reconnection and the outage
is derived from them — which is exactly why buffering exists.

## Event record

```ts
type DetectedEvent = {
  eventId: string;              // deterministic — see below
  siteId: string;
  type: EventType;
  occurredAt: string;           // RFC 3339 UTC — when the condition began,
                                // not when detection concluded
  endedAt?: string;

  origins: Origin[];            // union of input origins
  derivation: "inferred";       // every event in this module is a rule output
  lineage: Lineage;             // rule, ruleVersion, inputIds — required

  detail?: Record<string, unknown>;  // e.g. { from: "utility", to: "generator" }
};
```

Three properties that are easy to get wrong:

- **`occurredAt` is when the condition began, not when the debounce completed.** An
  outage that began at 04:15:30 and was confirmed at 04:15:35 occurred at 04:15:30.
  Recording confirmation time would bias every outage duration short by the debounce
  window.
- **Provenance carries both dimensions.** Every event from this module is
  `derivation: "inferred"` — it is a deterministic rule output — and its `origins` is
  the union of the origins of the readings it was derived from. In Slice 0 that means
  `origins: ["simulated"], derivation: "inferred"`, displayed as
  "Simulated · Inferred". The event is disclosed as both simulated in origin and
  inferred in method; neither fact is dropped in favour of the other.
- **Lineage is mandatory.** Every event resolves to the reading IDs it came from,
  plus the rule name and version (R5).

### Event identity

Event IDs are **deterministic**, derived from event type, rule version, and sorted
input reading IDs, as specified in `telemetry-envelope-v1.md`. Re-deriving over
unchanged inputs with an unchanged rule version reproduces the same `eventId`, which
is what makes re-derivation a no-op.

This is deliberately unlike readings, which get opaque random IDs: two identical
looking observations may both be real, whereas the same rule over the same inputs is
the same conclusion.

## Idempotent re-derivation

Derivation must be safely repeatable: backfilled readings arrive after events were
already derived, and rules get corrected.

1. **Deterministic.** Same readings, same rule version, same thresholds → identical
   events, including identical `eventId`s.
2. **Windowed.** Derivation runs over a bounded window and is idempotent within it.
3. **Backfill re-opens windows.** Readings arriving with `capturedAt` inside an
   already-derived window mark it for re-derivation. This is the common case at Site
   001: the outage's own readings arrive *after* the outage, on reconnection.
4. **Corrections are explicit.** A new `ruleVersion` produces new `eventId`s, which
   supersede prior events rather than mutating them. Superseded events are retained —
   an operational record that silently rewrites itself is not a record.

## Battery runtime estimate

Required by `README.md`. Always `derivation: "estimated"`, with `origins` taken from
its inputs — `["simulated"]` in Slice 0, `["measured"]` once a verified battery
reports. It is the clearest illustration of why the two dimensions are separate: the
method is identical in both cases and the trustworthiness is not.

```
usableWh   = capacityWh × (stateOfChargePercent / 100 − reserveFraction)
runtimeSec = usableWh / criticalLoadW × 3600
```

| Parameter | Proposed | Note |
| --- | --- | --- |
| `capacityWh` | **TO CONFIRM (D12)** | Depends on the exact Anker SOLIX model, which is unverified. The simulator uses a declared placeholder |
| `reserveFraction` | 0.10 | Batteries are rarely usable to 0% |
| `criticalLoadW` | trailing 5 min mean of refrigerator + Starlink | Instantaneous load is dominated by compressor cycling |

**Known failure modes, disclosed per rule R6:**

- Assumes the trailing critical load continues; a compressor cycling on invalidates
  it.
- Ignores temperature, battery age, and depth-of-discharge effects.
- Assumes reported SoC is accurate and linear in energy; neither is generally true.
- Undefined when critical load is zero — reported as unavailable, not infinity.
- **Not a safety guarantee.** It must never be presented as a countdown a person
  should rely on to protect medication, medical equipment, or food. UI copy reads as
  an estimate, and the value displays at whole-minute resolution: second-level
  precision on a number this uncertain communicates confidence that does not exist.

## Fixtures

`packages/event-detection/test/fixtures/` — synthetic series only, with fixed literal
reading IDs, per `../security/data-classification.md` and `testing-strategy.md`.

| Fixture | Must produce |
| --- | --- |
| `normal-day` | No events |
| `clean-outage` | One `outage.started` + one `outage.ended`, correct duration |
| `momentary-sag` | **No events** — sag shorter than debounce |
| `boundary-flutter` | **Exactly one** outage pair despite voltage hovering at the threshold |
| `generator-transfer` | `outage.started`, `outage.ended`, `source.transferred` — not a bare transfer |
| `unknown-source` | No events; `unknown` never implies an outage |
| `uplink-loss` | `data.gap.*` only, no power event |
| `backfilled-outage` | Same events and identical `eventId`s as `clean-outage` when readings arrive late; no duplicates on re-derivation |
| `abnormal-voltage` | Abnormal event; suppressed while an outage is in progress |
| `shared-timestamp` | Two readings at one instant both consumed; neither dropped |
| `mixed-origin` | Event over measured + manual inputs carries `origins: ["measured", "manual"]` — both disclosed, none chosen |

Every fixture asserts the derived event's `origins`, `derivation`, and resolvable
`lineage`, not only its type and timing.
