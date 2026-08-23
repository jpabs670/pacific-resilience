import { afterEach, describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway.js";
import {
  acceptAll,
  acceptWithAck,
  alwaysPermanent,
  type Harness,
  openHarness,
  readings,
} from "./support/harness.js";

/**
 * Quarantine as a lifecycle, not a flag.
 *
 * A hold exists so that a range which cannot be delivered stops being resent while
 * staying visible and intact. That is only half a design: a hold nothing can lift
 * is a gateway that stops shipping data permanently on its first bad day. The other
 * half is a release that is deliberate, attributable, and incapable of losing data —
 * it lifts the hold so the *same* readings are retried, and there is no operation
 * anywhere that advances the cursor past a held range.
 */

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

/** A clock the test drives, so age assertions are exact rather than timing-dependent. */
function clock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe("raising a hold records the cause, not just the fact", () => {
  it("records the range, kind, reason and time of a permanent rejection", async () => {
    const time = clock(1_700_000_000_000);
    harness = openHarness(10_000, time.now);
    harness.outbox.append(readings(3));

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: alwaysPermanent("422 unknown source src_001_sim_panel"),
      gatewayId: "gw_001_1",
    });

    const result = await gateway.flushOnce();
    expect(result).toMatchObject({
      kind: "quarantined",
      sequenceStart: 1,
      sequenceEnd: 3,
      reason: "422 unknown source src_001_sim_panel",
      hold: {
        fromSequence: 1,
        throughSequence: 3,
        kind: "permanent",
        reason: "422 unknown source src_001_sim_panel",
        raisedAt: 1_700_000_000_000,
        ageMs: 0,
      },
    });
  });

  it("records a protocol violation with its contract codes", async () => {
    harness = openHarness();
    harness.outbox.append(readings(3));

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: acceptWithAck(() => ({
        ackedThrough: 99,
        received: 99,
        inserted: 99,
        duplicate: 0,
      })),
      gatewayId: "gw_001_1",
    });

    const result = await gateway.flushOnce();
    expect(result.kind).toBe("protocol_violation");
    if (result.kind !== "protocol_violation") {
      return;
    }
    expect(result.codes).toContain("ack.acked_through.out_of_range");
    expect(result.hold.kind).toBe("protocol_violation");
    // The recorded reason is the diagnostic, so the log line and the stored hold
    // say the same thing.
    expect(result.hold.reason).toBe(result.reason);
  });

  it("reports the original cause on every later cycle, and ages it", async () => {
    const time = clock(1_000);
    harness = openHarness(10_000, time.now);
    harness.outbox.append(readings(2));

    const permanent = alwaysPermanent("409 reading id reused");
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: permanent,
      gatewayId: "gw_001_1",
    });
    await gateway.flushOnce();

    time.advance(3_600_000);
    const second = await gateway.flushOnce();

    expect(second).toMatchObject({
      kind: "quarantined",
      reason: "409 reading id reused",
      hold: { ageMs: 3_600_000, raisedAt: 1_000 },
    });
    // Still not resent: one attempt, ever.
    expect(permanent.sent.length).toBe(1);
  });

  it("keeps the original timestamp when the same hold is raised again", () => {
    const time = clock(500);
    harness = openHarness(10_000, time.now);
    harness.outbox.append(readings(2));

    const first = harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 2,
      kind: "permanent",
      reason: "first diagnosis",
    });

    time.advance(60_000);
    const second = harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 2,
      kind: "permanent",
      reason: "second diagnosis",
    });

    // Age-of-oldest-hold is what gets escalated on. A repeat raise must not reset
    // the clock and make a day-old problem look new, nor overwrite the first
    // diagnosis with a later restatement of it.
    expect(second.id).toBe(first.id);
    expect(second.raisedAt).toBe(500);
    expect(second.reason).toBe("first diagnosis");
    expect(second.ageMs).toBe(60_000);
    expect(harness.outbox.quarantineStatus().raisedTotal).toBe(1);
  });

  it("refuses to raise a hold with no recorded reason", () => {
    harness = openHarness();
    harness.outbox.append(readings(1));
    expect(() =>
      harness?.outbox.quarantine({
        fromSequence: 1,
        throughSequence: 1,
        kind: "permanent",
        reason: "   ",
      }),
    ).toThrow(/why it was raised/);
  });

  it("rejects a nonsensical range", () => {
    harness = openHarness();
    const active = harness;
    for (const request of [
      { fromSequence: 0, throughSequence: 1 },
      { fromSequence: 2, throughSequence: 1 },
      { fromSequence: 1.5, throughSequence: 3 },
    ] as const) {
      expect(() =>
        active.outbox.quarantine({ ...request, kind: "permanent", reason: "test" }),
      ).toThrow();
    }
  });
});

