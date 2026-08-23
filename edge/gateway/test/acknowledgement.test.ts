import { afterEach, describe, expect, it } from "vitest";
import { validateAck } from "../src/acknowledgement.js";
import { Gateway } from "../src/gateway.js";
import type { BatchAck } from "../src/transport.js";
import {
  acceptAll,
  acceptPartially,
  acceptWithAck,
  type Harness,
  openHarness,
  readings,
} from "./support/harness.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

describe("acknowledgement advances only through contiguous sequences", () => {
  it("advances to the acknowledged point and no further", () => {
    harness = openHarness();
    harness.outbox.append(readings(5));

    expect(harness.outbox.acknowledgeThrough(3)).toMatchObject({
      kind: "advanced",
      ackedThrough: 3,
      marked: 3,
    });
    expect(harness.outbox.readContiguousUnacked(10).map((row) => row.sequence)).toEqual([4, 5]);
  });

  it("is idempotent when the same point is acknowledged twice", () => {
    harness = openHarness();
    harness.outbox.append(readings(3));
    harness.outbox.acknowledgeThrough(2);

    expect(harness.outbox.acknowledgeThrough(2)).toMatchObject({
      kind: "unchanged",
      ackedThrough: 2,
    });
    expect(harness.outbox.counts()).toMatchObject({ acked: 2, unacked: 1 });
  });

  it("refuses to rewind", () => {
    harness = openHarness();
    harness.outbox.append(readings(4));
    harness.outbox.acknowledgeThrough(3);

    expect(harness.outbox.acknowledgeThrough(1)).toMatchObject({
      kind: "refused",
      reason: "rewind",
      ackedThrough: 3,
    });
    expect(harness.outbox.ackedThrough()).toBe(3);
  });

  it("refuses to advance past the highest allocated sequence", () => {
    harness = openHarness();
    harness.outbox.append(readings(3));

    // A server claiming to have stored more than was ever sent is a protocol
    // violation, not a reason to skip readings.
    expect(harness.outbox.acknowledgeThrough(9)).toMatchObject({
      kind: "refused",
      reason: "beyond_end",
      ackedThrough: 0,
    });
    expect(harness.outbox.readContiguousUnacked(10).length).toBe(3);
  });

  it("refuses to jump a gap left by pruning", () => {
    harness = openHarness();
    harness.outbox.append(readings(2));
    harness.outbox.acknowledgeThrough(2);
    harness.outbox.prune(2);
    harness.outbox.append(readings(2)); // sequences 3 and 4

    // Rewind the cursor is impossible, so construct the gap the other way: rows 3
    // and 4 exist, and acknowledging through 4 is contiguous from the cursor at 2.
    expect(harness.outbox.acknowledgeThrough(4)).toMatchObject({ kind: "advanced" });

    // Now a genuinely non-contiguous claim: nothing exists beyond 4.
    expect(harness.outbox.acknowledgeThrough(5)).toMatchObject({
      kind: "refused",
      reason: "beyond_end",
    });
  });

  it("rejects a negative or fractional acknowledgement", () => {
    harness = openHarness();
    harness.outbox.append(readings(1));
    expect(() => harness?.outbox.acknowledgeThrough(-1)).toThrow();
    expect(() => harness?.outbox.acknowledgeThrough(1.5)).toThrow();
  });
});

