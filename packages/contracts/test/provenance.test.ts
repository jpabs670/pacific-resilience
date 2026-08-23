import { describe, expect, it } from "vitest";
import { DERIVATIONS, requiresLineage } from "../src/derivation.js";
import { lineageSchema } from "../src/lineage.js";
import {
  normalizeOrigins,
  ORIGINS,
  type Origin,
  originOrder,
  originsSchema,
  unionOrigins,
} from "../src/origin.js";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("origin vocabulary", () => {
  it("is exactly the four documented origins", () => {
    expect([...ORIGINS]).toEqual(["measured", "imported", "manual", "simulated"]);
  });

  it("accepts every origin, including measured, as vocabulary", () => {
    for (const origin of ORIGINS) {
      expect(originsSchema.safeParse([origin]).success).toBe(true);
    }
  });
});

describe("origins are non-empty", () => {
  it("rejects an empty set — there is no default origin", () => {
    const result = originsSchema.safeParse([]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("at least one origin");
  });
});

describe("duplicate origins are rejected on the wire and normalized by the helper", () => {
  it("rejects duplicates in wire form", () => {
    expect(originsSchema.safeParse(["simulated", "simulated"]).success).toBe(false);
  });

  it("normalizes duplicates for producers", () => {
    expect(normalizeOrigins(["simulated", "simulated", "manual"])).toEqual(["manual", "simulated"]);
  });
});

describe("canonical ordering is deterministic", () => {
  it("produces one ordering regardless of input order", () => {
    const permutations: readonly Origin[][] = [
      ["measured", "imported", "manual", "simulated"],
      ["simulated", "manual", "imported", "measured"],
      ["manual", "simulated", "measured", "imported"],
      ["imported", "measured", "simulated", "manual"],
    ];
    const normalized = permutations.map((input) => normalizeOrigins(input).join(","));
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe("measured,imported,manual,simulated");
  });

  it("rejects non-canonical wire order", () => {
    const result = originsSchema.safeParse(["simulated", "manual"]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("canonical order");
  });

  it("is stable across repeated application", () => {
    const once = normalizeOrigins(["simulated", "measured"]);
    expect(normalizeOrigins(once)).toEqual(once);
  });
});

describe("origins propagate as a union (rule R2)", () => {
  it("keeps every contributing origin and selects no winner", () => {
    expect(unionOrigins(["measured"], ["manual"])).toEqual(["measured", "manual"]);
    expect(unionOrigins(["simulated"], ["simulated"])).toEqual(["simulated"]);
    expect(unionOrigins(["manual"], ["measured"], ["simulated"])).toEqual([
      "measured",
      "manual",
      "simulated",
    ]);
  });

  it("does not collapse a mixed set to a single origin", () => {
    const union = unionOrigins(["measured"], ["manual"], ["imported"]);
    expect(union.length).toBe(3);
  });

  it("exposes ordering only, never precedence", () => {
    // originOrder exists for deterministic serialization. Equal-length sets of
    // different origins must never be comparable as "stronger" or "weaker".
    const orders = ORIGINS.map((origin) => originOrder(origin));
    expect(new Set(orders).size).toBe(ORIGINS.length);
  });
});

describe("derivation vocabulary", () => {
  it("is exactly the three documented methods", () => {
    expect([...DERIVATIONS]).toEqual(["direct", "inferred", "estimated"]);
  });

  it("requires lineage for everything except direct", () => {
    expect(requiresLineage("direct")).toBe(false);
    expect(requiresLineage("inferred")).toBe(true);
    expect(requiresLineage("estimated")).toBe(true);
  });
});

describe("lineage", () => {
  const valid = { rule: "outage", ruleVersion: "1.0.0", inputIds: [uuid(1)] };

  it("accepts a well-formed lineage", () => {
    expect(lineageSchema.safeParse(valid).success).toBe(true);
  });

  it("preserves input order rather than requiring it sorted", () => {
    const descending = { ...valid, inputIds: [uuid(2), uuid(1)] };
    const result = lineageSchema.safeParse(descending);
    expect(result.success).toBe(true);
    expect(result.data?.inputIds).toEqual([uuid(2), uuid(1)]);
  });

  it("rejects an unknown key", () => {
    expect(lineageSchema.safeParse({ ...valid, model: "x" }).success).toBe(false);
  });

  it("rejects a non-UUID input id", () => {
    expect(lineageSchema.safeParse({ ...valid, inputIds: ["reading-1"] }).success).toBe(false);
  });
});
