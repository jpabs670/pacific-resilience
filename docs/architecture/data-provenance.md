# Data provenance

Provenance is the platform's integrity claim. The charter's problem statement ends
with the need to know "which readings are measured, imported, manual, inferred,
estimated, or simulated," and `CLAUDE.md` requires that distinction be preserved.

The failure this prevents is specific: a number that was modelled, guessed, or
simulated being read as though an instrument measured it. On a platform whose
subject is backup power during outages, that is not cosmetic — someone decides
whether a refrigerator will survive the night based on it.

## Two dimensions, not one enum

Provenance answers **two independent questions**, and a single flat enum conflates
them:

- **Origin** — where the underlying data came from.
- **Derivation** — how this particular record was produced from it.

They vary independently. A runtime estimate from a real battery and a runtime
estimate from a simulator share a derivation method and share nothing else. An
outage inferred from measured voltage and an outage inferred from simulated
voltage share a rule and differ in what they say about the world. Collapsing
either pair into one label destroys information that a reader needs.

### `origins`

| Value | Definition | Site 001 example |
| --- | --- | --- |
| `measured` | Read from a device through a **verified** official interface for a **confirmed exact model** | *None yet — nothing at Site 001 is verified* |
| `imported` | Taken from an external system's own record, unchanged in meaning | A CUC bill's kWh total, once bill import exists |
| `manual` | Entered by a human | An operator recording a generator start time |
| `simulated` | Produced by the simulator. Never real | Every reading in Slice 0 |

`measured` has a hard precondition: an official interface and exact model verified
and recorded in an ADR. Until then **no record** in this repository may carry it —
directly from the `CLAUDE.md` rule against claiming support for an unverified
vendor, protocol, or device.

That prohibition is on records, not on the vocabulary. `measured` is a valid
`origins` member that the schema accepts, because the schema must be complete
before hardware arrives; what may not exist is a stored reading, event, or test
fixture asserting it. Both halves are enforced:
`packages/contracts/test/provenance.test.ts` proves the schema accepts `measured`,
and `test/fixture-hygiene.test.ts` proves no fixture record carries it.

**`origins` is a set, not a single value.** A derived record carries every origin
that contributed to it. A daily total combining measured readings with one
manually entered figure has `origins: ["measured", "manual"]` — it discloses both
rather than silently choosing one. For a direct observation the set has exactly one
member, which is the common case and reads naturally: `origins: ["simulated"]`.

There is **no ranking among origins** and nothing selects a winner from the set.
The values are serialized in the fixed order above purely so that equal sets
compare equal; that order carries no precedence and no code may treat it as one. A
test asserts that no ranking function over origins exists anywhere in the
codebase, because a "strongest origin" helper is the most likely way the collapsed
model would return.

On the wire, `origins` must arrive already deduplicated and canonically ordered;
the boundary rejects a non-canonical set rather than repairing it. Producers
canonicalize first with `normalizeOrigins`, or build the union with
`unionOrigins`. Reasoning is in `telemetry-envelope-v1.md` under "Canonical wire
form".

### `derivation`

| Value | Definition | Test |
| --- | --- | --- |
| `direct` | The record *is* the observation, unprocessed | Nothing was computed |
| `inferred` | Produced by a deterministic, documented rule with no error model | Given correct inputs, the conclusion follows |
| `estimated` | Produced by a model with error | Can be wrong even with perfect inputs |

The `inferred` / `estimated` boundary is the one that matters. "Source became
`none` and voltage collapsed, therefore an outage began" is `inferred`: correct
inputs give a correct conclusion. "This battery will last 4.2 hours" is
`estimated`: it depends on a load model, temperature, battery age, and chemistry,
and it can be wrong with perfect inputs.

`derivation` describes **this record's own method**. It is not inherited from
inputs. A rule applied to an estimated input is still `inferred` — its own step
introduces no error model — and the fact that its input was estimated stays
discoverable through lineage rather than by flattening it into this field.

### Worked examples

| Record | `origins` | `derivation` | Display |
| --- | --- | --- | --- |
| Simulator voltage reading | `["simulated"]` | `direct` | Simulated · Direct |
| Outage inferred from simulated voltage | `["simulated"]` | `inferred` | Simulated · Inferred |
| Runtime estimated from simulated battery data | `["simulated"]` | `estimated` | Simulated · Estimated |
| Runtime estimated from measured battery data | `["measured"]` | `estimated` | Measured · Estimated |
| Outage inferred from measured voltage | `["measured"]` | `inferred` | Measured · Inferred |
| Daily total over measured readings and one manual entry | `["measured", "manual"]` | `inferred` | Measured + Manual · Inferred |

The second and fourth rows are why the model needs two dimensions: under a flat
enum they would either both be "estimated" — hiding that one is fiction — or both
"simulated" — hiding that one is a model output.

## Rules

### R1 — Both dimensions required, never defaulted

