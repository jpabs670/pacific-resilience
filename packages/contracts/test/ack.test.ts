import { describe, expect, it } from "vitest";
import {
  type BatchAck,
  batchAckSchemaForRange,
  parseBatchAck,
  parseBatchAckForRange,
  type SequenceRange,
  safeParseBatchAck,
  safeParseBatchAckForRange,
} from "../src/ack.js";
import { ContractValidationError } from "../src/errors.js";

/**
 * The acknowledgement contract.
 *
 * Codes are asserted rather than messages: `code` is the stable half of the
 * contract and `message` is explicitly allowed to change, so a test pinned to
 * prose would fail on a wording improvement while missing a real semantic change.
 */

const RANGE: SequenceRange = { sequenceStart: 1, sequenceEnd: 3 };

/** A consistent full acknowledgement of 1..3 — the baseline each case bends. */
function ack(overrides: Record<string, unknown> = {}): unknown {
  return { ackedThrough: 3, received: 3, inserted: 3, duplicate: 0, ...overrides };
}

function codesFor(input: unknown, range: SequenceRange = RANGE): string[] {
  const result = safeParseBatchAckForRange(input, range);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("a well-formed acknowledgement is accepted", () => {
  it("accepts a full acknowledgement of the transmitted range", () => {
    expect(parseBatchAckForRange(ack(), RANGE)).toEqual({
      ackedThrough: 3,
      received: 3,
      inserted: 3,
      duplicate: 0,
    });
  });

  it("accepts a partial prefix, counted from the range start", () => {
    expect(codesFor(ack({ ackedThrough: 2, received: 2, inserted: 2 }))).toEqual([]);
    expect(codesFor(ack({ ackedThrough: 1, received: 1, inserted: 1 }))).toEqual([]);
  });

  it("accepts duplicates standing in for inserts on a replay", () => {
    // The retry-after-lost-response case: nothing new was stored, everything was
    // already present, and the acknowledgement is still completely valid.
    expect(codesFor(ack({ inserted: 0, duplicate: 3 }))).toEqual([]);
    expect(codesFor(ack({ inserted: 1, duplicate: 2 }))).toEqual([]);
  });

  it("accepts a range that does not begin at one", () => {
    expect(
      codesFor(
        { ackedThrough: 12, received: 3, inserted: 3, duplicate: 0 },
        {
          sequenceStart: 10,
          sequenceEnd: 12,
        },
      ),
    ).toEqual([]);
  });

  it("accepts a single-reading range", () => {
    expect(
      codesFor(
        { ackedThrough: 7, received: 1, inserted: 1, duplicate: 0 },
        {
          sequenceStart: 7,
          sequenceEnd: 7,
        },
      ),
    ).toEqual([]);
  });

  it("accepts flagged from zero up to received, and its absence", () => {
    expect(codesFor(ack({ flagged: 0 }))).toEqual([]);
    expect(codesFor(ack({ flagged: 3 }))).toEqual([]);
    expect(codesFor(ack())).toEqual([]);
  });

  it("accepts the largest safe sequence", () => {
    const end = Number.MAX_SAFE_INTEGER;
    expect(
      codesFor(
        { ackedThrough: end, received: 1, inserted: 1, duplicate: 0 },
        {
          sequenceStart: end,
          sequenceEnd: end,
        },
      ),
    ).toEqual([]);
  });
});

describe("the position must be inside the transmitted range", () => {
  it("rejects a claim beyond the range", () => {
    expect(codesFor(ack({ ackedThrough: 4, received: 4, inserted: 4 }))).toContain(
      "ack.acked_through.out_of_range",
    );
    expect(codesFor(ack({ ackedThrough: 99, received: 99, inserted: 99 }))).toContain(
      "ack.acked_through.out_of_range",
    );
  });

  it("rejects zero progress dressed as success", () => {
    // "Accepted, but nothing was durably stored" is a retryable failure and belongs
    // in a 5xx. Allowing it here would create a success that means the same thing as
    // an error, and the gateway would have to guess which.
    expect(codesFor(ack({ ackedThrough: 0, received: 0, inserted: 0 }))).toContain(
      "ack.acked_through.out_of_range",
    );
  });

  it("rejects a position below a range that does not start at one", () => {
    expect(
      codesFor(
        { ackedThrough: 2, received: 2, inserted: 2, duplicate: 0 },
        {
          sequenceStart: 3,
          sequenceEnd: 5,
        },
      ),
    ).toContain("ack.acked_through.out_of_range");
  });

  it("does not pile a derivative count complaint on top of a bad position", () => {
    // `received` is checked against `ackedThrough`; if the position is wrong the
    // count cannot be judged, and reporting both would send an operator hunting a
    // counter that was never the problem.
    const codes = codesFor(ack({ ackedThrough: 9, received: 3, inserted: 3 }));
    expect(codes).toEqual(["ack.acked_through.out_of_range"]);
  });

  it("still reports range-independent totals when the position is wrong", () => {
    const codes = codesFor(ack({ ackedThrough: 9, received: 3, inserted: 1, duplicate: 1 }));
    expect(codes).toContain("ack.acked_through.out_of_range");
    expect(codes).toContain("ack.totals.mismatch");
  });
});

describe("the counters must describe the acknowledged prefix", () => {
  it("rejects a count that contradicts the position", () => {
    expect(codesFor(ack({ received: 2, inserted: 2 }))).toContain("ack.received.mismatch");
    expect(codesFor(ack({ ackedThrough: 2, received: 3, inserted: 3 }))).toContain(
      "ack.received.mismatch",
    );
  });

  it("rejects a server reporting request size instead of prefix size", () => {
    // The realistic wrong implementation: 1000 sent, 400 committed, `received`
    // reported as 1000. It has to fail, or the counters could never contradict the
    // position and the cross-check would be decorative.
    expect(
      codesFor(
        { ackedThrough: 400, received: 1000, inserted: 400, duplicate: 0 },
        {
          sequenceStart: 1,
          sequenceEnd: 1000,
        },
      ),
    ).toContain("ack.received.mismatch");
  });

  it("rejects totals that do not sum to received", () => {
    expect(codesFor(ack({ inserted: 1, duplicate: 1 }))).toContain("ack.totals.mismatch");
    expect(codesFor(ack({ inserted: 3, duplicate: 1 }))).toContain("ack.totals.mismatch");
    expect(codesFor(ack({ inserted: 0, duplicate: 0 }))).toContain("ack.totals.mismatch");
  });

  it("rejects flagged in excess of received", () => {
    expect(codesFor(ack({ flagged: 4 }))).toContain("ack.flagged.exceeds_received");
  });
});

describe("malformed and hostile bodies are rejected on shape", () => {
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["a fractional cursor", ack({ ackedThrough: 2.5 })],
    ["a NaN cursor", ack({ ackedThrough: Number.NaN })],
    ["an infinite cursor", ack({ ackedThrough: Number.POSITIVE_INFINITY })],
    ["a negative cursor", ack({ ackedThrough: -1 })],
    ["a cursor beyond the safe integer range", ack({ ackedThrough: 2 ** 53 })],
    ["a fractional counter", ack({ inserted: 2.5, duplicate: 0.5 })],
    ["a negative counter", ack({ inserted: 4, duplicate: -1 })],
    ["a negative flagged", ack({ flagged: -1 })],
    ["a numeric string counter", ack({ received: "3" })],
    ["a boolean counter", ack({ duplicate: true })],
    ["a null counter", ack({ inserted: null })],
    ["an array counter", ack({ received: [3] })],
    ["a missing counter", { ackedThrough: 3, inserted: 3, duplicate: 0 }],
    ["a missing cursor", { received: 3, inserted: 3, duplicate: 0 }],
    ["an unknown key", ack({ evil: 1 })],
    ["a null body", null],
    ["an undefined body", undefined],
    ["a string body", "ackedThrough=3"],
    ["an array body", [3, 3, 3, 0]],
    ["an empty body", {}],
  ];

  for (const [label, input] of malformed) {
    it(`rejects ${label}`, () => {
      const result = safeParseBatchAckForRange(input, RANGE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.length).toBeGreaterThan(0);
        // Every issue carries a stable code and a path, so a violation can be
        // counted by cause instead of grepped out of a message.
        for (const issue of result.issues) {
          expect(issue.code).not.toBe("");
          expect(issue.path).not.toBe("");
        }
      }
    });
  }

  it("reports every bad field, not just the first", () => {
    const codes = codesFor(ack({ inserted: 2.5, duplicate: 0.5 }));
    expect(codes.length).toBeGreaterThanOrEqual(2);
  });

  it("cannot pollute Object.prototype through a __proto__ key", () => {
    // JSON.parse creates `__proto__` as an ordinary own property rather than
    // reassigning the prototype, and validation reads named fields off the result
    // instead of merging the body into anything. Asserted rather than assumed,
    // because the body arrives from across a network.
    const hostile = JSON.parse(
      '{"ackedThrough":3,"received":3,"inserted":3,"duplicate":0,"__proto__":{"polluted":true}}',
    ) as unknown;
    const result = safeParseBatchAckForRange(hostile, RANGE);

    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
    expect(Reflect.get({}, "polluted")).toBeUndefined();
    if (result.ok) {
      // The fields the gateway acts on are the real ones.
      expect(result.value.ackedThrough).toBe(3);
      expect(result.value.received).toBe(3);
    }
  });

  it("rejects a toString override rather than calling it", () => {
    expect(codesFor(ack({ toString: () => "3" }))).toContain("object.unknown_key");
  });
});