describe("releasing a hold retries the same readings", () => {
  it("lifts the hold and lets the identical range go out again", async () => {
    harness = openHarness();
    harness.outbox.append(readings(3));
    const originalIds = harness.outbox.readContiguousUnacked(10).map((row) => row.readingId);

    const permanent = alwaysPermanent("422 unknown source");
    const failing = new Gateway({
      outbox: harness.outbox,
      transport: permanent,
      gatewayId: "gw_001_1",
    });
    expect((await failing.flushOnce()).kind).toBe("quarantined");

    const release = harness.outbox.releaseQuarantine({
      expectedFromSequence: 1,
      operator: "jpabs670",
      note: "registered src_001_sim_panel in the source registry",
    });
    expect(release.kind).toBe("released");

    // The cause was addressed server-side; the same readings now deliver.
    const working = acceptAll();
    const resumed = new Gateway({
      outbox: harness.outbox,
      transport: working,
      gatewayId: "gw_001_1",
    });
    const result = await resumed.flushOnce();

    expect(result).toMatchObject({ kind: "flushed", sequenceStart: 1, sequenceEnd: 3 });
    expect(harness.outbox.ackedThrough()).toBe(3);
    // Byte-identical ids: a release is a retry, not a re-cut batch.
    expect(working.sentReadingIds()[0]).toEqual(originalIds);
  });

  it("records who released it and what they did", () => {
    const time = clock(10_000);
    harness = openHarness(10_000, time.now);
    harness.outbox.append(readings(2));
    harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 2,
      kind: "permanent",
      reason: "422 unknown metric",
    });

    time.advance(7_200_000);
    const outcome = harness.outbox.releaseQuarantine({
      expectedFromSequence: 1,
      operator: "jpabs670",
      note: "metric registered; verified against the registry",
    });

    expect(outcome).toMatchObject({
      kind: "released",
      record: {
        fromSequence: 1,
        reason: "422 unknown metric",
        raisedAt: 10_000,
        releasedAt: 7_210_000,
        releasedBy: "jpabs670",
        releaseNote: "metric registered; verified against the registry",
      },
    });
    expect(harness.outbox.activeQuarantine()).toBeUndefined();
    expect(harness.outbox.quarantineStatus()).toMatchObject({
      raisedTotal: 1,
      releasedTotal: 1,
    });
  });

  it("refuses an anonymous or unexplained release", () => {
    harness = openHarness();
    const active = harness;
    active.outbox.append(readings(1));
    active.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 1,
      kind: "permanent",
      reason: "422",
    });

    expect(() =>
      active.outbox.releaseQuarantine({ expectedFromSequence: 1, operator: "", note: "fixed" }),
    ).toThrow(/who authorised/);
    expect(() =>
      active.outbox.releaseQuarantine({ expectedFromSequence: 1, operator: "jpabs670", note: " " }),
    ).toThrow(/what was done/);

    // Neither attempt lifted anything.
    expect(active.outbox.activeQuarantine()).toBeDefined();
  });

  it("refuses to release a hold the operator has not looked at", () => {
    harness = openHarness();
    harness.outbox.append(readings(4));
    harness.outbox.acknowledgeThrough(2);
    harness.outbox.quarantine({
      fromSequence: 3,
      throughSequence: 4,
      kind: "permanent",
      reason: "422 unknown source",
    });

    // The operator read about a hold at sequence 1 — a different, older incident.
    const outcome = harness.outbox.releaseQuarantine({
      expectedFromSequence: 1,
      operator: "jpabs670",
      note: "stale decision",
    });

    expect(outcome).toMatchObject({
      kind: "stale",
      expectedFromSequence: 1,
      active: { fromSequence: 3, reason: "422 unknown source" },
    });
    expect(harness.outbox.activeQuarantine()).toBeDefined();
    expect(harness.outbox.quarantineStatus().releasedTotal).toBe(0);
  });

  it("reports that there was nothing to release", () => {
    harness = openHarness();
    harness.outbox.append(readings(1));
    expect(
      harness.outbox.releaseQuarantine({
        expectedFromSequence: 1,
        operator: "jpabs670",
        note: "nothing here",
      }),
    ).toEqual({ kind: "none_active" });
  });

  it("is not repeatable: a second release finds nothing active", () => {
    harness = openHarness();
    harness.outbox.append(readings(2));
    harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 2,
      kind: "permanent",
      reason: "422",
    });

    expect(
      harness.outbox.releaseQuarantine({
        expectedFromSequence: 1,
        operator: "jpabs670",
        note: "first",
      }).kind,
    ).toBe("released");
    expect(
      harness.outbox.releaseQuarantine({
        expectedFromSequence: 1,
        operator: "jpabs670",
        note: "second",
      }).kind,
    ).toBe("none_active");
    expect(harness.outbox.quarantineHistory().length).toBe(1);
  });

  it("holds again, with a fresh entry, if the cause was not actually fixed", async () => {
    harness = openHarness();
    harness.outbox.append(readings(2));

    const permanent = alwaysPermanent("422 still unknown");
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: permanent,
      gatewayId: "gw_001_1",
    });

    await gateway.flushOnce();
    harness.outbox.releaseQuarantine({
      expectedFromSequence: 1,
      operator: "jpabs670",
      note: "believed fixed",
    });
    await gateway.flushOnce();

    // The wrong call costs a retry and leaves a second audit entry — never data.
    expect(harness.outbox.activeQuarantine()).toMatchObject({ fromSequence: 1 });
    expect(harness.outbox.quarantineStatus()).toMatchObject({
      raisedTotal: 2,
      releasedTotal: 1,
    });
    expect(permanent.sent.length).toBe(2);
    expect(harness.outbox.counts()).toMatchObject({ total: 2, unacked: 2, ackedThrough: 0 });
  });
});

