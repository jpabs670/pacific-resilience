/**
 * Minimal structural view of zod's refinement context.
 *
 * Declared structurally rather than imported so that every domain rule in this
 * package reports a stable `params.code`, independent of zod's own issue codes.
 */
export type RefinementSink = {
  addIssue: (issue: {
    code: "custom";
    message: string;
    path?: (string | number)[];
    params?: Record<string, unknown>;
  }) => void;
};

/**
 * Record a domain-rule violation with a stable machine-readable code.
 *
 * `code` is part of the contract and must not change without a schema version
 * bump; `message` is for humans and may change freely.
 */
export function addIssue(
  sink: RefinementSink,
  code: string,
  message: string,
  path?: readonly (string | number)[],
): void {
  if (path === undefined) {
    sink.addIssue({ code: "custom", message, params: { code } });
    return;
  }
  sink.addIssue({ code: "custom", message, path: [...path], params: { code } });
}
