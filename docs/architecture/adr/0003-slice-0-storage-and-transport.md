# ADR 0003 — Slice 0 storage and transport

- Status: **Accepted** 2026-07-26 (decisions D4, D5, D7)
- Date: 2026-07-26
- Deciders: Repository owner

## Context

`.env.example` originally declared four infrastructure dependencies — PostgreSQL,
MQTT, Redis, and an S3-style object store. No document decided any of them,
`docker-compose.yml` declares `services: {}`, and **Docker is not installed on the
development machine**, so all four were unreachable. `CLAUDE.md` requires that
decisions precede dependencies and prefers one small tested vertical slice.

Slice 0 has exactly one writer (a single simulated gateway), one site, and one reader
(one dashboard). It must prove durable local buffering across a connection loss and
idempotent synchronization. None of those four services is required to prove that;
each adds a container, a credential, and a failure mode.

## Decision

**Slice 0 uses SQLite via `better-sqlite3` for storage, and batched HTTP POST over
loopback for transport. No container runtime, no broker, no cache, no object store,
no TLS.**

### 1. SQLite driver: `better-sqlite3`

`better-sqlite3` is the decision, not one of two options.

Node 22.22.3 on this machine does expose `node:sqlite`, but it emits an
`ExperimentalWarning` on every use. A warning printed on every gateway start is
noise in exactly the logs that diagnose an offline-first system, and an experimental
API can change semantics across a minor Node release.

`node:sqlite` is recorded as the **fallback**, to be used only if installing
`better-sqlite3` proves incompatible with this machine — it is a native module and
requires a prebuilt binary or a local toolchain. If the fallback is taken, it is
recorded as an amendment to this ADR, along with the reason and how the warning is
handled.

### 2. Durability through transactions and PRAGMAs

Durability comes from SQLite transactions and PRAGMA configuration. **Slice 0
performs no manual `fsync`**, and no document may promise one.

| PRAGMA | Outbox (edge) | Server store | Reason |
| --- | --- | --- | --- |
| `journal_mode` | `WAL` | `WAL` | Concurrent read during write; well-understood recovery |
| `synchronous` | `FULL` | `NORMAL` | Asymmetric — see below |
| `busy_timeout` | `5000` | `5000` | Avoids spurious `SQLITE_BUSY` under WAL |
| `foreign_keys` | `ON` | `ON` | Lineage links must resolve |

`synchronous = FULL` on the outbox flushes the WAL at each commit, so a committed
reading survives process crash and host power loss — to the extent the OS and storage
hardware honour the flush, which a consumer device with a volatile write cache may
not fully. That caveat is stated rather than papered over.

`synchronous = NORMAL` on the server store is deliberate: the server store can be
**re-fed from the edge**, since the gateway retains readings until acknowledged. The
outbox cannot be re-created from anywhere. Durability effort belongs where loss is
unrecoverable.

One transaction per sampling tick, not per reading — at 1 s cadence that is a handful
of commits per second, and it keeps a tick's readings atomic.

### 3. Server store behind an interface

Every query goes through a `TelemetryStore` interface in
`packages/telemetry-store`; no SQL escapes it. Replacing SQLite with PostgreSQL later
is then one implementation, not a migration of call sites. The interface must not leak
SQLite semantics — no `INTEGER PRIMARY KEY` assumptions, no reliance on type affinity.

### 4. Transport: HTTP over loopback

`POST /v1/telemetry:batch` at `http://127.0.0.1:4000`, with at-least-once delivery
from the edge and idempotent upsert keyed on the reading's opaque `readingId`.

- **Plain HTTP is permitted only for the local simulated Slice 0 environment.**
- Slice 0 implements **no TLS** and no certificates. No document may claim transport
  security, and nothing in Slice 0 rejects plaintext, because there is nothing to
  reject it in favour of.
- **TLS and per-gateway authentication become mandatory before any gateway
  communicates across a network** — any non-loopback listener, any real site. These
  are requirements 1 and 2 in `../../security/threat-model.md`.

Batching, sequencing, durability, and idempotency are transport-agnostic, so adding
TLS changes configuration and deployment, not the protocol in
`../offline-sync-and-idempotency.md`.

### 5. Deferred, with explicit triggers

| Deferred | Introduce when |
| --- | --- |
| PostgreSQL | More than one concurrent writer, more than one site with real retention, or a query SQLite cannot serve. Requires Docker → separate approval |
| MQTT / Mosquitto | Many gateways, or bandwidth so constrained that per-batch HTTP overhead matters. Site 001 has Starlink; it does not |
| Redis | Genuine real-time fan-out or a work queue exists. Slice 0 has neither |
| Object storage | Evidence uploads begin (panel photos, nameplate images). Brings sensitive-data handling — see `../../security/data-classification.md` |
| TLS | Any non-loopback listener. Not optional at that point |

Deferral is not prohibition: each of these, and Python per ADR 0002, remains available
in later phases once a verified need exists.

### 6. Configuration reconciled

`.env.example` declares only keys the code reads. Deferred service URLs are removed
rather than left as aspirational placeholders, because a config key that nothing reads
is indistinguishable from one that is broken. `docker-compose.yml` stays inert
(`services: {}`) until a service genuinely exists.

## Consequences

- Slice 0 runs with `node` and `npm` alone: clone, install, run. No Docker, no
  service credentials, no port conflicts.
- SQLite's single-writer model is a real constraint. It is invisible at one gateway
  and one site, and becomes the PostgreSQL trigger the moment a second concurrent
  writer exists.
- `better-sqlite3` is a native module, so `npm install` may need a toolchain if no
  prebuilt binary matches. This is the one place Slice 0 could fail to install
  cleanly, which is why the fallback is named.
- Batched HTTP bounds telemetry latency by flush interval rather than being
  near-instant. Acceptable for monitoring; would not be for control — which is out of
  scope by safety boundary regardless.
- Running without TLS means Slice 0 must never be exposed beyond loopback, not even
  briefly for a demo. That constraint is a deployment discipline, not a code
  guarantee, and it is why the tripwire is written down.
- `.gitignore` covers `*.db`, `*.sqlite`, and `/data/`, so no database file can be
  committed.

## Alternatives considered

- **PostgreSQL now**, per the original `.env.example`. Rejected: requires installing
  Docker (absent, approval-gated) to serve one writer and one site.
- **`node:sqlite` as the primary driver.** Rejected for the `ExperimentalWarning` and
  the risk of semantic change across minor Node releases. Retained as fallback.
- **MQTT now.** Rejected: a broker plus topic design plus QoS semantics, when the hard
  requirements — durability and exactly-once effect — are solved at the buffer and
  idempotency layers, not by the transport.
- **JSONL as the edge buffer.** Rejected: crash-safe append, cursor tracking, and
  dedup all get hand-rolled. SQLite provides them with one dependency.
- **In-memory buffer with periodic flush.** Rejected outright: fails the one
  requirement Slice 0 exists to prove.
- **Self-signed TLS on loopback for Slice 0.** Rejected: certificate management for a
  single-machine simulator is overhead that buys nothing, and a self-signed local cert
  invites the habit of ignoring certificate errors.

## Revisit when

A second gateway or concurrent writer appears; any non-loopback listener is
introduced (TLS becomes mandatory, not a revisit); `better-sqlite3` fails to install
(take the documented fallback); evidence uploads are scoped; or retention outgrows
SQLite.