describe("a hold never becomes data loss", () => {
  it("preserves every reading for the whole life of the hold", async () => {
    harness = openHarness();
    harness.outbox.append(readings(5));
    const before = harness.outbox.readContiguousUnacked(10).map((row) => row.readingId);

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: alwaysPermanent("422"),
      gatewayId: "gw_001_1",
    });

    for (let cycle = 0; cycle < 5; cycle += 1) {
      await gateway.flushOnce();
    }

    expect(harness.outbox.counts()).toMatchObject({ total: 5, unacked: 5, acked: 0 });
    expect(harness.outbox.readContiguousUnacked(10).map((row) => row.readingId)).toEqual(before);
  });

  it("keeps accepting new readings while a range is held", async () => {
    harness = openHarness();
    harness.outbox.append(readings(2));

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: alwaysPermanent("422"),
      gatewayId: "gw_001_1",
    });
    await gateway.flushOnce();

    // Collection must not stop because delivery has: the site keeps producing
    // observations whether or not the server will take them.
    expect(harness.outbox.append(readings(2)).kind).toBe("appended");
    expect(harness.outbox.counts().total).toBe(4);
  });

  it("cannot be reclaimed away at capacity, because a held range is unsent", () => {
    harness = openHarness(4);
    harness.outbox.append(readings(4));
    harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 4,
      kind: "permanent",
      reason: "422",
    });

    const result = harness.outbox.append(readings(1));
    expect(result).toMatchObject({ kind: "refused", reclaimed: 0 });
    expect(harness.outbox.counts()).toMatchObject({ total: 4, unacked: 4 });
  });

  it("exposes no way to advance the cursor past a held range", () => {
    harness = openHarness();
    harness.outbox.append(readings(3));
    harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 3,
      kind: "permanent",
      reason: "422",
    });

    // The only exit is a release, which retries. Skipping would be silent loss, so
    // the surface deliberately has no operation for it — asserted on the public API
    // rather than in prose, because prose does not fail a build.
    const surface = new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(harness.outbox)),
      ...Object.keys(harness.outbox),
    ]);
    for (const forbidden of ["skip", "skipQuarantine", "discard", "abandon", "forceAcknowledge"]) {
      expect(surface.has(forbidden), `Outbox exposes ${forbidden}`).toBe(false);
    }
    expect(surface.has("releaseQuarantine")).toBe(true);
  });
});

describe("the audit trail survives and orders correctly", () => {
  it("lists incidents newest first with their outcomes", () => {
    const time = clock(0);
    harness = openHarness(10_000, time.now);
    harness.outbox.append(readings(6));

    for (const [from, through] of [
      [1, 2],
      [3, 4],
    ] as const) {
      time.advance(1_000);
      harness.outbox.acknowledgeThrough(from - 1);
      harness.outbox.quarantine({
        fromSequence: from,
        throughSequence: through,
        kind: "permanent",
        reason: `rejected ${from}..${through}`,
      });
      harness.outbox.releaseQuarantine({
        expectedFromSequence: from,
        operator: "jpabs670",
        note: `resolved ${from}`,
      });
    }

    const history = harness.outbox.quarantineHistory();
    expect(history.map((entry) => entry.fromSequence)).toEqual([3, 1]);
    expect(history.every((entry) => entry.releasedAt !== undefined)).toBe(true);
    expect(harness.outbox.quarantineStatus()).toMatchObject({
      raisedTotal: 2,
      releasedTotal: 2,
    });
    expect(harness.outbox.quarantineStatus().active).toBeUndefined();
  });

  it("bounds the history it returns", () => {
    harness = openHarness();
    harness.outbox.append(readings(1));
    harness.outbox.quarantine({
      fromSequence: 1,
      throughSequence: 1,
      kind: "permanent",
      reason: "422",
    });
    expect(harness.outbox.quarantineHistory(1).length).toBe(1);
    expect(() => harness?.outbox.quarantineHistory(0)).toThrow(/positive integer/);
  });
});
