import * as z from "zod";
import { recordIdSchema } from "./identifiers.js";
import { addIssue } from "./issue.js";

/**
 * The chain behind a derived record: which records it came from, and which rule
 * or model produced it. Required whenever `derivation` is not `direct` (rule
 * R5) — a provenance label that cannot be traced back is an assertion, not
 * provenance.
 */

export const RULE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
export const RULE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const lineageSchema = z.strictObject({
  rule: z.string().superRefine((value, ctx) => {
    if (!RULE_NAME_PATTERN.test(value)) {
      addIssue(ctx, "lineage.rule.invalid", "rule must be lower_snake_case");
    }
  }),
  ruleVersion: z.string().superRefine((value, ctx) => {
    if (!RULE_VERSION_PATTERN.test(value)) {
      addIssue(ctx, "lineage.rule_version.invalid", "ruleVersion must be major.minor.patch");
    }
  }),
  /**
   * Input order is preserved rather than required to be sorted: for some rules
   * the order of inputs is meaningful. Duplicates are rejected because the same
   * input contributing twice carries no additional information.
   */
  inputIds: z.array(recordIdSchema).superRefine((inputIds, ctx) => {
    if (inputIds.length === 0) {
      addIssue(ctx, "lineage.input_ids.empty", "lineage must reference at least one input record");
      return;
    }
    const seen = new Set<string>();
    for (const [index, id] of inputIds.entries()) {
      if (seen.has(id)) {
        addIssue(ctx, "lineage.input_ids.duplicate", `duplicate input id "${id}"`, [index]);
      }
      seen.add(id);
    }
  }),
});

export type Lineage = z.infer<typeof lineageSchema>;