`origins` and `derivation` are required on every reading, every event, and every
value crossing an API boundary. `origins` is non-empty. Neither has a default in
code, in the schema, or in the database. A schema that defaulted either would make
the most dangerous case — an unlabelled value — also the easiest to produce.

Tested by: a record missing either field is rejected; an empty `origins` is
rejected; no type declares either optional; no column carries a `DEFAULT`.

### R2 — Origins propagate as a union

A derived record's `origins` is the **union** of its inputs' origins. Nothing is
dropped, collapsed, or ranked.

Consequences worth stating plainly:

- In Slice 0 every input is simulated, so every derived record has
  `origins: ["simulated"]` — including outage events and runtime estimates. A
  simulated outage is disclosed as simulated.
- Once a real device is verified, an outage inferred from its readings carries
  `origins: ["measured"]` **and** `derivation: "inferred"`. Both facts survive.
- A record mixing a measured reading with a manual entry discloses both origins.
  It does not become "manual" because manual is somehow weaker; there is no
  weaker.

Tested by: derivation over simulated fixtures yields `origins: ["simulated"]`;
mixed-origin inputs yield the full union, in canonical order, deduplicated.

### R3 — Derivation reflects method, lineage reflects the chain

`derivation` is set by how this record was produced, never inherited. Whether an
estimate is present anywhere upstream is answered by walking `lineage`, not by
overwriting this field.

Aggregations are `inferred` when they are pure computation over their inputs, and
`estimated` when a model is involved.

Tested by: a deterministic rule over an estimated input produces `inferred`, and
its lineage resolves to the estimated input.

### R4 — Both dimensions reach the display

Every value shown to a person displays both dimensions — "Simulated · Inferred",
"Measured · Estimated". No value renders bare, in any view, at any density.

- Multiple origins are all shown: "Measured + Manual · Estimated".
- When any displayed value has `simulated` among its origins, a site-wide
  SIMULATED banner is shown.
- Neither dimension is hidden behind a hover or tooltip. Provenance that requires
  interaction to discover fails this rule.

Tested by: a rendering test asserting no value node lacks both an origin and a
derivation label.

### R5 — Lineage is required for derived records

Every record whose `derivation` is `inferred` or `estimated` carries `lineage`:
the input record IDs it was derived from, and the identifier and version of the
rule or model that produced it. Records with `derivation: "direct"` carry no
lineage — there is no chain.

A provenance label that cannot be traced back is an assertion, not provenance.

Tested by: every derived record resolves to at least one existing input record;
`lineage` is rejected on a `direct` record and required otherwise.

### R6 — Estimates disclose their model

Any record with `derivation: "estimated"` has a written formula, its assumptions,
and its known failure modes in this repository, linked from the UI. Battery
runtime is the first instance; its model is in `event-detection.md`.

## Representation

```ts
// packages/contracts — illustrative shape, not implementation
type Origin = "measured" | "imported" | "manual" | "simulated";
type Derivation = "direct" | "inferred" | "estimated";

type Lineage = {
  rule: string;        // e.g. "outage"
  ruleVersion: string; // e.g. "1.0.0"
  inputIds: string[];  // reading or event IDs this was derived from
};

type Provenance =
  | { origins: Origin[]; derivation: "direct" }
  | { origins: Origin[]; derivation: "inferred" | "estimated"; lineage: Lineage };
```

The union enforces R5 in the type system: a `direct` record has no place to put
lineage, and a derived one cannot omit it.

Storage:

- `origins` as a normalized child table, or as a canonically ordered JSON array
  with a `CHECK` constraint restricting members to the four values. Either way the
  database rejects an unknown origin and an empty set — the database outlives any
  given service, so it holds the constraint.
- `derivation` as a text column with a `CHECK` listing the three values.
- `lineage` rows link a derived record to each input record ID, with the rule and
  version. A foreign key ensures inputs exist.

### Display labels

| Field | Value | Label |
| --- | --- | --- |
| origin | `measured` | Measured |
| origin | `imported` | Imported |
| origin | `manual` | Manually entered |
| origin | `simulated` | **Simulated** — prominent, unmissable |
| derivation | `direct` | Direct |
| derivation | `inferred` | Inferred |
| derivation | `estimated` | Estimated |

`simulated` is styled to be impossible to overlook. `inferred` and `estimated`
qualify a value; `direct` and the other origins are neutral and informative.

## Relationship to other concerns

- **Provenance is not a privacy control.** A `simulated` origin makes data safe to
  commit; `measured` or `imported` does not by itself make data sensitive.
  Exposure is governed by `../security/data-classification.md`; this document
  governs truthfulness. Conflating them produces both bad privacy and bad labels.
- **Provenance must not be trusted from the wire.** Once real devices exist, a
  sender's claimed `origins` cannot be authoritative — see threat-model
  requirement 3.

## Open item

`imported` is defined but unused in Slice 0; no import path exists yet. It is
specified now so bill import does not later invent a fifth origin (decision D11).
