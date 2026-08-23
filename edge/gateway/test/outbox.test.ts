import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway.js";
import { OUTBOX_PRAGMAS, Outbox } from "../src/outbox.js";
import { type Harness, inspecting, openHarness, reading, readings } from "./support/harness.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

/** Row count as seen by an independent connection — i.e. actually committed. */
function committedRows(path: string): number {
  const probe = new Database(path, { readonly: true });
  try {
    return (probe.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
  } finally {
    probe.close();
  }
}

describe("every reading is persisted before transmission", () => {
  it("has already committed the batch when the transport is called", async () => {
    harness = openHarness();
    const path = harness.path;
    let committedAtSendTime = -1;

    const transport = inspecting((batch) => {
      // Read through a second connection: this can only see data that the writing
      // transaction has committed to disk.
      committedAtSendTime = committedRows(path);
      expect(batch.readings.length).toBe(7);
    });

    harness.outbox.append(readings(7));
    expect(committedRows(path)).toBe(7);

    const gateway = new Gateway({ outbox: harness.outbox, transport, gatewayId: "gw_001_1" });
    const result = await gateway.flushOnce();

    expect(result.kind).toBe("flushed");
    expect(committedAtSendTime).toBe(7);
  });

  it("commits each tick before the next one is offered", () => {
    harness = openHarness();
    for (let tick = 1; tick <= 4; tick += 1) {
      harness.outbox.append(readings(7));
      expect(committedRows(harness.path)).toBe(tick * 7);
    }
  });

  it("refuses to be backed by an in-memory database", () => {
    // Durability is the whole purpose, so `:memory:` is not a valid outbox.
    expect(() => Outbox.open({ path: ":memory:", maxReadings: 10 })).toThrow(/durability/);
    expect(() => Outbox.open({ path: "   ", maxReadings: 10 })).toThrow(/durability/);
  });
});

describe("sequence allocation is monotonic and gap-free", () => {
  it("numbers readings consecutively across appends", () => {
    harness = openHarness();
    const first = harness.outbox.append(readings(3));
    const second = harness.outbox.append(readings(2));

    expect(first).toMatchObject({ kind: "appended", sequenceStart: 1, sequenceEnd: 3 });
    expect(second).toMatchObject({ kind: "appended", sequenceStart: 4, sequenceEnd: 5 });

    const rows = harness.outbox.readContiguousUnacked(100);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it("never reuses a sequence after acknowledged rows are pruned", () => {
    harness = openHarness();
    harness.outbox.append(readings(3));
    harness.outbox.acknowledgeThrough(3);
    expect(harness.outbox.prune(3)).toBe(3);
    expect(harness.outbox.counts().total).toBe(0);

    // A MAX(sequence) allocator would restart at 1 here and collide with pruned
    // history; the counter in `meta` is what prevents that.
    const next = harness.outbox.append(readings(1));
    expect(next).toMatchObject({ kind: "appended", sequenceStart: 4, sequenceEnd: 4 });
  });

  it("survives a restart without restarting the counter", () => {
    harness = openHarness();
    harness.outbox.append(readings(2));
    const reopened = harness.reopen();
    expect(reopened.append(readings(1))).toMatchObject({ sequenceStart: 3, sequenceEnd: 3 });
  });

  it("rejects an empty append rather than allocating nothing", () => {
    harness = openHarness();
    expect(() => harness?.outbox.append([])).toThrow(/at least one reading/);
  });

  it("refuses to store a reading the boundary schema would reject", () => {
    harness = openHarness();
    const invalid = { ...reading(), origins: [] };
    expect(() => harness?.outbox.append([invalid as never])).toThrow();
    expect(harness.outbox.counts().total).toBe(0);
  });
});

describe("restarting preserves unacknowledged readings", () => {
  it("keeps every unacknowledged reading, id and sequence intact", () => {
    harness = openHarness();
    harness.outbox.append(readings(5));
    const before = harness.outbox.readContiguousUnacked(10);
    expect(before.length).toBe(5);

    // The handle is abandoned without close(), as it would be if the process died.
    const reopened = harness.reopenAfterAbandon();
    const after = reopened.readContiguousUnacked(10);

    expect(after.map((row) => row.sequence)).toEqual(before.map((row) => row.sequence));
    expect(after.map((row) => row.readingId)).toEqual(before.map((row) => row.readingId));
    expect(JSON.stringify(after.map((row) => row.envelope))).toBe(
      JSON.stringify(before.map((row) => row.envelope)),
    );
  });

  it("keeps the acknowledgement cursor across a restart", () => {
    harness = openHarness();
    harness.outbox.append(readings(4));
    harness.outbox.acknowledgeThrough(2);

    const reopened = harness.reopenAfterAbandon();
    expect(reopened.ackedThrough()).toBe(2);
    expect(reopened.readContiguousUnacked(10).map((row) => row.sequence)).toEqual([3, 4]);
  });

  it("keeps a quarantine, its cause and its age across a restart", () => {
    harness = openHarness();
    harness.outbox.append(readings(2));
    harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 2,
      kind: "permanent",
      reason: "422 unknown source",
    });

    const reopened = harness.reopenAfterAbandon();
    expect(reopened.quarantinedFrom()).toBe(1);

    // A restart must not erase why the hold exists, or how long it has stood. An
    // operator who restarts the gateway to "clear" a problem would otherwise lose
    // the only record of it.
    expect(reopened.activeQuarantine()).toMatchObject({
      fromSequence: 1,
      throughSequence: 2,
      kind: "permanent",
      reason: "422 unknown source",
    });
    expect(reopened.quarantineStatus()).toMatchObject({ raisedTotal: 1, releasedTotal: 0 });
  });

  it("keeps a release and its audit trail across a restart", () => {
    harness = openHarness();
    harness.outbox.append(readings(2));
    harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 2,
      kind: "protocol_violation",
      reason: "ackedThrough 9 is outside the transmitted range 1..2",
    });
    harness.outbox.releaseQuarantine({
      expectedFromSequence: 1,
      operator: "jpabs670",
      note: "ingest deployed with the sequence fix",
    });

    const reopened = harness.reopenAfterAbandon();
    expect(reopened.activeQuarantine()).toBeUndefined();
    expect(reopened.quarantinedFrom()).toBe(0);
    expect(reopened.quarantineHistory()[0]).toMatchObject({
      kind: "protocol_violation",
      releasedBy: "jpabs670",
      releaseNote: "ingest deployed with the sequence fix",
    });
  });
});

