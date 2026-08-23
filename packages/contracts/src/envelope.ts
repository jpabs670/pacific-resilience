import * as z from "zod";
import { type Derivation, type DerivedDerivation, derivationSchema } from "./derivation.js";
import {
  ContractValidationError,
  type ParseResult,
  type SafeParseOutcome,
  toParseResult,
} from "./errors.js";
import { readingIdSchema, siteIdSchema, sourceIdSchema } from "./identifiers.js";
import { addIssue } from "./issue.js";
import { type Lineage, lineageSchema } from "./lineage.js";
import { type MetricName, metricSchema, metricSpec } from "./metrics.js";
import { type Origin, originsSchema } from "./origin.js";
import { type QualityFlag, qualitySchema } from "./quality.js";
import { type Sample, sampleSchema } from "./sample.js";
import { timestampSchema } from "./time.js";

export const SCHEMA_VERSION = 1 as const;

const envelopeObject = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  readingId: readingIdSchema,
  siteId: siteIdSchema,
  sourceId: sourceIdSchema,
  metric: metricSchema,
  capturedAt: timestampSchema,
  sample: sampleSchema,
  origins: originsSchema,
  derivation: derivationSchema,
  lineage: lineageSchema.optional(),
  quality: qualitySchema.optional(),
});

/**
 * Cross-field rules that a per-field schema cannot express.
 *
 * Runs only when every field already parsed, so an unregistered metric is
 * reported once by `metricSchema` rather than twice.
 */
export const telemetryEnvelopeSchema = envelopeObject.superRefine((envelope, ctx) => {
  if (envelope.derivation === "direct") {
    if (envelope.lineage !== undefined) {
      addIssue(
        ctx,
        "lineage.forbidden",
        'lineage is forbidden when derivation is "direct": a direct observation has no chain',
        ["lineage"],
      );
    }
  } else if (envelope.lineage === undefined) {
    addIssue(
      ctx,
      "lineage.required",
      `lineage is required when derivation is "${envelope.derivation}"`,
      ["lineage"],
    );
  }

  const spec = metricSpec(envelope.metric);
  if (spec === undefined) {
    return;
  }

  if (spec.kind !== envelope.sample.kind) {
    addIssue(
      ctx,
      "sample.kind.mismatch",
      `metric "${envelope.metric}" expects a ${spec.kind} sample, received ${envelope.sample.kind}`,
      ["sample", "kind"],
    );
    return;
  }

  if (spec.kind === "numeric" && envelope.sample.kind === "numeric") {
    if (envelope.sample.unit !== spec.unit) {
      addIssue(
        ctx,
        "unit.mismatch",
        `metric "${envelope.metric}" is recorded in ${spec.unit}, received ${envelope.sample.unit}; units are never converted`,
        ["sample", "unit"],
      );
    }
    return;
  }

  if (spec.kind === "state" && envelope.sample.kind === "state") {
    if (envelope.sample.domain !== spec.domain) {
      addIssue(
        ctx,
        "state.domain.mismatch",
        `metric "${envelope.metric}" belongs to domain ${spec.domain}, received ${envelope.sample.domain}`,
        ["sample", "domain"],
      );
      return;
    }
    if (!spec.values.includes(envelope.sample.state)) {
      addIssue(
        ctx,
        "state.value.unknown",
        `"${envelope.sample.state}" is not in domain ${spec.domain} (${spec.values.join(", ")})`,
        ["sample", "state"],
      );
    }
  }
});

type EnvelopeCore = {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly readingId: string;
  readonly siteId: string;
  readonly sourceId: string;
  readonly metric: MetricName;
  readonly capturedAt: string;
  readonly sample: Sample;
  readonly origins: readonly Origin[];
  readonly quality?: readonly QualityFlag[];
};

/**
 * The lineage rule is expressed in the type as well as at runtime: a `direct`
 * envelope has nowhere to put lineage, and a derived one cannot omit it. The two
 * branches are exported separately so consumers can name them and so the rule is
 * assertable at compile time (see test/types.test.ts).
 */
export type DirectEnvelope = EnvelopeCore & {
  readonly derivation: "direct";
  readonly lineage?: never;
};

export type DerivedEnvelope = EnvelopeCore & {
  readonly derivation: DerivedDerivation;
  readonly lineage: Lineage;
};

export type TelemetryEnvelope = DirectEnvelope | DerivedEnvelope;

export function safeParseTelemetryEnvelope(input: unknown): ParseResult<TelemetryEnvelope> {
  return toParseResult<TelemetryEnvelope>(
    telemetryEnvelopeSchema.safeParse(input) as SafeParseOutcome,
  );
}

export function parseTelemetryEnvelope(input: unknown): TelemetryEnvelope {
  const result = safeParseTelemetryEnvelope(input);
  if (!result.ok) {
    throw new ContractValidationError(result.issues);
  }
  return result.value;
}

export function isDerived(envelope: TelemetryEnvelope): envelope is DerivedEnvelope {
  const derivation: Derivation = envelope.derivation;
  return derivation !== "direct";
}
