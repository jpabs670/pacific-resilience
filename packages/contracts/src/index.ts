/**
 * `@pacific-resilience/contracts` — boundary schemas for the platform.
 *
 * Constraints on this package, enforced by `test/architecture.test.ts`:
 *
 * - No filesystem, database, network, or environment access.
 * - No imports from `apps/` or `edge/`.
 * - No identifier generation. Reading IDs are assigned by the component that
 *   creates the reading; this package only validates them.
 * - No default origin and no default derivation, anywhere.
 *
 * See docs/architecture/telemetry-envelope-v1.md and
 * docs/architecture/data-provenance.md.
 */

export {
  type BatchAck,
  batchAckSchema,
  batchAckSchemaForRange,
  parseBatchAck,
  parseBatchAckForRange,
  type SequenceRange,
  safeParseBatchAck,
  safeParseBatchAckForRange,
} from "./ack.js";
export {
  MAX_BATCH_READINGS,
  parseTelemetryBatch,
  safeParseTelemetryBatch,
  type TelemetryBatch,
  telemetryBatchSchema,
} from "./batch.js";
export {
  DERIVATIONS,
  type Derivation,
  type DerivedDerivation,
  derivationSchema,
  requiresLineage,
} from "./derivation.js";
export {
  type DerivedEnvelope,
  type DirectEnvelope,
  isDerived,
  parseTelemetryEnvelope,
  SCHEMA_VERSION,
  safeParseTelemetryEnvelope,
  type TelemetryEnvelope,
  telemetryEnvelopeSchema,
} from "./envelope.js";
export {
  type ContractIssue,
  ContractValidationError,
  formatIssues,
  formatPath,
  type ParseResult,
  type RawError,
  type RawIssue,
  type SafeParseOutcome,
  toParseResult,
} from "./errors.js";
export {
  GATEWAY_ID_PATTERN,
  gatewayIdSchema,
  isUuid,
  ORG_ID_PATTERN,
  orgIdSchema,
  readingIdSchema,
  recordIdSchema,
  SITE_ID_PATTERN,
  SOURCE_ID_PATTERN,
  siteIdSchema,
  sourceIdSchema,
  UUID_PATTERN,
} from "./identifiers.js";
export {
  type Lineage,
  lineageSchema,
  RULE_NAME_PATTERN,
  RULE_VERSION_PATTERN,
} from "./lineage.js";
export {
  isMetricName,
  isOutOfRange,
  METRIC_NAMES,
  type MetricName,
  type MetricSpec,
  metricSchema,
  metricSpec,
  type NumericMetricSpec,
  STATE_DOMAINS,
  type StateDomain,
  type StateMetricSpec,
} from "./metrics.js";
export {
  normalizeOrigins,
  ORIGINS,
  type Origin,
  originOrder,
  originSchema,
  originsSchema,
  unionOrigins,
} from "./origin.js";
export {
  QUALITY_FLAGS,
  type QualityFlag,
  qualityFlagSchema,
  qualitySchema,
} from "./quality.js";
export {
  type NumericSample,
  numericSampleSchema,
  type Sample,
  type StateSample,
  sampleSchema,
  stateSampleSchema,
} from "./sample.js";
export {
  RFC3339_UTC_MS_PATTERN,
  type TimestampProblem,
  timestampProblem,
  timestampSchema,
  toEpochMs,
} from "./time.js";
export { isUnit, UNITS, type Unit, unitSchema } from "./units.js";
