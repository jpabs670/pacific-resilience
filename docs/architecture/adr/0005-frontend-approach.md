# ADR 0005 — Frontend approach

- Status: **Accepted** 2026-07-26 (decision D6)
- Date: 2026-07-26
- Deciders: Repository owner

## Context

`.gitignore` reserves `.next/`, and `.env.example` sets
`APP_URL=http://localhost:3000`, together implying Next.js. Neither was decided
in writing.

The Slice 0 dashboard is one page for one site, shown to a small number of
known operators. It has no public URL, no SEO requirement, no server-rendered
content need, and — for Slice 0 — no authentication. Charter non-goals exclude
native mobile applications, but `README.md` requires the dashboard be
responsive, and the charter requires simulated values be labeled clearly.

## Decision

**Vite + React + TypeScript, built as a static single-page application, served
by `apps/api` or by Vite's dev server. Next.js is not adopted for Slice 0.**

1. **React** for the component model.
2. **Vite** for dev server and build. No SSR, no framework routing, no
   server-component boundary to reason about.
3. **Data fetching**: plain `fetch` against the read API with a small polling
   hook. No data-fetching library in Slice 0; `@tanstack/react-query` is the
   named upgrade when caching or invalidation becomes real work.
4. **Charts**: none in Slice 0. Current values, an origin-and-derivation label per
   value, and an event timeline are all achievable with plain markup, and rendering an
   estimated runtime as a smooth line is precisely the kind of false confidence the
   provenance rules exist to prevent. Charting is Phase 5+.
5. **Styling**: plain CSS with custom properties. No CSS framework.
6. **Responsive**: verified at 375 px and 1280 px per Slice 0 acceptance
   criteria.

### Binding UI constraints

These are safety and integrity requirements, not preferences, and they carry
tests:

- **No control affordance may exist anywhere in the UI** — no button, toggle,
  slider, or form that reads as commanding a breaker, generator, transfer
  switch, battery, or utility asset. See `safety-boundary.md`.
- **Every displayed value shows both provenance dimensions** — origin and derivation,
  such as "Simulated · Inferred" or "Measured · Estimated". No value renders bare, and
  neither dimension is hidden behind a hover.
- **A site-wide SIMULATED banner** is present whenever any displayed value has
  `simulated` among its origins.
- **Staleness is shown, never hidden.** A value older than twice its expected
  sampling interval renders as stale. Presenting a last-known value as current
  is a correctness defect in a platform whose subject is intermittent power.

## Consequences

- Fewer moving parts: no SSR runtime, no framework server, no hydration
  semantics. The API stays a plain HTTP service.
- `.next/` in `.gitignore` becomes vestigial and is left in place, so adopting
  Next.js later needs no `.gitignore` change.
- `APP_URL=http://localhost:3000` should be reconciled with the actual dev
  server port when `.env.example` is updated under ADR 0003.
- Server-side rendering, server-side session handling, and file-based routing are
  unavailable. None is needed for one internal page; all become arguments for Next.js
  when authentication and multi-tenant routing arrive.
- The dashboard is served over plain HTTP on loopback in Slice 0, per ADR 0003. It
  must not be exposed beyond loopback.
- No chart library means trend visualization waits. Acceptable: Slice 0 proves
  the data path, not the visualization.

## Alternatives considered

- **Next.js**, as `.gitignore` and `.env.example` imply. Rejected for Slice 0:
  its advantages (SSR, routing, server-side auth) all address problems Slice 0
  does not have, while adding a server runtime beside the API. Reopen at
  authentication.
- **Server-rendered HTML from Fastify**, no client framework. Genuinely viable
  and the smallest option; rejected because live-updating values and a
  provenance-badge component model are awkward without a client framework, and
  the dashboard is the part most likely to grow.
- **Vue or Svelte.** No objection on the merits; React chosen for ecosystem
  depth and hiring familiarity. Not a strongly held position.

## Revisit when

Authentication or multi-tenant routing is scoped; SEO or public pages appear;
trend charts are scoped; or the dashboard exceeds roughly five distinct views.