describe("a partial acknowledgement leaves the remainder queued", () => {
  it("advances only to the point the server durably stored", async () => {
    harness = openHarness();
    harness.outbox.append(readings(6));

    const transport = acceptPartially(4);
    const gateway = new Gateway({ outbox: harness.outbox, transport, gatewayId: "gw_001_1" });
    const result = await gateway.flushOnce();

    expect(result).toMatchObject({ kind: "flushed", sequenceStart: 1, sequenceEnd: 6 });
    expect(harness.outbox.ackedThrough()).toBe(4);

    // The unacknowledged tail is resent, and nothing is lost.
    const remaining = harness.outbox.readContiguousUnacked(10);
    expect(remaining.map((row) => row.sequence)).toEqual([5, 6]);
  });

  it("acknowledges the full range when the server stored all of it", async () => {
    harness = openHarness();
    harness.outbox.append(readings(4));

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: acceptAll(),
      gatewayId: "gw_001_1",
    });

    expect(await gateway.flushOnce()).toMatchObject({
      kind: "flushed",
      sequenceStart: 1,
      sequenceEnd: 4,
      ackedThrough: 4,
    });
    expect(harness.outbox.counts()).toMatchObject({ acked: 4, unacked: 0 });
    expect(await gateway.flushOnce()).toEqual({ kind: "idle" });
  });

  it("advances the cursor across successive partial acknowledgements", async () => {
    harness = openHarness();
    harness.outbox.append(readings(6));

    const first = new Gateway({
      outbox: harness.outbox,
      transport: acceptPartially(2),
      gatewayId: "gw_001_1",
    });
    expect(await first.flushOnce()).toMatchObject({ kind: "flushed", ackedThrough: 2 });

    // The next cycle sends the tail, and a prefix of *that* is acknowledged.
    const second = new Gateway({
      outbox: harness.outbox,
      transport: acceptPartially(5),
      gatewayId: "gw_001_1",
    });
    expect(await second.flushOnce()).toMatchObject({
      kind: "flushed",
      sequenceStart: 3,
      sequenceEnd: 6,
      ackedThrough: 5,
    });
    expect(harness.outbox.readContiguousUnacked(10).map((row) => row.sequence)).toEqual([6]);
  });
});

// ---------------------------------------------------------------------------
// The gateway's adapter over the acknowledgement contract.
//
// The rule matrix lives in `packages/contracts/test/ack.test.ts`, beside the
// schema it belongs to. What is asserted here is the part the gateway owns: the
// valid/invalid decision it acts on, and whether a refusal arrives with enough
// detail to diagnose the peer without reproducing the exchange.
// ---------------------------------------------------------------------------

/** A consistent acknowledgement of sequences 1..3, the baseline each case bends. */
function baseline(overrides: Partial<BatchAck> = {}): BatchAck {
  return { ackedThrough: 3, received: 3, inserted: 3, duplicate: 0, ...overrides };
}

describe("the gateway acts on the contract's verdict", () => {
  it("passes a consistent acknowledgement through with its position", () => {
    expect(validateAck(baseline(), 1, 3)).toEqual({ kind: "valid", ackedThrough: 3 });
    expect(validateAck(baseline({ ackedThrough: 2, received: 2, inserted: 2 }), 1, 3)).toEqual({
      kind: "valid",
      ackedThrough: 2,
    });
  });

  it("reports a refusal with a human diagnostic and stable codes", () => {
    const result = validateAck(baseline({ ackedThrough: 99, received: 99, inserted: 99 }), 1, 3);

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") {
      return;
    }
    // The values that failed, named — an operator should not need the request body
    // to understand the refusal.
    expect(result.reason).toMatch(/ackedThrough/);
    expect(result.reason).toMatch(/99/);
    expect(result.reason).toMatch(/1\.\.3/);
    expect(result.codes).toEqual(["ack.acked_through.out_of_range"]);
  });

  it("reports every fault in one refusal rather than one per cycle", () => {
    const result = validateAck(baseline({ inserted: 2.5, duplicate: 0.5 }), 1, 3);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.codes.length).toBeGreaterThanOrEqual(2);
      expect(result.reason).toMatch(/inserted/);
      expect(result.reason).toMatch(/duplicate/);
    }
  });

  it("carries the contract issues through for structured logging", () => {
    const result = validateAck(baseline({ flagged: 9 }), 1, 3);
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.issues[0]).toMatchObject({
        code: "ack.flagged.exceeds_received",
        path: "flagged",
      });
    }
  });
});