describe("a full outbox refuses new readings without deleting old data", () => {
  it("refuses the tick, counts the drop, and keeps every stored reading", () => {
    harness = openHarness(10);
    const first = harness.outbox.append(readings(7));
    expect(first.kind).toBe("appended");

    const oldestBefore = harness.outbox.readContiguousUnacked(100);
    const refused = harness.outbox.append(readings(7));

    expect(refused).toMatchObject({ kind: "refused", reason: "at_capacity", refused: 7 });
    expect(harness.outbox.counts().total).toBe(7);
    expect(harness.outbox.counts().dropped).toBe(7);

    // The oldest unsent readings are the outage itself. They must survive.
    const oldestAfter = harness.outbox.readContiguousUnacked(100);
    expect(oldestAfter.map((row) => row.readingId)).toEqual(
      oldestBefore.map((row) => row.readingId),
    );
  });

  it("accumulates the drop count while every stored reading is still unsent", () => {
    harness = openHarness(8);
    harness.outbox.append(readings(8));
    harness.outbox.append(readings(1));
    harness.outbox.append(readings(1));
    expect(harness.outbox.counts()).toMatchObject({ total: 8, dropped: 2, reclaimed: 0 });

    // Nothing was acknowledged, so there was nothing reclaimable to find.
    harness.outbox.acknowledgeThrough(8);
    expect(harness.outbox.prune(8)).toBe(8);
    expect(harness.outbox.append(readings(1)).kind).toBe("appended");
  });

  it("accepts a tick that exactly fills the outbox", () => {
    harness = openHarness(7);
    expect(harness.outbox.append(readings(7)).kind).toBe("appended");
    expect(harness.outbox.append(readings(1)).kind).toBe("refused");
  });
});

