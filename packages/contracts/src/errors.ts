/**
 * Structured validation errors: `{ index, path, code, message }`.
 *
 * `code` is stable and machine-readable and may not change without a schema
 * version bump. `message` is for humans and may change freely.
 *
 * Issue shapes are described structurally rather than imported from zod, so the
 * error contract does not move when the validation library does.
 */

export type RawIssue = {
  readonly code?: string | undefined;
  readonly path: readonly PropertyKey[];
  readonly message: string;
  /** Domain rules carry their stable code here; see src/issue.ts. */
  readonly params?: { readonly code?: string | undefined } | undefined;
};

export type RawError = { readonly issues: readonly RawIssue[] };

export type ContractIssue = {
  /** Index within `readings` when the failure is inside a batch. */
  readonly index?: number;
  /** Dotted/bracketed path, for example `readings[3].sample.unit`. */
  readonly path: string;
  readonly segments: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
};

/** Generic codes for structural failures that are not domain-rule violations. */
const STRUCTURAL_CODES: ReadonlyMap<string, string> = new Map([
  ["invalid_type", "type.invalid"],
  ["invalid_value", "value.invalid"],
  ["invalid_format", "format.invalid"],
  ["invalid_union", "union.invalid"],
  ["unrecognized_keys", "object.unknown_key"],
  ["too_small", "size.too_small"],
  ["too_big", "size.too_big"],
  ["not_multiple_of", "value.invalid"],
  ["invalid_key", "object.invalid_key"],
  ["invalid_element", "array.invalid_element"],
]);

function usableSegments(path: readonly PropertyKey[]): (string | number)[] {
  const segments: (string | number)[] = [];
  for (const segment of path) {
    if (typeof segment === "string" || typeof segment === "number") {
      segments.push(segment);
    }
  }
  return segments;
}

export function formatPath(segments: readonly (string | number)[]): string {
  let path = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      path += `[${segment}]`;
    } else if (path === "") {
      path = segment;
    } else {
      path += `.${segment}`;
    }
  }
  return path === "" ? "<root>" : path;
}

function stableCode(issue: RawIssue): string {
  const declared = issue.params?.code;
  if (typeof declared === "string") {
    return declared;
  }
  if (issue.code === undefined) {
    return "invalid";
  }
  return STRUCTURAL_CODES.get(issue.code) ?? issue.code;
}

/** Index of the offending reading when the path enters `readings`. */
function readingIndex(segments: readonly (string | number)[]): number | undefined {
  const [head, next] = segments;
  if (head === "readings" && typeof next === "number") {
    return next;
  }
  return undefined;
}

export function formatIssues(error: RawError): ContractIssue[] {
  return error.issues.map((issue) => {
    const segments = usableSegments(issue.path);
    const index = readingIndex(segments);
    const base = {
      path: formatPath(segments),
      segments,
      code: stableCode(issue),
      message: issue.message,
    };
    return index === undefined ? base : { index, ...base };
  });
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ContractIssue[] };

export type SafeParseOutcome =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: RawError };

/** Convert a validator outcome into a `ParseResult`, narrowing to the strict type. */
export function toParseResult<T>(outcome: SafeParseOutcome): ParseResult<T> {
  if (outcome.success) {
    // Justified by the schema's refinements, which are stricter than the
    // inferred type: see the lineage and metric/sample rules in envelope.ts.
    return { ok: true, value: outcome.data as T };
  }
  return { ok: false, issues: formatIssues(outcome.error) };
}

export class ContractValidationError extends Error {
  readonly issues: readonly ContractIssue[];

  constructor(issues: readonly ContractIssue[]) {
    const summary = issues.map((issue) => `${issue.path}: ${issue.code}`).join("; ");
    super(`contract validation failed — ${summary}`);
    this.name = "ContractValidationError";
    this.issues = issues;
  }
}
