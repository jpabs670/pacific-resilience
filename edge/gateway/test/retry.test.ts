import { afterEach, describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway.js";
import {
  acceptAll,
  alwaysPermanent,
  alwaysRetryable,
  failThenAccept,
  type Harness,
  noJitter,
  openHarness,
  readings,
} from "./support/harness.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

describe("retries preserve reading IDs", () => {
  it("resends byte-identical ids on every attempt", async () => {
    harness = openHarness();
    harness.outbox.append(readings(5));

    const transport = failThenAccept(3);
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport,
      gatewayId: "gw_001_1",
      backoff: { initialMs: 1, ceilingMs: 4, random: noJitter },
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect((await gateway.flushOnce()).kind).toBe("deferred");
    }
    expect((await gateway.flushOnce()).kind).toBe("flushed");

    const idSets = transport.sentReadingIds();
    expect(idSets.length).toBe(4);
    const [first] = idSets;
    expect(first).toBeDefined();
    for (const ids of idSets) {
      expect(ids).toEqual(first);
    }
  });

  it("resends the identical sequence range, not a re-cut batch", async () => {
    harness = openHarness();
    harness.outbox.append(readings(4));

    const transport = failThenAccept(2);
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport,
      gatewayId: "gw_001_1",
      backoff: { initialMs: 1, ceilingMs: 4, random: noJitter },
    });
    await gateway.flushOnce();
    await gateway.flushOnce();
    await gateway.flushOnce();

    for (const batch of transport.sent) {
      expect(batch.sequenceStart).toBe(1);
      expect(batch.sequenceEnd).toBe(4);
    }
  });

  it("does not re-generate an id when the process restarts mid-retry", async () => {
    harness = openHarness();
    harness.outbox.append(readings(3));
    const before = harness.outbox.readContiguousUnacked(10).map((row) => row.readingId);

    const failing = alwaysRetryable();
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: failing,
      gatewayId: "gw_001_1",
      backoff: { initialMs: 1, ceilingMs: 4, random: noJitter },
    });
    await gateway.flushOnce();

    const reopened = harness.reopenAfterAbandon();
    const resumed = new Gateway({
      outbox: reopened,
      transport: acceptAll(),
      gatewayId: "gw_001_1",
    });
    await resumed.flushOnce();

    expect(reopened.ackedThrough()).toBe(3);
    expect(before.length).toBe(3);
    expect(failing.sentReadingIds()[0]).toEqual(before);
  });
});

describe("a failed send removes nothing", () => {
  it("leaves every reading queued after a retryable failure", async () => {
    harness = openHarness();
    harness.outbox.append(readings(6));
    const before = harness.outbox.counts();

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: alwaysRetryable(),
      gatewayId: "gw_001_1",
      backoff: { initialMs: 1, ceilingMs: 4, random: noJitter },
    });

    for (let i = 0; i < 5; i += 1) {
      expect((await gateway.flushOnce()).kind).toBe("deferred");
    }

    const after = harness.outbox.counts();
    expect(after.total).toBe(before.total);
    expect(after.unacked).toBe(before.unacked);
    expect(after.ackedThrough).toBe(0);
    expect(harness.outbox.readContiguousUnacked(10).length).toBe(6);
  });

  it("leaves every reading queued after a permanent failure", async () => {
    harness = openHarness();
    harness.outbox.append(readings(3));

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: alwaysPermanent(),
      gatewayId: "gw_001_1",
    });
    const result = await gateway.flushOnce();

    expect(result).toMatchObject({ kind: "quarantined", sequenceStart: 1, sequenceEnd: 3 });
    expect(harness.outbox.counts().total).toBe(3);
    expect(harness.outbox.ackedThrough()).toBe(0);
  });

  it("does not advance the cursor past a quarantined range", async () => {
    harness = openHarness();
    harness.outbox.append(readings(2));

    const permanent = alwaysPermanent("422 unknown metric");
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: permanent,
      gatewayId: "gw_001_1",
    });

    expect((await gateway.flushOnce()).kind).toBe("quarantined");
    expect(harness.outbox.quarantinedFrom()).toBe(1);

    // A quarantined range is not retried blindly: retrying would never succeed, and
    // skipping it would be silent loss. A stuck cursor is the visible failure.
    const second = await gateway.flushOnce();
    expect(second.kind).toBe("quarantined");
    expect(permanent.sent.length).toBe(1);
    expect(harness.outbox.ackedThrough()).toBe(0);
  });
});

