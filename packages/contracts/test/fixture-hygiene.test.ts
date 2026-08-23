import { describe, expect, it } from "vitest";
import {
  allFixtureFiles,
  collectValues,
  loadInvalid,
  loadValid,
  RESERVED_FIXTURE_UUID_PREFIX,
} from "./support/fixtures.js";

/**
 * Fixtures are synthetic. No capture from Site 001 or any real site may enter
 * this repository, in any form, including "anonymized" — a single named site
 * cannot be anonymized. See docs/security/data-classification.md, rule D-1.
 */

const files = allFixtureFiles();
const fixtures = [
  ...loadValid("envelope"),
  ...loadInvalid("envelope"),
  ...loadValid("batch"),
  ...loadInvalid("batch"),
];

/**
 * Any UUID-shaped token, including deliberately invalid ones such as the nil
 * UUID: their hex and digit runs are structural, not personal.
 */
const UUID_SHAPED = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

/**
 * Deliberately looser than the canonical timestamp pattern: several invalid
 * fixtures carry malformed timestamps on purpose, and those are still structural
 * date text rather than anything personal.
 */
const DATE_LIKE_ANYWHERE = /\d{4}-\d{2}-\d{2}(?:T[\d:.]*(?:[Zz]|[+-]\d{2}:?\d{2})?)?/g;

describe("fixture corpus", () => {
  it("is discoverable and non-trivial", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
    expect(fixtures.length).toBe(files.length);
  });

  it("declares an intent for every fixture", () => {
    for (const fixture of fixtures) {
      expect(fixture.intent.length, fixture.name).toBeGreaterThan(10);
    }
  });
});

describe("fixtures contain no personal or site-identifying data", () => {
  for (const file of files) {
    it(`is clean: ${file.relativePath}`, () => {
      // Identifiers and timestamps are stripped first: their digit runs are
      // structural and would otherwise false-positive against the patterns below.
      const text = file.text
        .replace(UUID_SHAPED, "<uuid>")
        .replace(DATE_LIKE_ANYWHERE, "<timestamp>");

      const patterns: readonly (readonly [string, RegExp])[] = [
        ["email address", /[\w.+-]+@[\w-]+\.[a-z]{2,}/i],
        ["telephone number", /(?:\+?\d[\d ()-]{8,}\d)/],
        [
          "street address",
          /\d+\s+[A-Za-z]+\s+(?:street|st|road|rd|avenue|ave|drive|dr|lane|ln)\b/i,
        ],
        ["geographic coordinate", /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/],
        ["long digit run (account or serial number)", /\d{9,}/],
        ["unverified vendor claim", /\b(anker|solix)\b/i],
      ];

      for (const [label, pattern] of patterns) {
        const match = text.match(pattern);
        expect(match, `${file.relativePath} contains a ${label}: ${match?.[0] ?? ""}`).toBeNull();
      }
    });
  }
});

describe("fixture identifiers are drawn from the reserved synthetic block", () => {
  it("uses only reserved UUIDs, so a fixture id can never collide with a runtime one", () => {
    for (const file of files) {
      for (const uuid of file.text.match(UUID_SHAPED) ?? []) {
        const reserved = uuid.toLowerCase().startsWith(RESERVED_FIXTURE_UUID_PREFIX);
        const deliberatelyInvalid = file.relativePath.includes("/invalid/");
        expect(reserved || deliberatelyInvalid, `${file.relativePath}: ${uuid}`).toBe(true);
      }
    }
  });

  it("uses only site_001 or the reserved site_000 in records meant to be accepted", () => {
    // Invalid fixtures carry malformed identifiers on purpose, so asserting they
    // are well formed would contradict what they exist to prove.
    for (const fixture of [...loadValid("envelope"), ...loadValid("batch")]) {
      for (const siteId of collectValues(fixture.value, "siteId")) {
        expect(["site_001", "site_000"], fixture.name).toContain(siteId);
      }
    }
  });
});

describe("no fixture record claims real measurement", () => {
  it("carries no measured origin anywhere in the corpus", () => {
    // Nothing at Site 001 is verified, so no stored record may claim `measured`.
    // The origin remains valid vocabulary — proven in provenance.test.ts, which
    // exercises the schema rather than storing a record.
    for (const fixture of fixtures) {
      for (const origins of collectValues(fixture.value, "origins")) {
        if (!Array.isArray(origins)) {
          continue;
        }
        expect(origins, `${fixture.name} claims a measured origin`).not.toContain("measured");
      }
    }
  });
});
