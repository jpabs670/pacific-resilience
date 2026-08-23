import * as z from "zod";
import { addIssue } from "./issue.js";

/**
 * Identifier validation.
 *
 * This package **validates** identifiers and never generates them. Reading IDs
 * are assigned by the component that creates the reading; event IDs are derived
 * where events are derived. See docs/architecture/telemetry-envelope-v1.md.
 */

/**
 * Canonical lowercase RFC 4122 form, versions 1-8, variant 8/9/a/b.
 *
 * Lowercase is required so that one identifier has exactly one wire form, which
 * is what makes payload digests comparable. The nil and max UUIDs are excluded
 * by the version and variant classes.
 */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const ORG_ID_PATTERN = /^org_[a-z0-9_]{1,56}$/;
export const SITE_ID_PATTERN = /^site_[0-9]{3,12}$/;
export const SOURCE_ID_PATTERN = /^src_[a-z0-9_]{1,56}$/;
export const GATEWAY_ID_PATTERN = /^gw_[a-z0-9_]{1,56}$/;

function patternSchema(pattern: RegExp, code: string, description: string) {
  return z.string().superRefine((value, ctx) => {
    if (!pattern.test(value)) {
      addIssue(ctx, code, `${description} (expected ${String(pattern)})`);
    }
  });
}

export const orgIdSchema = patternSchema(ORG_ID_PATTERN, "id.org.invalid", "malformed org id");
export const siteIdSchema = patternSchema(SITE_ID_PATTERN, "id.site.invalid", "malformed site id");
export const sourceIdSchema = patternSchema(
  SOURCE_ID_PATTERN,
  "id.source.invalid",
  "malformed source id",
);
export const gatewayIdSchema = patternSchema(
  GATEWAY_ID_PATTERN,
  "id.gateway.invalid",
  "malformed gateway id",
);

/** A reading's opaque UUID, assigned once at creation and never derived here. */
export const readingIdSchema = patternSchema(
  UUID_PATTERN,
  "id.reading.invalid",
  "readingId must be a canonical lowercase UUID",
);

/** A reading or event id referenced by lineage. */
export const recordIdSchema = patternSchema(
  UUID_PATTERN,
  "id.record.invalid",
  "record id must be a canonical lowercase UUID",
);

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
