import { describe, expect, it } from "vitest";
import { formatIssues, type RawError } from "../src/errors.js";
import {
  gatewayIdSchema,
  isUuid,
  orgIdSchema,
  readingIdSchema,
  siteIdSchema,
  sourceIdSchema,
} from "../src/identifiers.js";

describe("reading identity", () => {
  it("accepts a canonical lowercase UUID", () => {
    expect(readingIdSchema.safeParse("0f8d3c1e-6b2a-4d17-9c54-8a1e2f6b7c01").success).toBe(true);
    expect(readingIdSchema.safeParse("00000000-0000-4000-8000-000000000001").success).toBe(true);
  });

  it("rejects uppercase, so one identifier has one wire form", () => {
    expect(readingIdSchema.safeParse("0F8D3C1E-6B2A-4D17-9C54-8A1E2F6B7C01").success).toBe(false);
  });

  it("rejects the nil and max UUIDs", () => {
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isUuid("ffffffff-ffff-ffff-ffff-ffffffffffff")).toBe(false);
  });

  it("rejects malformed shapes", () => {
    for (const candidate of [
      "reading-1",
      "",
      "0f8d3c1e6b2a4d179c548a1e2f6b7c01",
      "0f8d3c1e-6b2a-4d17-9c54-8a1e2f6b7c0",
      "0f8d3c1e-6b2a-4d17-cc54-8a1e2f6b7c01",
      "0f8d3c1e-6b2a-0d17-9c54-8a1e2f6b7c01",
      " 0f8d3c1e-6b2a-4d17-9c54-8a1e2f6b7c01",
    ]) {
      expect(isUuid(candidate), `expected ${JSON.stringify(candidate)} to be invalid`).toBe(false);
    }
  });
});

describe("entity identifiers", () => {
  it("accepts the documented Site 001 identifiers", () => {
    expect(siteIdSchema.safeParse("site_001").success).toBe(true);
    expect(sourceIdSchema.safeParse("src_001_sim_panel").success).toBe(true);
    expect(gatewayIdSchema.safeParse("gw_001_1").success).toBe(true);
    expect(orgIdSchema.safeParse("org_dev").success).toBe(true);
  });

  it("accepts the reserved test identifiers", () => {
    expect(siteIdSchema.safeParse("site_000").success).toBe(true);
    expect(orgIdSchema.safeParse("org_test").success).toBe(true);
  });

  it("rejects display names, uppercase, and wrong prefixes", () => {
    expect(siteIdSchema.safeParse("Site 001").success).toBe(false);
    expect(siteIdSchema.safeParse("site_1").success).toBe(false);
    expect(siteIdSchema.safeParse("001").success).toBe(false);
    expect(sourceIdSchema.safeParse("PANEL").success).toBe(false);
    expect(sourceIdSchema.safeParse("src_001-sim-panel").success).toBe(false);
    expect(gatewayIdSchema.safeParse("gateway_1").success).toBe(false);
  });

  it("reports a distinct stable code per identifier kind", () => {
    const cases = [
      [siteIdSchema, "id.site.invalid"],
      [sourceIdSchema, "id.source.invalid"],
      [gatewayIdSchema, "id.gateway.invalid"],
      [orgIdSchema, "id.org.invalid"],
      [readingIdSchema, "id.reading.invalid"],
    ] as const;

    for (const [schema, expectedCode] of cases) {
      const result = schema.safeParse("nope");
      expect(result.success).toBe(false);
      if (result.success) {
        continue;
      }
      const issues = formatIssues(result.error as RawError);
      expect(issues[0]?.code, expectedCode).toBe(expectedCode);
      expect(issues[0]?.message.length).toBeGreaterThan(0);
    }
  });
});
