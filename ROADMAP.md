# Roadmap

Pacific Resilience is being developed as a sequence of small, testable vertical slices. The roadmap is intentionally evidence-driven: a milestone is complete only when its acceptance checks and failure behavior are documented.

## Milestone 1 — Local ingest service

Goal: accept validated telemetry batches from the edge gateway without requiring public-cloud connectivity.

Acceptance checks:

- reject invalid schema versions and malformed identifiers;
- preserve batch ordering, source metadata, and sequence ranges;
- process idempotency keys without duplicating accepted readings;
- return explicit acknowledgements that the gateway can safely apply;
- document local startup, shutdown, backup, and restore procedures.

## Milestone 2 — Replayable outage demonstration

Goal: make the offline-first behavior understandable without reading the implementation.

Acceptance checks:

- run a deterministic outage/restore scenario from one command;
- show readings accumulating in the SQLite outbox while transport is unavailable;
- reconnect, retry in order, and apply acknowledgements without data loss or duplication;
- produce a bounded event summary suitable for an operator handoff;
- keep all demonstration data synthetic and clearly labeled.

## Milestone 3 — Operator recovery drill

Goal: prove that a human operator can diagnose and recover the local telemetry path from documented evidence.

Acceptance checks:

- define normal, degraded, failed, and recovering states;
- provide preflight, backup, restore, replay, and verification steps;
- separate reversible software actions from physical or safety-critical actions;
- record expected evidence for each recovery checkpoint;
- complete a tabletop exercise and publish the lessons learned.

## Later investigations

- operator-facing event timelines;
- signed configuration and update bundles for intermittently connected sites;
- storage-retention and compaction policies;
- multi-site fleet views that preserve local autonomy;
- integrations with monitoring and ticketing systems;
- deployment profiles for island offices, shelters, communications sites, and remote facilities.

## Non-goals

The project does not control breakers, transfer switches, generators, batteries, or other safety-critical equipment. Physical actions remain human-authorized and outside the current software boundary.
