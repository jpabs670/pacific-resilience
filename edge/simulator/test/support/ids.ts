/**
 * Pinned reading-ID factory for tests.
 *
 * Production reading ids come from `crypto.randomUUID`, deliberately: identity
 * must not be computable from content. Tests that need byte-identical output
 * therefore pin the factory rather than seeding it, drawing from the same reserved
 * synthetic block the contracts fixtures use.
 */
export const RESERVED_FIXTURE_UUID_PREFIX = "00000000-0000-4000-8000-";

export function pinnedIdFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${RESERVED_FIXTURE_UUID_PREFIX}${String(counter).padStart(12, "0")}`;
  };
}
