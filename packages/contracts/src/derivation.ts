import * as z from "zod";

/**
 * How this particular record was produced.
 *
 * Independent of `origins`. `derivation` describes this record's own method and
 * is never inherited from its inputs: a deterministic rule applied to an
 * estimated input is still `inferred`, and the chain stays discoverable through
 * lineage. See docs/architecture/data-provenance.md, rule R3.
 */
export const DERIVATIONS = ["direct", "inferred", "estimated"] as const;

export type Derivation = (typeof DERIVATIONS)[number];

/** Derivation values that must carry lineage (rule R5). */
export type DerivedDerivation = Exclude<Derivation, "direct">;

export const derivationSchema = z.enum(DERIVATIONS);

/** True when the record must carry lineage. */
export function requiresLineage(derivation: Derivation): derivation is DerivedDerivation {
  return derivation !== "direct";
}