describe("an unusable acknowledgement moves nothing and is reported as such", () => {
  /** Every violation must leave the outbox exactly as the flush found it. */
  async function expectViolation(ack: Partial<BatchAck>, reason: RegExp): Promise<void> {
    const active = openHarness();
    harness = active;
    active.outbox.append(readings(3));
    const before = active.outbox.counts();

    const gateway = new Gateway({
      outbox: active.outbox,
      transport: acceptWithAck((batch) => ({
        ackedThrough: batch.sequenceEnd,
        received: batch.readings.length,
        inserted: batch.readings.length,
        duplicate: 0,
        ...ack,
      })),
      gatewayId: "gw_001_1",
    });

    const result = await gateway.flushOnce();

    expect(result.kind).toBe("protocol_violation");
    if (result.kind === "protocol_violation") {
      expect(result.reason).toMatch(reason);
      expect(result.sequenceStart).toBe(1);
      expect(result.sequenceEnd).toBe(3);
    }

    // Advance nothing, preserve everything.
    expect(active.outbox.ackedThrough()).toBe(0);
    expect(active.outbox.counts()).toMatchObject({
      total: before.total,
      unacked: before.unacked,
      acked: 0,
    });
    expect(active.outbox.readContiguousUnacked(10).map((row) => row.sequence)).toEqual([1, 2, 3]);

    active.cleanup();
    harness = undefined;
  }

  it("refuses a claim beyond the transmitted batch but inside allocated rows", async () => {
    harness = openHarness();
    harness.outbox.append(readings(6));

    // Rows 4..6 genuinely exist, so the outbox alone would have accepted this
    // acknowledgement as contiguous. Only the transmitted range refutes it: the
    // batch carried 1..3, so the server cannot have stored 6.
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: acceptWithAck(() => ({
        ackedThrough: 6,
        received: 6,
        inserted: 6,
        duplicate: 0,
      })),
      gatewayId: "gw_001_1",
      batchMaxReadings: 3,
    });

    const result = await gateway.flushOnce();
    expect(result).toMatchObject({
      kind: "protocol_violation",
      sequenceStart: 1,
      sequenceEnd: 3,
    });
    expect(harness.outbox.ackedThrough()).toBe(0);
    expect(harness.outbox.counts()).toMatchObject({ total: 6, unacked: 6, acked: 0 });
  });

  it("refuses a claim beyond any allocated row", async () => {
    await expectViolation(
      { ackedThrough: 99, received: 99, inserted: 99 },
      /outside the transmitted range 1\.\.3/,
    );
  });

  it("refuses a rewind below the transmitted batch", async () => {
    await expectViolation({ ackedThrough: 0, received: 0, inserted: 0 }, /outside the transmitted/);
  });

  it("refuses accounting that does not add up", async () => {
    await expectViolation({ inserted: 1, duplicate: 1 }, /does not equal received 3/);
  });

  it("refuses a count that contradicts the cursor", async () => {
    await expectViolation({ ackedThrough: 2, received: 3, inserted: 3 }, /received 3 contradicts/);
  });

  it("refuses flagged in excess of received", async () => {
    await expectViolation({ flagged: 9 }, /flagged 9 exceeds received 3/);
  });

  it("quarantines the range so the next cycle stops rather than resending", async () => {
    harness = openHarness();
    harness.outbox.append(readings(3));

    const transport = acceptWithAck(() => ({
      ackedThrough: 99,
      received: 99,
      inserted: 99,
      duplicate: 0,
    }));
    const gateway = new Gateway({ outbox: harness.outbox, transport, gatewayId: "gw_001_1" });

    expect(await gateway.flushOnce()).toMatchObject({ kind: "protocol_violation" });
    expect(harness.outbox.counts().quarantinedFrom).toBe(1);

    // A second cycle must not send again, and must still not lose anything.
    expect(await gateway.flushOnce()).toMatchObject({ kind: "quarantined" });
    expect(transport.sent.length).toBe(1);
    expect(harness.outbox.readContiguousUnacked(10).length).toBe(3);
  });

  it("does not count a misbehaving peer as a transport failure", async () => {
    harness = openHarness();
    harness.outbox.append(readings(3));

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: acceptWithAck(() => ({
        ackedThrough: 0,
        received: 0,
        inserted: 0,
        duplicate: 0,
      })),
      gatewayId: "gw_001_1",
    });

    await gateway.flushOnce();
    // Backoff answers an unreachable server. This server answered, promptly and
    // wrongly, so there is nothing to wait for.
    expect(gateway.currentAttempt()).toBe(0);
  });

  it("treats a refusal from the outbox itself as a protocol violation", async () => {
    harness = openHarness();
    const active = harness;
    active.outbox.append(readings(3));

    // Validation makes an outbox refusal unreachable, so force the disagreement
    // directly: the cursor must not move on the strength of the validator alone.
    active.outbox.acknowledgeThrough = () => ({
      kind: "refused",
      reason: "gap",
      ackedThrough: 0,
      requested: 3,
    });

    const gateway = new Gateway({
      outbox: active.outbox,
      transport: acceptAll(),
      gatewayId: "gw_001_1",
    });

    const result = await gateway.flushOnce();
    expect(result.kind).toBe("protocol_violation");
    if (result.kind === "protocol_violation") {
      expect(result.reason).toMatch(/outbox refused acknowledgement through 3: gap/);
    }
    expect(active.outbox.ackedThrough()).toBe(0);
    expect(active.outbox.readContiguousUnacked(10).length).toBe(3);
  });
});