describe("the range-independent form is usable by a server checking its own reply", () => {
  it("accepts any position when no range is supplied", () => {
    expect(safeParseBatchAck(ack({ ackedThrough: 9_999 })).ok).toBe(true);
  });

  it("still enforces the totals", () => {
    const result = safeParseBatchAck(ack({ inserted: 1, duplicate: 1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain("ack.totals.mismatch");
    }
  });

  it("throws a contract error from the parsing form", () => {
    expect(() => parseBatchAck(ack({ flagged: 99 }))).toThrow(ContractValidationError);
    expect(() => parseBatchAckForRange(ack({ ackedThrough: 99 }), RANGE)).toThrow(
      ContractValidationError,
    );
  });

  it("narrows to the declared type", () => {
    const value: BatchAck = parseBatchAckForRange(ack({ flagged: 1 }), RANGE);
    expect(value.flagged).toBe(1);
  });
});

describe("a malformed range is a caller defect, not a validation issue", () => {
  it("throws rather than producing an issue an operator would have to interpret", () => {
    for (const range of [
      { sequenceStart: 3, sequenceEnd: 1 },
      { sequenceStart: -1, sequenceEnd: 3 },
      { sequenceStart: 1.5, sequenceEnd: 3 },
      { sequenceStart: 1, sequenceEnd: Number.NaN },
    ]) {
      expect(() => batchAckSchemaForRange(range)).toThrow(RangeError);
      expect(() => safeParseBatchAckForRange(ack(), range)).toThrow(RangeError);
    }
  });
});
