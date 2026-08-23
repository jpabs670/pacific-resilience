# Secrets and configuration

`CLAUDE.md` requires secrets to stay in local ignored environment files, with safe
placeholders in `.env.example` when configuration is introduced, and prohibits
committing credentials, tokens, private customer data, or machine-specific
secrets.

## Rule C-1 — `.env.example` describes reality

`.env.example` lists exactly the keys the code reads: no aspirational keys, no keys for
deferred services. It is the authoritative inventory of configuration, and CI verifies
the match (Slice 0 acceptance criteria).

Deferred services are documented in ADR 0003, where the *decision* belongs.

### Applied 2026-07-26 (decision D7)

`.env.example` previously declared `DATABASE_URL` (PostgreSQL), `MQTT_URL`,
`REDIS_URL`, and `OBJECT_STORAGE_ENDPOINT` — four services that were never decided,
are all deferred by ADR 0003, and are unreachable because Docker is not installed. It
also declared `APP_URL=http://localhost:3000`, presuming a framework and port that
ADR 0005 does not adopt. The file's own header was honest about being provisional, but
a config key that nothing reads is indistinguishable from one that is broken, and
someone would eventually have tried to make those work.

It now declares only what Slice 0 reads: `APP_ENV`, `API_PORT`, `SERVER_DB_PATH`,
`EDGE_OUTBOX_PATH`, `EDGE_INGEST_URL`, `EDGE_FLUSH_INTERVAL_MS`,
`EDGE_BATCH_MAX_READINGS`, `EDGE_OUTBOX_MAX_READINGS`, `EDGE_CLOCK_TOLERANCE_MS`,
`SIM_SEED`, `SIM_SCENARIO`, and `SIM_INTERVAL_MS`.

Three things worth noting about that set:

- **It contains no credentials at all.** Slice 0 has no database password, no API key,
  and no token. The safest secret-handling posture is having no secrets, and it is
  available here.
- `EDGE_INGEST_URL` is `http://127.0.0.1:4000` — plain HTTP, loopback, no TLS.
  Permitted for the local simulated environment only; TLS and gateway authentication
  become mandatory before any gateway communicates across a network. A future
  deployment configuration will need TLS material, and that is where the first real
  secrets enter this file's successor.
- The `./data/` paths are covered by `.gitignore`'s now-anchored `/data/` pattern and
  by `*.sqlite`, so no database file can be committed. `APP_URL` was dropped in favour
  of `API_PORT`; the dashboard is a static SPA under ADR 0005 and needs no application
  URL.

## Rule C-2 — Configuration is validated at startup

Environment variables are parsed and validated once, at startup, into a typed
configuration object. Nothing downstream reads `process.env`.

- Missing or malformed required values cause an **immediate exit with a clear
  message**, not a default. A gateway that silently falls back to a default
  ingest URL buffers to nowhere and reports success.
- Numeric and boolean values are parsed and range-checked. `EDGE_FLUSH_INTERVAL_MS=abc`
  must fail loudly at startup rather than become `NaN` in a timer.
- The parsed configuration is never logged in full. Individual non-secret values
  may be logged deliberately.

This satisfies the `CLAUDE.md` requirement for explicit schemas at system
boundaries — the environment is a boundary, and an untyped one by default.

## Rule C-3 — Secrets never enter the repository

When credentials eventually exist:

- Local development only, in `.env`, which is ignored.
- `.env.example` holds a **placeholder that cannot work** — `change-me`, never a
  real-looking value. A plausible placeholder gets copied into production.
- No secret in source, comments, tests, fixtures, logs, error messages, issues,
  PRs, or screenshots.
- No secret in a commit message.
- Production credentials are an explicit approval gate in `CLAUDE.md` and are not
  introduced by implementation work.

`.gitignore` already covers `.env`, `.env.*` (with `!.env.example`), `*.pem`,
`*.key`, `*.p12`, and `*.pfx`. The negation pattern is correct: `.env.example`
matches `.env.*` and is re-included.

## Rule C-4 — Machine-specific values are not committed

No absolute path, hostname, username, or serial number from a developer machine
enters the repository. Paths in `.env.example` are relative.

## Rule C-5 — Secret rotation assumes exposure is permanent

When a secret is ever committed, rotation is the only remedy. Removing it from
history does not un-expose it — the clone already happened, or did not, and there
is no way to know which. Any exposed credential is rotated and the exposure
recorded; history rewriting is optional cleanup, never the fix.

## Adding configuration

1. Add the key to the typed configuration schema with validation.
2. Add it to `.env.example` with a safe, non-working placeholder.
3. Document its meaning and default where the behaviour it controls is
   documented.
4. If it is a secret, confirm `.gitignore` covers its storage and note the
   rotation path.

A key that skips step 2 breaks rule C-1 and fails CI.

## Open items

| Item | Status |
| --- | --- |
| Reduce `.env.example` to keys Slice 0 reads | **Applied** 2026-07-26 (D7) |
| Narrow `.gitignore` `data/` → `/data/` | **Applied** 2026-07-26 (D8) |
| Credential scanning on every verification run and in CI | **Implemented** 2026-07-26 — `scripts/check-secrets.mjs`, wired into `npm run check` and `.github/workflows/ci.yml`. Dependency-free and first-party: an unpinned third-party action in the credential path would itself be a supply-chain exposure. `--self-test` proves each rule still matches its synthetic sample, so a pattern cannot rot into a no-op unnoticed. Suppression is an inline `secret-check:allow` marker, visible in review, with no configuration file |
| Secret manager for eventual deployment | Deferred until deployment is scoped |
| TLS certificate material and its handling | Deferred; required by threat-model item 2 before any non-loopback listener |
| Gateway credential issuance and rotation | Deferred; required by threat-model item 1 before any non-loopback listener |
