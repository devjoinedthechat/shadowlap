/**
 * What every part of the store shares: the one SQLite connection, the statements prepared once for
 * the calls a recording makes most, transactions, ids, and reading a JSON column. Store (store.ts)
 * holds the connection and those statements, and each part's methods (store/*.ts) read them as the
 * store's own.
 */
import { createRequire } from 'node:module';
import { ulid } from '../ids.js';

/*
 * `node:sqlite` prints an ExperimentalWarning when loaded. Loading it through `require` (not a
 * hoisted `import`) lets us filter that one warning first; every other warning still surfaces.
 */
const originalEmitWarning = process.emitWarning;
process.emitWarning = function patchedEmitWarning(warning: unknown, ...rest: unknown[]): void {
  const message = typeof warning === 'string' ? warning : (warning as { message?: string } | undefined)?.message;
  if (typeof message === 'string' && message.includes('SQLite is an experimental feature')) return;
  return (originalEmitWarning as (this: NodeJS.Process, ...a: unknown[]) => void).call(process, warning, ...rest);
} as typeof process.emitWarning;
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase };
export { DatabaseSync };

export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
  /** Whether a transaction is open on this connection. */
  readonly isTransaction?: boolean;
}

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

/**
 * Undoes a failed write's transaction, or with `savepoint` what it did since that savepoint, unless
 * SQLite already undid the whole transaction itself: it does on some errors (a full disk, an I/O
 * error), and a ROLLBACK then fails with "no transaction is active" in place of the error that
 * ended it, which is the one to report.
 */
export function rollBack(db: SqliteDatabase, savepoint?: string): void {
  if (db.isTransaction === false) return;
  if (savepoint === undefined) {
    db.exec('ROLLBACK');
    return;
  }
  db.exec(`ROLLBACK TO ${savepoint}`);
  db.exec(`RELEASE ${savepoint}`);
}

export function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
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
  /** `Store.transaction`. */
  protected abstract transaction<T>(fn: () => T, mode?: 'deferred' | 'immediate'): T;
}
