/**
 * Deterministic pseudo-random source.
 *
 * The simulator must be replayable byte-for-byte: an outage scenario that cannot
 * be reproduced cannot be used to debug the detector that consumes it. `Math.random`
 * is therefore never used anywhere in this package, and the only entropy is the
 * caller's seed.
 *
 * mulberry32 — small, fast, and adequate for jitter. Not for cryptography.
 */
export type Random = () => number;

export function createRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Uniform value in [centre - spread, centre + spread]. */
export function jitter(random: Random, centre: number, spread: number): number {
  return centre + (random() * 2 - 1) * spread;
}

/** Round to a fixed number of decimals so emitted values are stable strings. */
export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
