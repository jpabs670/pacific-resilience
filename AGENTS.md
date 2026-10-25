# AGENTS.md — pacific-resilience

## Purpose
Offline-first, vendor-neutral telemetry platform for remote/island sites (Saipan first).
Monitoring and human decision support ONLY: the code is read-only toward physical
equipment. Never add actuation or control of breakers, transfer switches, generators
or batteries (see `docs/security/safety-boundary.md`).
Docs mention a `CLAUDE.md`; it is not in the repo, so this file is the agent rulebook.

## Stack
- Node.js 22 (`.nvmrc`, `engines: >=22 <23`), npm workspaces, ESM, TypeScript (strict, `tsconfig.base.json`).
- Zod for contracts, better-sqlite3 for the edge outbox (native build: needs `make` + `g++`).
- Vitest for tests, Biome for lint/format, `scripts/check-secrets.mjs` for secret patterns.

## Folder map
- `packages/contracts/` — Layer 0: Zod schemas + pure functions (envelope v1, ids, provenance, units, batches, acks). No I/O, no clock, no env, no repo-internal imports.
- `edge/simulator/` — seeded deterministic scenarios (`scenarios/*.json`).
- `edge/gateway/` — SQLite outbox, sequencing, batching, bounded retry, acknowledgement.
- `apps/` — reserved (api/web later). `infrastructure/` — empty by design.
- `docs/architecture/` — ADRs (`adr/000N-*.md`) and design notes; `docs/security/`, `docs/product/`, `docs/operations/`.
- Each workspace keeps tests in its own `test/`. Helpers/fixtures: `packages/contracts/test/fixtures/`; `edge/gateway/test/support/`; `edge/simulator/test/support/` plus scenario JSON in `edge/simulator/scenarios/`.

## Setup
`npm ci` with Node 22 on PATH. Node 20 fails the native build of better-sqlite3.

## Commands (all verified 2026-10-25 on Node 22.23.4)
- `npm run check`: Biome lint plus the secret scan. Both pass (156 files, 15 rules).
- `npm test`: Vitest in every workspace. 383 tests pass (contracts 224, gateway 109, simulator 50).
- `npm run typecheck`: `tsc` in every workspace. Passes.
- `npm run format`: `biome check --write .` — rewrites the WHOLE repo. To touch only your files, run `npx biome check --write <changed-files>` instead.
- One workspace: `npm test -w @pacific-resilience/gateway` (or `contracts`, `simulator`).

## Code style
- Biome: 2-space indent, line width 100, double quotes, semicolons, trailing commas, organized imports.
- Imports point inward only (ADR 0004): contracts <- domain/adapters <- edge/apps. The `test/architecture.test.ts` files enforce layering and the safety boundary.
- Every behavior change ships with a test (`docs/architecture/testing-strategy.md`). Non-negotiable tests are not deleted without an ADR.
- Synthetic or public data only. Mark fixtures as synthetic, never as field measurements.
- Retries stay bounded and idempotent. Keep provenance (source, quality, timing, derivation) on every reading.
- Architecture changes need a new ADR in `docs/architecture/adr/`. Do not edit accepted ADRs in place.
- Do not add services to `docker-compose.yml` or keys to `.env.example` without an approved ADR.

## Done means
`npm run check`, `npm test` and `npm run typecheck` all pass. Report the test counts.

## Rules for every Codex run
- Never push to `main` (or any default branch) and never force-push. The agent pushes the reviewed branch once.
- No secrets in code, commits, logs or briefs: no passwords, tokens, API keys, `.env` values or customer data.
- Keep changes inside this repo. Do not edit files in other repos, the Obsidian vault or `~/`.
- One ticket per branch and per PR; stay inside the files the brief puts in scope.
- Run the tests listed above before reporting done, and paste the result lines in your summary.
- Codex cannot commit (`.git` is read-only to it). Leave changes uncommitted; the agent reviews and commits.
- If a command fails because of the environment (missing tool, no network), report it; do not change config to dodge it.