describe("bounded retry behaviour", () => {
  it("counts consecutive attempts and resets them on success", async () => {
    harness = openHarness();
    harness.outbox.append(readings(2));

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: failThenAccept(2),
      gatewayId: "gw_001_1",
      backoff: { initialMs: 10, ceilingMs: 100, random: noJitter },
    });

    const first = await gateway.flushOnce();
    const second = await gateway.flushOnce();
    expect(first).toMatchObject({ kind: "deferred", attempt: 1 });
    expect(second).toMatchObject({ kind: "deferred", attempt: 2 });
    expect(gateway.currentAttempt()).toBe(2);

    expect((await gateway.flushOnce()).kind).toBe("flushed");
    expect(gateway.currentAttempt()).toBe(0);
  });

  it("never proposes a delay above the ceiling, however long the outage", async () => {
    harness = openHarness();
    harness.outbox.append(readings(1));

    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: alwaysRetryable(),
      gatewayId: "gw_001_1",
      backoff: { initialMs: 1_000, ceilingMs: 5_000, random: noJitter },
    });

    for (let i = 0; i < 25; i += 1) {
      const result = await gateway.flushOnce();
      if (result.kind !== "deferred") {
        throw new Error(`expected deferred, got ${result.kind}`);
      }
      expect(result.delayMs).toBeGreaterThan(0);
      expect(result.delayMs).toBeLessThanOrEqual(5_000);
    }
  });

  it("treats a transport that throws as a retryable failure", async () => {
    harness = openHarness();
    harness.outbox.append(readings(3));
    const before = harness.outbox.counts();

    // Every realistic transport breaks the "report, do not throw" contract
    // eventually: an HTTP client throws on a DNS failure long before it has a status
    // code to report. That must not take down the flush loop.
    const throwing = {
      send: () => Promise.reject(new Error("getaddrinfo ENOTFOUND ingest.internal")),
    };
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: throwing,
      gatewayId: "gw_001_1",
      backoff: { initialMs: 1, ceilingMs: 4, random: noJitter },
    });

    const result = await gateway.flushOnce();
    expect(result).toMatchObject({ kind: "deferred", attempt: 1 });
    if (result.kind === "deferred") {
      expect(result.reason).toMatch(/transport threw: getaddrinfo ENOTFOUND/);
    }
    // Retryable means retryable: nothing advanced, nothing lost.
    expect(harness.outbox.counts()).toMatchObject({
      total: before.total,
      unacked: before.unacked,
      ackedThrough: 0,
    });
  });

  it("survives a transport that throws a non-error value", async () => {
    harness = openHarness();
    harness.outbox.append(readings(1));
    const gateway = new Gateway({
      outbox: harness.outbox,
      // Rejecting with a bare string, not an Error: a transport can fail in any way
      // it likes, and the gateway still has to produce a usable reason.
      transport: { send: () => Promise.reject("socket hang up") },
      gatewayId: "gw_001_1",
      backoff: { initialMs: 1, ceilingMs: 4, random: noJitter },
    });

    const result = await gateway.flushOnce();
    expect(result.kind).toBe("deferred");
    if (result.kind === "deferred") {
      expect(result.reason).toMatch(/socket hang up/);
    }
  });

  it("reports the transport's reason so a stall is diagnosable", async () => {
    harness = openHarness();
    harness.outbox.append(readings(1));
    const gateway = new Gateway({
      outbox: harness.outbox,
      transport: alwaysRetryable("uplink down"),
      gatewayId: "gw_001_1",
      backoff: { initialMs: 1, ceilingMs: 2, random: noJitter },
    });
    expect(await gateway.flushOnce()).toMatchObject({ reason: "uplink down" });
  });
});
