import * as z from "zod";
import { addIssue } from "./issue.js";

/**
 * Where the underlying data came from.
 *
 * This array also fixes the canonical serialization order. That order exists so
 * that equal origin sets compare and serialize identically — it is **not** a
 * ranking, and nothing in this package or any consumer may treat it as one.
 * See docs/architecture/data-provenance.md, rule R2.
 */
export const ORIGINS = ["measured", "imported", "manual", "simulated"] as const;

export type Origin = (typeof ORIGINS)[number];

const ORIGIN_ORDER: ReadonlyMap<string, number> = new Map(ORIGINS.map((origin, i) => [origin, i]));

/** Canonical serialization position. Ordering only; carries no precedence. */
export function originOrder(origin: Origin): number {
  return ORIGIN_ORDER.get(origin) ?? ORIGINS.length;
}

/** Deduplicate and canonically order. For producers building a record. */
export function normalizeOrigins(origins: readonly Origin[]): Origin[] {
  return [...new Set(origins)].sort((a, b) => originOrder(a) - originOrder(b));
}

/**
 * Union of every contributing origin, deduplicated and canonically ordered.
 *
 * This is rule R2: a derived record discloses every origin that contributed to
 * it. Nothing is dropped, collapsed, or selected as a winner.
 */
export function unionOrigins(...groups: readonly (readonly Origin[])[]): Origin[] {
  return normalizeOrigins(groups.flat());
}

export const originSchema = z.enum(ORIGINS);

/**
 * Wire form for `origins`: non-empty, deduplicated, canonically ordered.
 *
 * Non-canonical input is rejected rather than normalized, so that one logical
 * record has exactly one accepted wire form. See `normalizeOrigins` for the
 * producer-side helper.
 */
export const originsSchema = z.array(originSchema).superRefine((origins, ctx) => {
  if (origins.length === 0) {
    addIssue(
      ctx,
      "origins.empty",
      "origins must list at least one origin; there is no default origin",
    );
    return;
  }

  const seen = new Set<Origin>();
  let duplicated = false;
  for (const [index, origin] of origins.entries()) {
    if (seen.has(origin)) {
      duplicated = true;
      addIssue(ctx, "origins.duplicate", `duplicate origin "${origin}"`, [index]);
    }
    seen.add(origin);
  }
  if (duplicated) {
    return;
  }

  const canonical = normalizeOrigins(origins);
  if (canonical.join("") !== origins.join("")) {
    addIssue(
      ctx,
      "origins.unordered",
      `origins must be in canonical order: ${canonical.join(", ")}`,
    );
  }
});
