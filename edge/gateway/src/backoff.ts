/**
 * Bounded exponential backoff with full jitter.
 *
 * Jitter is not decoration: once several gateways share a site, a utility
 * restoration reconnects them at the same instant, and unjittered backoff would
 * synchronise their retries into a thundering herd against the ingest endpoint.
 *
 * The randomness source is injectable so tests are deterministic.
 */

export type BackoffOptions = {
  readonly initialMs: number;
  readonly ceilingMs: number;
  /** Returns [0, 1). Defaults to `Math.random`. */
  readonly random?: () => number;
};

export const DEFAULT_BACKOFF: { readonly initialMs: number; readonly ceilingMs: number } = {
  initialMs: 1_000,
  ceilingMs: 300_000,
};

/**
 * Delay before retry `attempt` (1-based).
 *
 * Full jitter: the base doubles per attempt up to the ceiling, and the delay is
 * drawn uniformly from (0, base]. A retry therefore never waits longer than the
 * ceiling, which is what makes the backoff bounded rather than merely slow.
 */
export function nextDelayMs(attempt: number, options: BackoffOptions): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error("attempt must be an integer >= 1");
  }
  if (options.initialMs <= 0 || options.ceilingMs < options.initialMs) {
    throw new Error("backoff requires 0 < initialMs <= ceilingMs");
  }

  const random = options.random ?? Math.random;
  // Cap the exponent before multiplying so a long outage cannot overflow.
  const doublings = Math.min(attempt - 1, 32);
  const base = Math.min(options.initialMs * 2 ** doublings, options.ceilingMs);
  const jittered = Math.ceil(base * (1 - random()));
  return Math.min(Math.max(jittered, 1), options.ceilingMs);
}
