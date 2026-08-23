# ADR 0002 — Language, runtime, and package manager

- Status: **Accepted** 2026-07-26 (decisions D2, D3)
- Date: 2026-07-26
- Deciders: Repository owner

## Context

No language, runtime, or package manager has been chosen in writing.
`.gitignore` reserves `.pnpm-store/`, `.next/`, `.turbo/`, and a complete Python
toolchain (`__pycache__/`, `.venv/`, `.pytest_cache/`, `.mypy_cache/`,
`.ruff_cache/`), implying a pnpm-managed TypeScript monorepo alongside Python.
That combination was never decided.

Toolchain probe of this machine on 2026-07-26:

| Tool | Result |
| --- | --- |
| `node` | v22.22.3 — present |
| `npm` | 11.18.0 — present |
| `python3` | 3.14.6 — present |
| `git` | 2.55.0 — present |
| `pnpm` | **absent** |
| `docker` | **absent** |

Two repository rules constrain the choice directly. `CLAUDE.md` prohibits
installing global packages, and it requires strict typing with explicit schemas
at system boundaries.

## Decision

**Slice 0 is TypeScript on Node 22 LTS, managed with npm workspaces.**

1. **Runtime: Node 22 LTS**, pinned in `.nvmrc`. Already present at v22.22.3; long
   support window; built-in `crypto.randomUUID()` for reading identity, which is why
   no identifier library is needed (see `../telemetry-envelope-v1.md`).
2. **Language: TypeScript with `strict: true`**, plus
   `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Runtime
   validation at boundaries is specified separately in
   `telemetry-envelope-v1.md`; static types alone do not satisfy the
   boundary-schema requirement, because data crossing a process boundary is
   untyped at runtime.
3. **Package manager: npm workspaces**, not pnpm. pnpm is not installed, and the
   normal ways to obtain it — a global `npm i -g pnpm` or `corepack enable`,
   which writes global shims — are both global installs and therefore
   prohibited. npm 11 supports workspaces adequately for the Slice 0 package
   count. `.pnpm-store/` in `.gitignore` becomes vestigial; it is harmless and
   is left in place so a future switch needs no `.gitignore` change.
4. **Python is deferred, not prohibited.** It is introduced when a verified device
   interface requires a library with no adequate TypeScript equivalent (realistically
   Modbus or serial). This decision constrains Slice 0 only; later verified-hardware
   phases may adopt Python without superseding this ADR. The `.gitignore` Python
   entries are retained for that eventuality.
5. **No monorepo task runner** (Turbo, Nx) in Slice 0. Root npm scripts fan out
   across workspaces.

## Consequences

- One language for contracts, edge, API, and UI. Envelope types are shared by
  import rather than regenerated per language — the main reason to resist a
  polyglot split this early.
- No global installs are required to build Slice 0.
- npm workspaces gives weaker isolation than pnpm and no strict `node_modules`
  layout, so a package can import a transitive dependency it never declared.
  Dependency-boundary rules in ADR 0004 are therefore enforced by lint rule and
  test, not by the package manager.
- Python deferral means no Modbus, serial, or vendor SDK work in Slice 0. Slice 0 is
  simulator-only regardless, so nothing is lost now, and later phases are unaffected.

## Alternatives considered

- **pnpm workspaces.** Preferred on the merits — strict isolation, better
  monorepo ergonomics. Rejected only because obtaining it violates the
  no-global-installs rule. Reopen if the owner installs pnpm themselves.
- **Python for the edge, TypeScript for the web.** Rejected for Slice 0:
  duplicates the envelope schema across two type systems at the exact boundary
  where drift is most expensive, for no present benefit.
- **Deno or Bun.** Rejected: neither is installed, and both would trade a
  known-good ecosystem for setup risk.
- **JavaScript without TypeScript.** Rejected: contradicts the strict-typing
  requirement.

## Revisit when

The owner installs pnpm; a verified device requires a Python-only library; the
workspace count or build time makes a task runner worthwhile; or Node 22 leaves
LTS support.
