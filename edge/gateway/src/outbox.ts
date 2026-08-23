import { parseTelemetryEnvelope, type TelemetryEnvelope } from "@pacific-resilience/contracts";
import Database from "better-sqlite3";

/**
 * Durable append-only outbox.
 *
 * The ordering this class exists to guarantee: a reading is committed to disk
 * **before** any transmission is attempted. A reading that exists only in memory
 * is a reading that a power loss deletes — at a site whose defining
 * characteristic is power loss.
 *
 * Durability comes from SQLite transactions and PRAGMA configuration, per ADR
 * 0003. There is no manual `fsync` here and none is promised: `synchronous = FULL`
 * flushes the WAL at each commit, which survives process crash and host power loss
 * to the extent the operating system and storage hardware honour the flush.
 */

/**
 * Exported so that a crash-durability test can apply exactly this schema and these
 * PRAGMAs in a separate process, rather than a hand-copied approximation of them.
 */
export const OUTBOX_SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
  sequence   INTEGER PRIMARY KEY,
  reading_id TEXT NOT NULL UNIQUE,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acked_at   INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS outbox_unacked ON outbox(sequence) WHERE acked_at IS NULL;

CREATE TABLE IF NOT EXISTS quarantine (
  id               INTEGER PRIMARY KEY,
  from_sequence    INTEGER NOT NULL,
  through_sequence INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  reason           TEXT NOT NULL,
  raised_at        INTEGER NOT NULL,
  released_at      INTEGER,
  released_by      TEXT,
  release_note     TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS quarantine_active ON quarantine(id) WHERE released_at IS NULL;
`;

/**
 * ADR 0003. `synchronous = FULL` on the outbox because, unlike the server store, it
 * cannot be re-created from anywhere if it is lost.
 */
export const OUTBOX_PRAGMAS: readonly string[] = [
  "journal_mode = WAL",
  "synchronous = FULL",
  "busy_timeout = 5000",
  "foreign_keys = ON",
];

export const META_LAST_SEQUENCE = "last_sequence";
export const META_ACKED_THROUGH = "acked_through";
const META_DROPPED = "dropped_readings";
const META_RECLAIMED = "reclaimed_readings";

export type OutboxOptions = {
  /** File path. Durability is the point, so `:memory:` is rejected. */
  readonly path: string;
  /** Hard cap on stored readings. Reached, the outbox refuses rather than discards. */
  readonly maxReadings: number;
  /** Injectable for deterministic tests. */
  readonly now?: () => number;
};

export type OutboxRow = {
  readonly sequence: number;
  readonly readingId: string;
  readonly envelope: TelemetryEnvelope;
};

export type AppendResult =
  | {
      readonly kind: "appended";
      readonly count: number;
      readonly sequenceStart: number;
      readonly sequenceEnd: number;
      /** Acknowledged rows deleted to make room for this tick. Usually zero. */
      readonly reclaimed: number;
    }
  | {
      readonly kind: "refused";
      readonly reason: "at_capacity";
      readonly refused: number;
      readonly droppedTotal: number;
      /** Acknowledged rows deleted while trying to make room. */
      readonly reclaimed: number;
    };

/** Why a range is being held. Both causes hold; neither discards. */
export type QuarantineKind = "permanent" | "protocol_violation";

export type QuarantineRecord = {
  readonly id: number;
  readonly fromSequence: number;
  readonly throughSequence: number;
  readonly kind: QuarantineKind;
  readonly reason: string;
  readonly raisedAt: number;
  readonly releasedAt?: number;
  readonly releasedBy?: string;
  readonly releaseNote?: string;
};

/** An active hold, with the age an operator dashboard needs. */
export type ActiveQuarantine = QuarantineRecord & { readonly ageMs: number };

export type QuarantineStatus = {
  readonly active?: ActiveQuarantine;
  readonly raisedTotal: number;
  readonly releasedTotal: number;
};

export type ReleaseRequest = {
  /**
   * The `fromSequence` the operator believes they are releasing.
   *
   * Compare-and-set, not decoration. Quarantine state is durable and outlives the
   * session that read it, so a decision taken against one hold must not silently
   * release a different one that was raised in the meantime.
   */
  readonly expectedFromSequence: number;
  /** Who authorised this. Recorded; a release is never anonymous. */
  readonly operator: string;
  /** What was done about the cause. Recorded for the next person to read. */
  readonly note: string;
};

export type ReleaseOutcome =
  | { readonly kind: "released"; readonly record: QuarantineRecord }
  | { readonly kind: "none_active" }
  | {
      readonly kind: "stale";
      readonly expectedFromSequence: number;
      readonly active: ActiveQuarantine;
    };

export type AckOutcome =
  | { readonly kind: "advanced"; readonly ackedThrough: number; readonly marked: number }
  | { readonly kind: "unchanged"; readonly ackedThrough: number }
  | {
      readonly kind: "refused";
      readonly reason: "rewind" | "beyond_end" | "gap";
      readonly ackedThrough: number;
      readonly requested: number;
    };

export type OutboxCounts = {
  readonly total: number;
  readonly unacked: number;
  readonly acked: number;
  readonly dropped: number;
  /** Acknowledged rows deleted to make room, cumulative. */
  readonly reclaimed: number;
  readonly lastSequence: number;
  readonly ackedThrough: number;
  readonly quarantinedFrom: number;
};

type Row = { sequence: number; reading_id: string; payload: string };

type QuarantineRow = {
  id: number;
  from_sequence: number;
  through_sequence: number;
  kind: string;
  reason: string;
  raised_at: number;
  released_at: number | null;
  released_by: string | null;
  release_note: string | null;
};

function toQuarantineRecord(row: QuarantineRow): QuarantineRecord {
  return {
    id: row.id,
    fromSequence: row.from_sequence,
    throughSequence: row.through_sequence,
    kind: row.kind as QuarantineKind,
    reason: row.reason,
    raisedAt: row.raised_at,
    ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
    ...(row.released_by === null ? {} : { releasedBy: row.released_by }),
    ...(row.release_note === null ? {} : { releaseNote: row.release_note }),
  };
}

export class Outbox {
  private readonly db: Database.Database;
  private readonly maxReadings: number;
  private readonly now: () => number;

  private constructor(db: Database.Database, maxReadings: number, now: () => number) {
    this.db = db;
    this.maxReadings = maxReadings;
    this.now = now;
  }

  static open(options: OutboxOptions): Outbox {
    if (options.path === ":memory:" || options.path.trim() === "") {
      throw new Error("the outbox must be backed by a file; durability is its purpose");
    }
    if (!Number.isInteger(options.maxReadings) || options.maxReadings <= 0) {
      throw new Error("maxReadings must be a positive integer");
    }

    const db = new Database(options.path);
    for (const pragma of OUTBOX_PRAGMAS) {
      db.pragma(pragma);
    }
    db.exec(OUTBOX_SCHEMA);

    return new Outbox(db, options.maxReadings, options.now ?? (() => Date.now()));
  }

  private meta(key: string): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: number }
      | undefined;
    return row?.value ?? 0;
  }

  private setMeta(key: string, value: number): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /**
   * Commit a tick's readings, durably, before anything is sent.
   *
   * A tick is accepted or refused whole. Splitting one would store part of an
   * observation set and leave the rest to be dropped, which is harder to reason
   * about than a clean refusal.
   */
  append(readings: readonly TelemetryEnvelope[]): AppendResult {
    if (readings.length === 0) {
      throw new Error("append requires at least one reading");
    }
    // Validate before opening a transaction: the outbox must never store a
    // reading that the boundary schema would reject.
    const validated = readings.map((reading) => parseTelemetryEnvelope(reading));
    const createdAt = this.now();

    const run = this.db.transaction((): AppendResult => {
      let reclaimed = 0;
      if (this.countRows() + validated.length > this.maxReadings) {
        /**
         * Reclaim acknowledged rows before considering a refusal.
         *
         * The cap bounds disk, and an acknowledged reading is already safe at the
         * other end — it is history, not backlog. Refusing a *new* observation in
         * order to preserve one that has already been delivered inverts the
         * purpose of the cap, and it is not a rare corner: nothing else in the
         * system prunes, so at the Slice 0 cadence a healthy gateway would reach
         * the cap on delivered rows within the hour and then refuse everything.
         *
         * Only acknowledged rows are eligible, enforced by the SQL rather than by
         * this call site. An unsent reading is never deleted by any path.
         */
        reclaimed = this.deleteAcknowledged(this.meta(META_ACKED_THROUGH));
        if (reclaimed > 0) {
          this.setMeta(META_RECLAIMED, this.meta(META_RECLAIMED) + reclaimed);
        }
      }

      if (this.countRows() + validated.length > this.maxReadings) {
        // Still full, so every row in the way is unacknowledged. Refuse the tick
        // whole and keep them: on a resilience platform the oldest unsent readings
        // are the outage itself.
        const droppedTotal = this.meta(META_DROPPED) + validated.length;
        this.setMeta(META_DROPPED, droppedTotal);
        return {
          kind: "refused",
          reason: "at_capacity",
          refused: validated.length,
          droppedTotal,
          reclaimed,
        };
      }

      // Sequences come from a monotonic counter in `meta`, not from MAX(sequence),
      // so reclaiming acknowledged rows can never cause a sequence to be reused.
      const start = this.meta(META_LAST_SEQUENCE) + 1;
      const insert = this.db.prepare(
        "INSERT INTO outbox (sequence, reading_id, payload, created_at, acked_at) VALUES (?, ?, ?, ?, NULL)",
      );
      for (const [offset, envelope] of validated.entries()) {
        insert.run(start + offset, envelope.readingId, JSON.stringify(envelope), createdAt);
      }
      const end = start + validated.length - 1;
      this.setMeta(META_LAST_SEQUENCE, end);
      return {
        kind: "appended",
        count: validated.length,
        sequenceStart: start,
        sequenceEnd: end,
        reclaimed,
      };
    });

    // IMMEDIATE, not DEFERRED. Every write path here reads state and then writes a
    // decision based on it — the capacity check, the sequence counter, the cursor.
    // A deferred transaction takes no write lock until its first write, so a second
    // process can commit in between and the read becomes stale; SQLite then fails
    // the commit rather than corrupting anything, but the caller sees an exception
    // where waiting for the lock would have simply serialised the two writers.
    return run.immediate();
  }

  /**
   * The next contiguous run of unacknowledged readings, starting immediately after
   * the cursor. Contiguity matters: out-of-order acknowledgement would make the
   * cursor meaningless.
   */
  readContiguousUnacked(limit: number): OutboxRow[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer");
    }
    const cursor = this.ackedThrough();
    const rows = this.db
      .prepare(
        "SELECT sequence, reading_id, payload FROM outbox WHERE acked_at IS NULL AND sequence > ? ORDER BY sequence LIMIT ?",
      )
      .all(cursor, limit) as Row[];

    const contiguous: OutboxRow[] = [];
    let expected = cursor + 1;
    for (const row of rows) {
      if (row.sequence !== expected) {
        break;
      }
      contiguous.push({
        sequence: row.sequence,
        readingId: row.reading_id,
        envelope: JSON.parse(row.payload) as TelemetryEnvelope,
      });
      expected += 1;
    }
    return contiguous;
  }

  /**
   * Advance the cursor, and only through a contiguous prefix.
   *
   * Refuses to rewind, to pass the highest allocated sequence, or to jump a gap.
   * A stuck cursor is a visible failure; skipping is silent loss.
   */
  acknowledgeThrough(sequence: number): AckOutcome {
    if (!Number.isInteger(sequence) || sequence < 0) {
      throw new Error("acknowledged sequence must be a non-negative integer");
    }
    const run = this.db.transaction((): AckOutcome => {
      const cursor = this.meta(META_ACKED_THROUGH);
      if (sequence === cursor) {
        return { kind: "unchanged", ackedThrough: cursor };
      }
      if (sequence < cursor) {
        return { kind: "refused", reason: "rewind", ackedThrough: cursor, requested: sequence };
      }
      if (sequence > this.meta(META_LAST_SEQUENCE)) {
        return { kind: "refused", reason: "beyond_end", ackedThrough: cursor, requested: sequence };
      }

      const present = this.db
        .prepare("SELECT COUNT(*) AS n FROM outbox WHERE sequence > ? AND sequence <= ?")
        .get(cursor, sequence) as { n: number };
      if (present.n !== sequence - cursor) {
        return { kind: "refused", reason: "gap", ackedThrough: cursor, requested: sequence };
      }

      const marked = this.db
        .prepare(
          "UPDATE outbox SET acked_at = ? WHERE sequence > ? AND sequence <= ? AND acked_at IS NULL",
        )
        .run(this.now(), cursor, sequence).changes;
      this.setMeta(META_ACKED_THROUGH, sequence);
      return { kind: "advanced", ackedThrough: sequence, marked };
    });

    return run.immediate();
  }

  ackedThrough(): number {
    return this.meta(META_ACKED_THROUGH);
  }

  // -------------------------------------------------------------------------
  // Quarantine: a hold, and the only way out of it
  //
  // A quarantine stops a range from being resent when resending cannot help — a
  // permanent rejection, or a peer whose acknowledgement could not be trusted. It
  // deliberately has no automatic expiry and no automatic retry: the cause is
  // outside this process, so only something outside this process can clear it.
  //
  // There is exactly one exit, `releaseQuarantine`, and it means *retry this range
  // again*. There is deliberately **no** operation that advances the cursor past a
  // held range. That would be the one cheap-looking fix an operator under pressure
  // would reach for, and it is silent data loss wearing the costume of a recovery
  // tool: the readings would still be in the outbox, marked delivered, never sent.
  // Abandoning observations has to remain a decision someone makes explicitly and
  // records, not a button on the gateway.
  // -------------------------------------------------------------------------

  /**
   * Hold a range, recording why and when.
   *
   * Idempotent while a hold is active, and deliberately keeps the *original*
   * `raisedAt` and reason. Age-of-oldest-hold is the number an operator escalates
   * on, so a repeat raise must not quietly reset the clock and make a day-old
   * problem look new.
   */
  quarantine(request: {
    readonly fromSequence: number;
    readonly throughSequence: number;
    readonly kind: QuarantineKind;
    readonly reason: string;
  }): ActiveQuarantine {
    const { fromSequence, throughSequence, kind, reason } = request;
    if (!Number.isInteger(fromSequence) || fromSequence <= 0) {
      throw new Error("fromSequence must be a positive integer");
    }
    if (!Number.isInteger(throughSequence) || throughSequence < fromSequence) {
      throw new Error("throughSequence must be an integer at or above fromSequence");
    }
    if (reason.trim() === "") {
      throw new Error("a quarantine must record why it was raised");
    }

    const run = this.db.transaction((): ActiveQuarantine => {
      const existing = this.activeQuarantineRow();
      if (existing !== undefined) {
        return this.withAge(toQuarantineRecord(existing));
      }
      const raisedAt = this.now();
      const id = Number(
        this.db
          .prepare(
            "INSERT INTO quarantine (from_sequence, through_sequence, kind, reason, raised_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(fromSequence, throughSequence, kind, reason, raisedAt).lastInsertRowid,
      );
      return this.withAge({ id, fromSequence, throughSequence, kind, reason, raisedAt });
    });

    return run.immediate();
  }

  /**
   * Lift the hold so the range is retried, once the cause has been dealt with.
   *
   * Advances nothing and deletes nothing: the next flush re-reads the same rows and
   * resends byte-identical reading ids, so a release is safe even if the operator
   * was wrong about the cause — the worst case is the same quarantine again, with a
   * second entry in the log saying so.
   */
  releaseQuarantine(request: ReleaseRequest): ReleaseOutcome {
    const { expectedFromSequence, operator, note } = request;
    if (!Number.isInteger(expectedFromSequence) || expectedFromSequence <= 0) {
      throw new Error("expectedFromSequence must be a positive integer");
    }
    if (operator.trim() === "") {
      throw new Error("a release must record who authorised it");
    }
    if (note.trim() === "") {
      throw new Error("a release must record what was done about the cause");
    }

    const run = this.db.transaction((): ReleaseOutcome => {
      const row = this.activeQuarantineRow();
      if (row === undefined) {
        return { kind: "none_active" };
      }
      if (row.from_sequence !== expectedFromSequence) {
        // The hold in front of the operator is not the hold they read about. Refuse
        // rather than release something they have not looked at.
        return {
          kind: "stale",
          expectedFromSequence,
          active: this.withAge(toQuarantineRecord(row)),
        };
      }
      const releasedAt = this.now();
      this.db
        .prepare(
          "UPDATE quarantine SET released_at = ?, released_by = ?, release_note = ? WHERE id = ?",
        )
        .run(releasedAt, operator, note, row.id);
      return {
        kind: "released",
        record: toQuarantineRecord({
          ...row,
          released_at: releasedAt,
          released_by: operator,
          release_note: note,
        }),
      };
    });

    return run.immediate();
  }

  activeQuarantine(): ActiveQuarantine | undefined {
    const row = this.activeQuarantineRow();
    return row === undefined ? undefined : this.withAge(toQuarantineRecord(row));
  }

  /** Everything that has ever been held here, newest first. The audit trail. */
  quarantineHistory(limit = 50): QuarantineRecord[] {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive integer");
    }
    return (
      this.db
        .prepare("SELECT * FROM quarantine ORDER BY id DESC LIMIT ?")
        .all(limit) as QuarantineRow[]
    ).map(toQuarantineRecord);
  }

  /** Shaped for a health endpoint: is anything held, for how long, how often. */
  quarantineStatus(): QuarantineStatus {
    const totals = this.db
      .prepare("SELECT COUNT(*) AS raised, COUNT(released_at) AS released FROM quarantine")
      .get() as { raised: number; released: number };
    const active = this.activeQuarantine();
    return {
      ...(active === undefined ? {} : { active }),
      raisedTotal: totals.raised,
      releasedTotal: totals.released,
    };
  }

  /** 0 when nothing is held. Sequence 0 is never allocated, so it cannot collide. */
  quarantinedFrom(): number {
    return this.activeQuarantineRow()?.from_sequence ?? 0;
  }

  private activeQuarantineRow(): QuarantineRow | undefined {
    return this.db
      .prepare("SELECT * FROM quarantine WHERE released_at IS NULL ORDER BY id LIMIT 1")
      .get() as QuarantineRow | undefined;
  }

  private withAge(record: QuarantineRecord): ActiveQuarantine {
    return { ...record, ageMs: Math.max(0, this.now() - record.raisedAt) };
  }

  /**
   * Remove acknowledged rows on request.
   *
   * The guarantee is in the SQL below, not in who calls it: an unacknowledged row
   * cannot be deleted through this method, so neither an operator's retention job
   * nor the capacity reclamation in `append` can lose an unsent reading.
   */
  prune(throughSequence: number): number {
    if (!Number.isInteger(throughSequence) || throughSequence < 0) {
      throw new Error("throughSequence must be a non-negative integer");
    }
    return this.deleteAcknowledged(throughSequence);
  }

  /** The only statement in this class that deletes a reading. */
  private deleteAcknowledged(throughSequence: number): number {
    return this.db
      .prepare("DELETE FROM outbox WHERE acked_at IS NOT NULL AND sequence <= ?")
      .run(throughSequence).changes;
  }

  counts(): OutboxCounts {
    const total = this.countRows();
    const unacked = (
      this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE acked_at IS NULL").get() as {
        n: number;
      }
    ).n;
    return {
      total,
      unacked,
      acked: total - unacked,
      dropped: this.meta(META_DROPPED),
      reclaimed: this.meta(META_RECLAIMED),
      lastSequence: this.meta(META_LAST_SEQUENCE),
      ackedThrough: this.meta(META_ACKED_THROUGH),
      quarantinedFrom: this.quarantinedFrom(),
    };
  }

  private countRows(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n;
  }

  close(): void {
    this.db.close();
  }
}