describe("batch preparation", () => {
  it("describes exactly the readings it carries", async () => {
    harness = openHarness();
    harness.outbox.append(readings(7));
    harness.outbox.append(readings(7));

    const transport = acceptAll();
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport,
      gatewayId: "gw_001_1",
      batchMaxReadings: 10,
    });
    await gateway.flushOnce();

    const batch = transport.sent[0];
    expect(batch).toBeDefined();
    if (batch === undefined) {
      return;
    }
    expect(batch.readings.length).toBe(10);
    expect(batch.sequenceStart).toBe(1);
    expect(batch.sequenceEnd).toBe(10);
    expect(batch.sequenceEnd - batch.sequenceStart + 1).toBe(batch.readings.length);
    expect(batch.gatewayId).toBe("gw_001_1");
    expect(batch.clockOffsetMs).toBe(0);
  });

  it("reports the gateway's clock offset estimate", async () => {
    harness = openHarness();
    harness.outbox.append(readings(1));
    const transport = acceptAll();
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport,
      gatewayId: "gw_001_1",
      clockOffsetMs: -1500,
    });
    await gateway.flushOnce();
    expect(transport.sent[0]?.clockOffsetMs).toBe(-1500);
  });

  it("is idle when nothing is queued", async () => {
    harness = openHarness();
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: acceptAll(),
      gatewayId: "gw_001_1",
    });
    expect(await gateway.flushOnce()).toEqual({ kind: "idle" });
  });

  it("rejects a malformed gatewayId at construction, not on the first flush", () => {
    const active = openHarness();
    harness = active;
    // Otherwise the outbox accumulates readings against a gateway that can never
    // send them, and the misconfiguration presents as a delivery outage.
    for (const gatewayId of ["", "gw_", "gateway-1", "GW_001_1", "gw_001-1", "site_001"]) {
      expect(
        () => new Gateway({ outbox: active.outbox, transport: acceptAll(), gatewayId }),
        gatewayId,
      ).toThrow(/gatewayId/);
    }
    expect(
      () => new Gateway({ outbox: active.outbox, transport: acceptAll(), gatewayId: "gw_001_1" }),
    ).not.toThrow();
  });

  it("rejects a fractional clock offset at construction", () => {
    const active = openHarness();
    harness = active;
    expect(
      () =>
        new Gateway({
          outbox: active.outbox,
          transport: acceptAll(),
          gatewayId: "gw_001_1",
          clockOffsetMs: -1500.5,
        }),
    ).toThrow(/clockOffsetMs/);
  });

  it("rejects a batch limit above the documented maximum", () => {
    const active = openHarness();
    harness = active;
    expect(
      () =>
        new Gateway({
          outbox: active.outbox,
          transport: acceptAll(),
          gatewayId: "gw_001_1",
          batchMaxReadings: 1001,
        }),
    ).toThrow(/1\.\.1000/);
  });
});
