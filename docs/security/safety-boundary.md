# Safety boundary

The most important constraint in this repository. `README.md`, `CLAUDE.md`, and
`product-charter.md` each state it; this document turns it into an engineering
constraint with tests attached, because a boundary that exists only in prose is a
boundary that erodes.

## The boundary

**This platform observes. It does not act.**

Specifically, no component may command, actuate, energize, de-energize, open,
close, start, stop, enable, disable, schedule, throttle, or set a mode on:

- circuit breakers, disconnects, or protective devices
- generators or their controllers
- automatic or manual transfer switches
- utility equipment of any kind
- inverters, chargers, or battery-management systems
- load-shedding or demand-response actuators
- any other safety-critical asset

This is **not deferred**. It is excluded from this layer. Monitoring and human
decision support come first; humans remain responsible for critical actions.

## Why the line is drawn here and not further out

Three reasons, all specific to this project rather than generic caution:

1. **Nothing at Site 001 is verified.** No exact model, no official interface, no
   confirmed nominal voltage. Control built on unverified assumptions about
   equipment is control built on guesses about equipment that can start a fire or
   backfeed a line a lineworker is touching.
2. **The equipment is not the tenant's.** Site 001's ATS and generator are
   *building* equipment shared with other occupants. The site is authorized as a
   telemetry test environment and explicitly does not authorize control.
3. **Wrong action beats wrong number.** A wrong reading misleads a person who can
   check it. A wrong command acts on the physical world before anyone can.

## Consequences for design

The boundary is not just a rule about features — it shapes the architecture, and
these consequences are load-bearing:

- **The API is read-only toward physical assets.** No mutating endpoint exists for
  any asset. Ingest accepts observations; that is the only write path, and it
  writes to a database, not to equipment.
- **No device write path exists at all.** No adapter, no driver, no serial port,
  no Modbus write register, no vendor SDK. Not "unused" — absent. An unused write
  path is one merge away from a used one.
- **No control affordance in the UI.** No button, toggle, slider, or form that a
  person could reasonably read as commanding equipment. This includes affordances
  that would be disabled, "coming soon", or behind a flag: an operator in an
  outage does not reliably distinguish a disabled control from an unresponsive
  one.
- **No recommendation phrased as an instruction to act on equipment.** The
  platform may report "battery at 40%, estimated 2 h at current critical load". It
  may not say "switch to generator now." The first informs a decision; the second
  makes one.
- **Estimates never read as guarantees.** The runtime estimate must not be
  presented as a countdown to rely on for medication, medical equipment, or food
  safety. Its failure modes are disclosed and linked from the UI, and it is
  displayed at whole-minute resolution — second-level precision on a value that
  uncertain communicates confidence that does not exist.

## Enforcement

Prose decays; tests do not. These are in the non-negotiable set in
`../architecture/testing-strategy.md` and may not be deleted without an ADR:

| # | Test | Catches |
| --- | --- | --- |
| S1 | The API route table contains no path that commands any listed asset | A control endpoint arriving via scaffolding |
| S2 | No HTTP method other than `GET` exists outside `/v1/telemetry:batch` and explicitly listed configuration endpoints | A mutating route added without review |
| S3 | No rendered component exposes a control affordance | A control appearing in the UI first |
| S4 | The dependency graph contains no Modbus, serial, or vendor SDK package | A driver arriving as a transitive dependency |

S1 is the one that earns its keep. A control endpoint is far more likely to appear
because a framework generator emitted a full CRUD resource than because anyone
decided to add one. A failing build catches that on the same day; a document does
not catch it at all.

## Changing this boundary

Any change requires **all** of:

1. explicit written approval from the repository owner — `CLAUDE.md` lists
   safety-critical control features as an approval gate;
2. an ADR recording the decision, the exact equipment, the verified official
   interface, and the failure analysis;
3. verified hardware facts: exact model, official documentation, confirmed
   electrical service parameters;
4. a documented failure analysis covering what happens on wrong command, lost
   command, duplicated command, delayed command, and command during an outage;
5. an interlock design in which the platform is never the sole protection —
   physical and electrical protection remain authoritative;
6. a defined human authorization path for each command.

Absent any one of these, the answer is no. This list is deliberately hard to
satisfy: it should be easier to ship better monitoring than to ship control.

## What is permitted

To be clear that the boundary is about *action*, not about capability:

- reading, storing, normalizing, and displaying observations
- deriving events and estimates, labelled with both provenance dimensions and traced
  by lineage
- alerting and notifying humans
- recording human-entered records of actions humans took
- recommending that a person consider something, without instructing action on
  equipment
- simulating any of the above

Reporting that a transfer switch operated is monitoring. Operating it is not.
