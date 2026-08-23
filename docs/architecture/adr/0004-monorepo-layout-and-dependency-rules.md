# ADR 0004 — Monorepo layout and dependency rules

- Status: **Accepted** 2026-07-26 (decision D3)
- Date: 2026-07-26
- Deciders: Repository owner

## Context

`README.md` defines seven top-level areas (`apps/`, `packages/`, `edge/`,
`docs/`, `infrastructure/`, `scripts/`, `.github/workflows/`). All are empty
except for `.gitkeep`. `CLAUDE.md` requires that product-independent
capabilities stay reusable, and the charter's enduring asset is "normalized
data, offline edge layer, integration framework, operational workflows, and
trusted record" — none of which is an application.

The failure mode to avoid is a platform whose reusable core quietly depends on
the first product built on it. That happens by a single convenient import, not
by a decision.

## Decision

### Layout for Slice 0

```
package.json                 # workspaces root; typecheck / lint / test / dev
tsconfig.base.json           # strict compiler settings
.nvmrc                       # 22
packages/
  contracts/                 # envelope v1, provenance, units, ids, time
  telemetry-store/           # TelemetryStore interface + SQLite implementation
  event-detection/           # pure outage/restoration/transfer rules
edge/
  gateway/                   # durable outbox, cursor/ack, flush loop, backoff
  simulator/                 # seeded generators + scenario runner
apps/
  api/                       # ingest + read HTTP API
  web/                       # single-site dashboard
infrastructure/              # unchanged in Slice 0
scripts/                     # local dev orchestration
```

### Dependency rules

Layers, innermost first. **Imports may only point inward.**

| Layer | Packages | May import |
| --- | --- | --- |
| 0 — Core | `contracts` | nothing in this repository |
| 1 — Domain | `event-detection` | `contracts` |
| 2 — Adapters | `telemetry-store` | `contracts` |
| 3 — Composition | `edge/*`, `apps/*` | any of layers 0–2 |

Consequences of the rule:

- `contracts` has **no** repository-internal dependency and no I/O — no
  filesystem, no network, no database, no clock reads, no environment access. It
  is pure data definition and pure functions. This is what makes it reusable
  across every future product.
- `event-detection` is **pure**: series of readings in, events out. No storage,
  no time-of-day dependence, no configuration reads. Thresholds arrive as
  parameters. This is what makes it testable against fixtures.
- `apps/*` and `edge/*` never import each other. Shared behavior moves down into
  a package instead.
- No package imports from `apps/` or `edge/`. A "small utility" borrowed upward
  from an app into a package is the exact regression this rule prevents.

### Enforcement

Rules stated only in prose decay. Slice 0 enforces them mechanically:

1. A lint rule restricting import paths per workspace.
2. A test asserting that `packages/contracts/package.json` declares no
   workspace dependency.
3. A test asserting no source file under `packages/` resolves an import to
   `apps/` or `edge/`.

### Naming

- Workspace package names: `@pacific-resilience/<dir>`.
- Directories, files, and npm scripts: `kebab-case`.
- Test files: `*.test.ts`, beside the code, except fixture-driven suites which
  live in the package's `test/` directory with fixtures under `test/fixtures/`.

## Consequences

- Reusability is verified by CI rather than asserted in a document.
- Slice 0 carries seven workspaces, which is more package overhead than a single
  application would need. That is the deliberate cost of keeping the core
  extractable from day one, and it is far cheaper now than after an application
  has grown into it.
- Adding an eighth workspace requires placing it in a layer, which forces the
  reuse question to be answered at creation time.

## Alternatives considered

- **Single package, split later.** Rejected: "split later" reliably means the
  core has absorbed application assumptions by then. The charter's whole thesis
  is that the reusable layer is the asset.
- **Separate repositories per layer.** Rejected: version coordination overhead
  with no compensating benefit at this size, and cross-repo refactoring is
  slow.
- **Flat `src/` with folder conventions.** Rejected: conventions without
  workspace boundaries cannot be enforced by tooling.

## Revisit when

An eighth or ninth workspace makes root-script fan-out slow (ADR 0002 revisits
the task runner); a second product begins consuming `contracts`, which will test
whether the core is genuinely product-independent; or a package needs to be
published externally.
