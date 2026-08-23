import { afterEach, describe, expect, it } from "vitest";
import { Outbox } from "../src/outbox.js";
import { type Harness, openHarness, reading, readings } from "./support/harness.js";

/**
 * Two handles on one outbox file.
 *
 * This is not hypothetical: a supervisor that restarts the gateway before the old
 * process has fully exited leaves two handles open on the same file for a moment,
 * and the crash-durability path already reads one file through two connections.
 *
 * What matters is that no durable decision is made from state cached in a handle's
 * memory. The sequence counter, the cursor, and the quarantine all live in the
 * database precisely so that a second handle cannot allocate a sequence the first
 * one has already used, or resend a range the first one has had acknowledged.
 *
 * True simultaneous contention is not exercised here — `better-sqlite3` is
 * synchronous, so two statements cannot overlap inside one test process. The
 * write-lock ordering that protects against it is asserted structurally in
 * `architecture.test.ts`; what is asserted here is that every read which informs a
 * write comes from disk.
 */

let harness: Harness | undefined;
const extra: Outbox[] = [];

afterEach(() => {
  for (const outbox of extra.splice(0)) {
    try {
      outbox.close();
    } catch {
      // Already closed.
    }
  }
  harness?.cleanup();
  harness = undefined;
});

/** A second, independent handle on the same file. */
function second(path: string, maxReadings = 10_000): Outbox {
  const outbox = Outbox.open({ path, maxReadings });
  extra.push(outbox);
  return outbox;
}

describe("a second handle never reuses a sequence", () => {
  it("allocates from the counter on disk, not from memory", () => {
    harness = openHarness();
    const other = second(harness.path);

    const first = harness.outbox.append(readings(3));
    const next = other.append(readings(2));

    expect(first).toMatchObject({ sequenceStart: 1, sequenceEnd: 3 });
    expect(next).toMatchObject({ sequenceStart: 4, sequenceEnd: 5 });
  });

  it("keeps allocating correctly when the two handles alternate", () => {
    harness = openHarness();
    const other = second(harness.path);
    const allocated: number[] = [];

    for (let round = 0; round < 6; round += 1) {
      const target = round % 2 === 0 ? harness.outbox : other;
      const result = target.append(readings(2));
      if (result.kind !== "appended") {
        throw new Error("append refused unexpectedly");
      }
      allocated.push(result.sequenceStart, result.sequenceEnd);
    }

    // Strictly increasing, no repeats, no gaps between consecutive ticks.
    expect(allocated).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(harness.outbox.counts().total).toBe(12);
    expect(other.counts().lastSequence).toBe(12);
  });

  it("refuses a reading id that the other handle already stored", () => {
    harness = openHarness();
    const other = second(harness.path);
    const shared = reading();

    expect(harness.outbox.append([shared]).kind).toBe("appended");
    // The UNIQUE index on reading_id is the backstop against two processes
    // committing the same observation under different sequences.
    expect(() => other.append([shared])).toThrow();
    expect(other.counts().total).toBe(1);
  });
});

describe("a second handle sees committed state, never a stale snapshot", () => {
  it("sees rows the other handle committed", () => {
    harness = openHarness();
    harness.outbox.append(readings(4));
    const other = second(harness.path);
    expect(other.readContiguousUnacked(10).map((row) => row.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("sees a cursor the other handle advanced", () => {
    harness = openHarness();
    const other = second(harness.path);
    harness.outbox.append(readings(4));

    other.acknowledgeThrough(2);

    // The first handle must not keep sending 1..2 because it remembers a cursor of
    // zero — that is a duplicate-delivery bug at best.
    expect(harness.outbox.ackedThrough()).toBe(2);
    expect(harness.outbox.readContiguousUnacked(10).map((row) => row.sequence)).toEqual([3, 4]);
  });

  it("sees a hold the other handle raised, and its release", () => {
    harness = openHarness();
    const other = second(harness.path);
    harness.outbox.append(readings(3));

    other.quarantine({
      fromSequence: 1,
      throughSequence: 3,
      kind: "permanent",
      reason: "422 unknown source",
    });
    expect(harness.outbox.activeQuarantine()).toMatchObject({ fromSequence: 1 });

    harness.outbox.releaseQuarantine({
      expectedFromSequence: 1,
      operator: "jpabs670",
      note: "source registered",
    });
    expect(other.activeQuarantine()).toBeUndefined();
  });

  it("does not double-release when both handles try", () => {
    harness = openHarness();
    const other = second(harness.path);
    harness.outbox.append(readings(2));
    harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 2,
      kind: "permanent",
      reason: "422",
    });

    const first = harness.outbox.releaseQuarantine({
      expectedFromSequence: 1,
      operator: "operator-a",
      note: "fixed upstream",
    });
    const race = other.releaseQuarantine({
      expectedFromSequence: 1,
      operator: "operator-b",
      note: "also fixed upstream",
    });

    expect(first.kind).toBe("released");
    expect(race.kind).toBe("none_active");
    // One incident, one release, one attributable author.
    expect(harness.outbox.quarantineHistory().length).toBe(1);
    expect(harness.outbox.quarantineHistory()[0]?.releasedBy).toBe("operator-a");
  });

  it("sees space reclaimed by the other handle", () => {
    harness = openHarness(6);
    const other = second(harness.path, 6);
    harness.outbox.append(readings(6));
    harness.outbox.acknowledgeThrough(6);

    // Reclamation happens inside the other handle's append.
    expect(other.append(readings(6))).toMatchObject({ kind: "appended", reclaimed: 6 });
    expect(harness.outbox.counts()).toMatchObject({ total: 6, unacked: 6, reclaimed: 6 });
  });
});
