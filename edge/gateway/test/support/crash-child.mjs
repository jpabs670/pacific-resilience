/**
 * Crash-durability child.
 *
 * Opens the outbox file with the schema and PRAGMAs exported by `src/outbox.ts`
 * (passed in through the environment, so this file cannot drift from them),
 * commits rows, and then kills itself with SIGKILL — a signal no handler can
 * intercept and no shutdown path can tidy up after.
 *
 * The parent then reopens the same file with the real `Outbox` class and asserts
 * the committed rows are there. What this proves is that data committed under the
 * outbox's durability configuration survives an uncatchable process death. It does
 * not execute `Outbox.append` inside the killed process: our sources use `.js`
 * extension ESM specifiers, which Node's type stripping cannot resolve, so a
 * spawned child cannot import them without a build step.
 */
import Database from "better-sqlite3";

const [path, countArg] = process.argv.slice(2);
const count = Number(countArg);

if (typeof path !== "string" || !Number.isInteger(count) || count <= 0) {
  console.error("usage: crash-child.mjs <db-path> <count>");
  process.exit(2);
}

const schema = process.env.OUTBOX_SCHEMA;
const pragmas = JSON.parse(process.env.OUTBOX_PRAGMAS ?? "[]");
if (typeof schema !== "string" || !Array.isArray(pragmas) || pragmas.length === 0) {
  console.error("crash-child requires OUTBOX_SCHEMA and OUTBOX_PRAGMAS");
  process.exit(2);
}

const db = new Database(path);
for (const pragma of pragmas) {
  db.pragma(pragma);
}
db.exec(schema);

const insert = db.prepare(
  "INSERT INTO outbox (sequence, reading_id, payload, created_at, acked_at) VALUES (?, ?, ?, ?, NULL)",
);
const setMeta = db.prepare(
  "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

const envelope = (readingId) => ({
  schemaVersion: 1,
  readingId,
  siteId: "site_001",
  sourceId: "src_001_sim_panel",
  metric: "voltage.rms",
  capturedAt: "2026-07-26T04:15:30.250Z",
  sample: { kind: "numeric", value: 118.4, unit: "V" },
  origins: ["simulated"],
  derivation: "direct",
});

const commit = db.transaction((n) => {
  for (let sequence = 1; sequence <= n; sequence += 1) {
    const readingId = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    insert.run(sequence, readingId, JSON.stringify(envelope(readingId)), 1);
  }
  setMeta.run("last_sequence", n);
});

commit(count);

// Committed. Die without unwinding: no close(), no flush, no atexit.
process.kill(process.pid, "SIGKILL");
