# ADR 0001 — Record architecture decisions

- Status: **Accepted** 2026-07-26
- Date: 2026-07-26
- Deciders: Repository owner

## Context

`CLAUDE.md` requires that decisions be documented before dependencies are added
or the platform is implemented, and that assumptions be documented near the
affected design. The repository currently contains implicit architectural
decisions with no written record: `.env.example` names PostgreSQL, MQTT, Redis,
and an object store; `.gitignore` reserves paths for pnpm, Next.js, Turbo, and a
full Python toolchain. None of these were decided in writing.

Implicit decisions are the problem this ADR exists to prevent. When a choice
lives only in a config file, later contributors cannot tell whether it was
deliberate, provisional, or accidental.

## Decision

Architecture decisions are recorded as numbered Markdown files in
`docs/architecture/adr/`, named `NNNN-kebab-case-title.md`, numbered
sequentially and never renumbered.

Each ADR carries a status:

| Status | Meaning |
| --- | --- |
| `Proposed` | Written and awaiting owner approval. Not safe to build on. |
| `Accepted` | Approved by the owner. Implementation may rely on it. |
| `Superseded by NNNN` | Replaced. Kept for history; never deleted or edited in place. |
| `Rejected` | Considered and declined. Kept so the reasoning is not relitigated. |

Every ADR states Context, Decision, Consequences, Alternatives considered, and
"Revisit when" — the observable condition that should reopen the decision. A
decision without a revisit trigger tends to outlive its justification.

An ADR is required before:

- adding, removing, or replacing a dependency;
- changing a boundary schema or wire format;
- changing storage, transport, or deployment topology;
- relaxing or reinterpreting a safety boundary. Tightening needs no ADR.

An ADR is not required for implementation detail, refactoring that preserves
boundaries, or documentation changes.

## Consequences

- Decisions are reviewable in isolation, and their reasoning survives.
- ADRs 0002–0005 were created `Proposed` and accepted by the owner on 2026-07-26,
  which is what unblocks Phase 1: they determine language, layout, storage, transport,
  and frontend.
- Existing config files that presumed undecided architecture (`.env.example`,
  `docker-compose.yml`) are reconciled by ADR 0003, not by quiet edits.

## Alternatives considered

- **A single running decision log.** Rejected: no stable identifier to cite from
  code or other documents, and status changes are hard to track.
- **Decisions recorded only in commit messages.** Rejected: the repository has
  no commits yet, and commit messages are not discoverable as a set.

## Revisit when

The ADR set exceeds roughly forty files and needs an index or grouping, or a
second regular contributor joins and the review flow needs to be stated.