describe("capacity is reclaimed from delivered readings, never from unsent ones", () => {
  it("reclaims acknowledged rows rather than refusing a new tick", () => {
    harness = openHarness(10);
    harness.outbox.append(readings(10));
    harness.outbox.acknowledgeThrough(10);

    // Nothing else in the system prunes, so without this a healthy gateway would
    // fill with delivered rows and then refuse every new observation.
    const result = harness.outbox.append(readings(7));

    expect(result).toMatchObject({ kind: "appended", sequenceStart: 11, reclaimed: 10 });
    expect(harness.outbox.counts()).toMatchObject({
      total: 7,
      unacked: 7,
      dropped: 0,
      reclaimed: 10,
    });
  });

  it("reclaims only the acknowledged prefix and keeps the unsent tail", () => {
    harness = openHarness(10);
    harness.outbox.append(readings(10));
    harness.outbox.acknowledgeThrough(4);
    const unsentBefore = harness.outbox.readContiguousUnacked(100).map((row) => row.readingId);

    const result = harness.outbox.append(readings(4));

    expect(result).toMatchObject({ kind: "appended", reclaimed: 4 });
    // The six unacknowledged readings are byte-identical and still in order.
    expect(
      harness.outbox
        .readContiguousUnacked(100)
        .map((row) => row.readingId)
        .slice(0, 6),
    ).toEqual(unsentBefore);
  });

  it("refuses rather than deleting an unsent reading when nothing is reclaimable", () => {
    harness = openHarness(10);
    harness.outbox.append(readings(10));
    const before = harness.outbox.readContiguousUnacked(100).map((row) => row.readingId);

    const result = harness.outbox.append(readings(1));

    expect(result).toMatchObject({ kind: "refused", reason: "at_capacity", reclaimed: 0 });
    expect(harness.outbox.readContiguousUnacked(100).map((row) => row.readingId)).toEqual(before);
  });

  it("reclaims only as far as the cursor, even with a partial acknowledgement", () => {
    harness = openHarness(6);
    harness.outbox.append(readings(6));
    harness.outbox.acknowledgeThrough(2);

    // Two rows freed is not enough for a tick of three, so the tick is refused —
    // and the four unsent rows are still untouched.
    const result = harness.outbox.append(readings(3));
    expect(result).toMatchObject({ kind: "refused", reclaimed: 2 });
    expect(harness.outbox.counts()).toMatchObject({ total: 4, unacked: 4, reclaimed: 2 });
  });

  it("never lets reclamation reuse a sequence", () => {
    harness = openHarness(5);
    harness.outbox.append(readings(5));
    harness.outbox.acknowledgeThrough(5);
    const next = harness.outbox.append(readings(5));

    expect(next).toMatchObject({ kind: "appended", sequenceStart: 6, sequenceEnd: 10 });
    expect(harness.outbox.counts().lastSequence).toBe(10);
  });
});

describe("pruning only ever removes acknowledged rows", () => {
  it("leaves unacknowledged rows alone even when asked to remove them", () => {
    harness = openHarness();
    harness.outbox.append(readings(6));
    harness.outbox.acknowledgeThrough(2);

    expect(harness.outbox.prune(6)).toBe(2);
    expect(harness.outbox.readContiguousUnacked(10).map((row) => row.sequence)).toEqual([
      3, 4, 5, 6,
    ]);
  });
});

describe("durability configuration", () => {
  it("applies the PRAGMAs ADR 0003 specifies", () => {
    harness = openHarness();
    const probe = new Database(harness.path, { readonly: true });
    try {
      expect(String(probe.pragma("journal_mode", { simple: true })).toLowerCase()).toBe("wal");
    } finally {
      probe.close();
    }
    // synchronous is per-connection, so assert the declared configuration itself is
    // the one the class applies.
    expect([...OUTBOX_PRAGMAS]).toEqual([
      "journal_mode = WAL",
      "synchronous = FULL",
      "busy_timeout = 5000",
      "foreign_keys = ON",
    ]);
  });
});
