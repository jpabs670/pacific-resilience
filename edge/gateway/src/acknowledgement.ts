import {
  type BatchAck,
  type ContractIssue,
  safeParseBatchAckForRange,
} from "@pacific-resilience/contracts";

/**
 * Gateway-side adapter over the acknowledgement contract.
 *
 * The rules themselves live in `@pacific-resilience/contracts`, beside the batch
 * schema they are relative to, so the gateway that verifies an acknowledgement and
 * the ingest API that constructs one cannot drift apart. What belongs here is the
 * decision the gateway makes about a bad one, and a diagnostic an operator can
 * read without reproducing the exchange.
 */

export type AckValidation =
  | { readonly kind: "valid"; readonly ackedThrough: number }
  | {
      readonly kind: "invalid";
      readonly reason: string;
      /** Machine-readable codes, for metrics that count violations by cause. */
      readonly codes: readonly string[];
      readonly issues: readonly ContractIssue[];
    };

/**
 * Every issue is reported, not just the first.
 *
 * A server that gets one field wrong has usually got the neighbouring one wrong
 * too, and an operator diagnosing a peer wants the whole picture from one log line
 * rather than one refusal per deployment.
 */
function describe(issues: readonly ContractIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

export function validateAck(
  ack: BatchAck,
  sequenceStart: number,
  sequenceEnd: number,
): AckValidation {
  const result = safeParseBatchAckForRange(ack, { sequenceStart, sequenceEnd });
  if (result.ok) {
    return { kind: "valid", ackedThrough: result.value.ackedThrough };
  }
  return {
    kind: "invalid",
    reason: describe(result.issues),
    codes: result.issues.map((issue) => issue.code),
    issues: result.issues,
  };
}
