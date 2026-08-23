import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OUTBOX_PRAGMAS, OUTBOX_SCHEMA, Outbox } from "../src/outbox.js";

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "support", "crash-child.mjs");

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("committed readings survive an uncatchable process death", () => {
  it("recovers rows written by a process killed with SIGKILL", () => {
    dir = mkdtempSync(join(tmpdir(), "pr-crash-"));
    const path = join(dir, "outbox.sqlite");
    const count = 9;

    const child = spawnSync(process.execPath, [CHILD, path, String(count)], {
      env: {
        ...process.env,
        OUTBOX_SCHEMA,
        OUTBOX_PRAGMAS: JSON.stringify(OUTBOX_PRAGMAS),
      },
      encoding: "utf8",
    });

    // The child must actually have been killed, not exited cleanly — otherwise the
    // test would pass while proving nothing about crash durability.
    expect(child.signal, `stderr: ${child.stderr}`).toBe("SIGKILL");

    const outbox = Outbox.open({ path, maxReadings: 100 });
    try {
      expect(outbox.counts()).toMatchObject({ total: count, unacked: count, ackedThrough: 0 });

      const rows = outbox.readContiguousUnacked(100);
      expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(rows[0]?.readingId).toBe("00000000-0000-4000-8000-000000000001");
      expect(rows[0]?.envelope.origins).toEqual(["simulated"]);
    } finally {
      outbox.close();
    }
  });

  it("continues allocating after the sequence counter recovered from the crash", () => {
    dir = mkdtempSync(join(tmpdir(), "pr-crash-"));
    const path = join(dir, "outbox.sqlite");

    const child = spawnSync(process.execPath, [CHILD, path, "4"], {
      env: { ...process.env, OUTBOX_SCHEMA, OUTBOX_PRAGMAS: JSON.stringify(OUTBOX_PRAGMAS) },
      encoding: "utf8",
    });
    expect(child.signal).toBe("SIGKILL");

    const outbox = Outbox.open({ path, maxReadings: 100 });
    try {
      const appended = outbox.append([
        {
          schemaVersion: 1,
          readingId: "00000000-0000-4000-8000-0000000000ff",
          siteId: "site_001",
          sourceId: "src_001_sim_panel",
          metric: "voltage.rms",
          capturedAt: "2026-07-26T04:15:31.250Z",
          sample: { kind: "numeric", value: 119.1, unit: "V" },
          origins: ["simulated"],
          derivation: "direct",
        },
      ]);
      // No sequence is reused: allocation resumes after the recovered counter.
      expect(appended).toMatchObject({ kind: "appended", sequenceStart: 5, sequenceEnd: 5 });
    } finally {
      outbox.close();
    }
  });
});
