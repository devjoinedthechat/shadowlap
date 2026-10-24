/**
 * Activity: the events table, what a command did that leaves nothing else in the store (events.ts
 * records them), and the change feed, the counters the dashboard compares to tell what to read again.
 */
import { StorePart, ulidNow } from './core.js';

/** One row of the `events` table (v4): something a command did that the runs table doesn't show. */
export interface StoredEvent {
  eventId: string;
  at: number;
  /** Dotted, e.g. `normalizer.added`, `golden.packed`, `fix.applied`. See events.ts. */
  kind: string;
  /** Who did it (resolveAuthor), or null when unknown. */
  actor: string | null;
  runId: string | null;
  /** What else it is about: a fix id, a golden path, a file. */
  ref: string | null;
  data: Record<string, unknown> | null;
}

export type NewStoredEvent = Partial<Pick<StoredEvent, 'eventId' | 'at' | 'actor' | 'runId' | 'ref' | 'data'>> & Pick<StoredEvent, 'kind'>;

export abstract class Activity extends StorePart {
  // ---- activity events (v4) ----

  /** Appends one activity event; returns it as stored. */
  addEvent(input: NewStoredEvent): StoredEvent {
    const event: StoredEvent = {
      eventId: input.eventId ?? ulidNow(),
      at: input.at ?? Date.now(),
      kind: input.kind,
      actor: input.actor ?? null,
      runId: input.runId ?? null,
      ref: input.ref ?? null,
      data: input.data ?? null,
    };
    this.db
      .prepare(`INSERT INTO events (event_id, at, kind, actor, run_id, ref, data) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(event.eventId, event.at, event.kind, event.actor, event.runId, event.ref, event.data === null ? null : JSON.stringify(event.data));
    return event;
  }

  /**
   * Activity events, newest first (then by id, descending). `before` pages back (exclusive); with
   * `beforeId`, the events at exactly `before` whose id sorts before it come too, so a cursor made
   * of the last event's time and id never skips events that share a millisecond. `kinds` keeps only
   * those kinds, `exceptKinds` leaves those out.
   */
  listEvents(options: { limit?: number; before?: number; beforeId?: string; kinds?: string[]; exceptKinds?: string[] } = {}): StoredEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.before !== undefined && options.beforeId !== undefined) {
      where.push('at <= ? AND (at < ? OR event_id < ?)');
      params.push(options.before, options.before, options.beforeId);
    } else if (options.before !== undefined) {
      where.push('at < ?');
      params.push(options.before);
    }
    if (options.kinds?.length) {
      where.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
      params.push(...options.kinds);
    }
    if (options.exceptKinds?.length) {
      where.push(`kind NOT IN (${options.exceptKinds.map(() => '?').join(', ')})`);
      params.push(...options.exceptKinds);
    }
    params.push(Math.max(1, Math.min(10_000, options.limit ?? 100)));
    const rows = this.db.prepare(`SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, event_id DESC LIMIT ?`).all(...params);
    return rows.map((r) => ({
      eventId: String(r.event_id),
      at: Number(r.at),
      kind: String(r.kind),
      actor: r.actor === null ? null : String(r.actor),
      runId: r.run_id === null ? null : String(r.run_id),
      ref: r.ref === null ? null : String(r.ref),
      data: r.data === null ? null : (JSON.parse(String(r.data)) as Record<string, unknown>),
    }));
  }

  // ---- change feed (v4) ----

  /**
   * How many writes each counted table has seen (`runs`, `events`, and any a feature adds), plus
   * `calls`, the newest call event's rowid, which goes up as calls are recorded (deleting a run can
   * lower it, and counts as a write to `runs`). Two readings that differ mean something changed in
   * between. Cheap: one small table and one index lookup.
   */
  changeCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT name, n FROM change_counts`).all()) out[String(r.name)] = Number(r.n);
    out.calls = Number(this.db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM call_events`).get()?.n ?? 0);
    return out;
  }
}
