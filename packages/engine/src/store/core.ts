/**
 * What every part of the store shares: the one SQLite connection, the statements prepared once for
 * the calls a recording makes most, transactions, ids, and reading a JSON column. Store (store.ts)
 * holds the connection and those statements, and each part's methods (store/*.ts) read them as the
 * store's own.
 */
import { ulid } from '../ids.js';
import { rollBack, type SqliteDatabase, type SqliteStatement } from '../sqlite.js';

// node:sqlite as the store opens it, its types, and the rollback: the engine's sqlite.ts, which the
// telemetry collector loads too.
export { DatabaseSync, rollBack, type SqliteDatabase, type SqliteStatement } from '../sqlite.js';

/** A value a read model's query binds. */
export type SqlValue = null | number | bigint | string | Uint8Array;

/** How long a write that only keeps a cache (saveRunStats, a batch of the search index) waits for another command's lock before it gives up. */
export const CACHE_WAIT_MS = 100;

/** The statements prepared once, when the store opens: the ones a recording and its readers run most. */
export interface Statements {
  insertRun: SqliteStatement;
  endRun: SqliteStatement;
  setDivergence: SqliteStatement;
  getRun: SqliteStatement;
  findRunByPrefix: SqliteStatement;
  listRuns: SqliteStatement;
  childRuns: SqliteStatement;
  insertBlob: SqliteStatement;
  getBlob: SqliteStatement;
  hasBlob: SqliteStatement;
  insertEvent: SqliteStatement;
  eventsForRun: SqliteStatement;
  maxCallNo: SqliteStatement;
  countCalls: SqliteStatement;
  countAgentCalls: SqliteStatement;
  deleteRun: SqliteStatement;
}

export function prepareStatements(db: SqliteDatabase): Statements {
  return {
    insertRun: db.prepare(
      `INSERT INTO runs (run_id, parent_run_id, mode, status, divergence, command, code_version, started_at, ended_at)
       VALUES (?, ?, ?, 'running', NULL, ?, ?, ?, NULL)`,
    ),
    endRun: db.prepare(`UPDATE runs SET status = ?, ended_at = ? WHERE run_id = ?`),
    setDivergence: db.prepare(`UPDATE runs SET divergence = ? WHERE run_id = ?`),
    getRun: db.prepare(`SELECT * FROM runs WHERE run_id = ?`),
    findRunByPrefix: db.prepare(`SELECT * FROM runs WHERE run_id LIKE ? ORDER BY started_at DESC LIMIT 2`),
    listRuns: db.prepare(`SELECT * FROM runs ORDER BY started_at DESC, run_id DESC LIMIT ?`),
    childRuns: db.prepare(`SELECT * FROM runs WHERE parent_run_id = ? ORDER BY started_at ASC`),
    insertBlob: db.prepare(`INSERT OR IGNORE INTO blobs (hash, codec, size, bytes) VALUES (?, ?, ?, ?)`),
    getBlob: db.prepare(`SELECT codec, size, bytes FROM blobs WHERE hash = ?`),
    hasBlob: db.prepare(`SELECT 1 AS x FROM blobs WHERE hash = ?`),
    insertEvent: db.prepare(
      `INSERT INTO call_events (run_id, call_no, phase, attempt, kind, name, fingerprint, occurrence, origin, effect, request_ref, response_ref, outcome, meta, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    eventsForRun: db.prepare(`SELECT * FROM call_events WHERE run_id = ? ORDER BY call_no ASC, phase DESC, attempt ASC`),
    maxCallNo: db.prepare(`SELECT COALESCE(MAX(call_no), 0) AS n FROM call_events WHERE run_id = ?`),
    countCalls: db.prepare(`SELECT COUNT(*) AS n FROM call_events WHERE run_id = ? AND phase = 'start'`),
    // The agent's calls: every call but a judge check's (scope `shadowlap:judge`, judge-scope.ts),
    // which are counted through their own index (call_events_judge, whose condition this repeats).
    countAgentCalls: db.prepare(
      `SELECT (SELECT COUNT(*) FROM call_events WHERE run_id = ? AND phase = 'start')
            - (SELECT COUNT(*) FROM call_events WHERE run_id = ? AND phase = 'start' AND json_extract(meta, '$.scope') = 'shadowlap:judge') AS n`,
    ),
    deleteRun: db.prepare(`DELETE FROM runs WHERE run_id = ?`),
  };
}

/** Runs `fn` in one transaction on `db`, as `Store.transaction` describes. */
export function inTransaction<T>(db: SqliteDatabase, fn: () => T, mode: 'deferred' | 'immediate' = 'immediate'): T {
  db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    rollBack(db);
    throw err;
  }
}

export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Writes this process has queued for the store and not made yet: the sidecar's (its StoreWriter),
 * which never holds an agent's answer up for another process's lock, and so writes a run's start, its
 * calls and its end later when the store is held. A read or change of a run here first makes what is
 * queued for it (`settle`), so this process always finds what it said of a run already: that it
 * started, the calls it made, that it ended.
 */
export interface QueuedWrites {
  /**
   * Makes every queued write of the run, of its record (`run`: its start, metadata and end) or its
   * calls, or of either, and every write queued before it, waiting for the lock as a write may.
   */
  settle(runId: string, part?: 'run' | 'calls'): void;
}

let lastUlidTime = 0;
/**
 * Monotonic within a process so runs and events created in the same millisecond still sort by
 * creation order. An id made in a burst takes the next millisecond along, and the clock catching up
 * continues after the last one issued rather than from itself, which could sort an id before one
 * made earlier. 80 random bits keep ids unique across processes.
 */
export function ulidNow(): string {
  const now = Date.now();
  lastUlidTime = now > lastUlidTime ? now : lastUlidTime + 1;
  return ulid(lastUlidTime);
}

/**
 * A part of the store: the methods over one feature's tables. A part is never made on its own:
 * Store (store.ts) takes each part's methods as its own, so `this` in them is the store, with the one
 * connection and the statements it prepared, and a method calls another through the store as any
 * caller does. What a part reads of the store is declared here; what it calls of another part, in
 * the part. A part has methods only: what one keeps for as long as the store is open is a field of
 * Store's, which the part declares (as query's statement cache is).
 */
export abstract class StorePart {
  /** The store's connection. */
  protected declare readonly db: SqliteDatabase;
  /** The statements the store prepared on it when it opened. */
  protected declare readonly stmts: Statements;
  /** The writes this process has queued for the store and not made yet, by whoever queued them (Recording.queueWrites). */
  protected declare readonly queues: Set<QueuedWrites>;
  /** `Store.transaction`. */
  protected abstract transaction<T>(fn: () => T, mode?: 'deferred' | 'immediate'): T;
}
