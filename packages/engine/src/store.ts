import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { manifestRefs } from './manifest.js';
import { sha256, ulid } from './ids.js';
import type {
  CallEndRow,
  CallKind,
  CallMeta,
  CallRecord,
  CallStartRow,
  DivergenceReport,
  Effect,
  Normalizer,
  Origin,
  Outcome,
  RunCommand,
  RunMeta,
  RunMode,
  RunRecord,
  RunStatus,
} from './types.js';

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
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (path: string) => SqliteDatabase };

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export const SCHEMA_VERSION = 4;
const GZIP_THRESHOLD = 512;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  run_id         TEXT PRIMARY KEY,
  parent_run_id  TEXT REFERENCES runs(run_id) ON DELETE SET NULL,
  mode           TEXT NOT NULL CHECK (mode IN ('record', 'replay')),
  status         TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'crashed')),
  divergence     TEXT,
  command        TEXT NOT NULL,
  code_version   TEXT,
  started_at     INTEGER NOT NULL,
  ended_at       INTEGER
);
CREATE INDEX IF NOT EXISTS runs_parent ON runs (parent_run_id);

CREATE TABLE IF NOT EXISTS call_events (
  run_id        TEXT    NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  call_no       INTEGER NOT NULL,
  phase         TEXT    NOT NULL CHECK (phase IN ('start', 'end')),
  attempt       INTEGER NOT NULL DEFAULT 0,
  kind          TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  fingerprint   TEXT    NOT NULL,
  occurrence    INTEGER NOT NULL,
  origin        TEXT,
  effect        TEXT,
  request_ref   TEXT,
  response_ref  TEXT,
  outcome       TEXT,
  meta          TEXT,
  at            INTEGER NOT NULL,
  PRIMARY KEY (run_id, call_no, phase, attempt)
);
CREATE INDEX IF NOT EXISTS call_events_match ON call_events (run_id, kind, fingerprint, occurrence);

CREATE TABLE IF NOT EXISTS blobs (
  hash   TEXT    PRIMARY KEY,
  codec  TEXT    NOT NULL,
  size   INTEGER NOT NULL,
  bytes  BLOB    NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- v4: activity. What a command did that leaves nothing else in the store: a normalizer added, a
-- golden packed, pairs exported, a fix applied. Runs are not repeated here; the activity feed
-- derives their events from the runs table. No foreign key on run_id: an event outlives its run.
CREATE TABLE IF NOT EXISTS events (
  event_id  TEXT    PRIMARY KEY,
  at        INTEGER NOT NULL,
  kind      TEXT    NOT NULL,
  actor     TEXT,
  run_id    TEXT,
  ref       TEXT,
  data      TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);

-- v4: tests. Each shadowlap test session and how each golden did in it, so a golden's history
-- across revisions outlives the runs that gc deletes: no foreign key on run ids. A golden is its
-- pack folder relative to the project (goldens/refund-flow); the runs a session made carry
-- meta.test = { golden, session }.
CREATE TABLE IF NOT EXISTS test_sessions (
  session_id         TEXT    PRIMARY KEY,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  command            TEXT    NOT NULL,
  revision           TEXT,
  passed             INTEGER NOT NULL DEFAULT 0,
  failed             INTEGER NOT NULL DEFAULT 0,
  upstream_requests  INTEGER NOT NULL DEFAULT 0,
  actor              TEXT
);
CREATE INDEX IF NOT EXISTS test_sessions_started ON test_sessions (started_at);

CREATE TABLE IF NOT EXISTS test_results (
  session_id     TEXT    NOT NULL REFERENCES test_sessions(session_id) ON DELETE CASCADE,
  golden         TEXT    NOT NULL,
  at             INTEGER NOT NULL,
  revision       TEXT,
  ok             INTEGER NOT NULL CHECK (ok IN (0, 1)),
  failure        TEXT,
  reason         TEXT,
  run_id         TEXT,
  golden_run_id  TEXT,
  data           TEXT,
  PRIMARY KEY (session_id, golden)
);
CREATE INDEX IF NOT EXISTS test_results_golden ON test_results (golden, at);
`;

// ---- tests (v4): the shapes of the test tables ----

/** One `shadowlap test` session: what ran, at which revision, and how it came out. */
export interface TestSession {
  sessionId: string;
  startedAt: number;
  /** Null while the session runs, or when it never finished. */
  endedAt: number | null;
  /** The command as given, without global options: `['shadowlap', 'test', 'goldens/*']`. */
  command: string[];
  /** The code version it tested (`codeVersion`): a short sha, with `+dirty` for uncommitted changes. */
  revision: string | null;
  passed: number;
  failed: number;
  /** Requests that reached a provider: 0 for goldens that replay offline. */
  upstreamRequests: number;
  /** Who ran it (resolveAuthor). */
  actor: string | null;
}

export type NewTestSession = Partial<Pick<TestSession, 'sessionId' | 'startedAt' | 'revision' | 'actor'>> & Pick<TestSession, 'command'>;

/** Why a golden failed: its replay sent a request the recording doesn't have, a check failed, the agent exited non-zero, it made no calls, or it couldn't run at all. */
export type TestFailure = 'diverged' | 'check' | 'exit' | 'no-calls' | 'error';

/** What a result keeps besides its verdict, for the Tests screen. Every field is optional to readers. */
export interface TestResultData {
  /** `replay` must send the requests it recorded; `fork` may diverge and passes on its checks. */
  mode?: 'replay' | 'fork';
  calls?: { total: number; replayed: number; live: number; blocked: number; stubbed: number };
  upstreamRequests?: number;
  tokensNotRespent?: number;
  /** Input tokens of the run's model requests, cache reads included: what it costs to run live. */
  inputTokens?: number;
  checks?: Array<{ ok: boolean; label: string; detail: string | null }>;
  /** A recording that repeats: attempts run, passed and needed, and each attempt's run. */
  attempts?: { total: number; passed: number; required: number; runs: string[] };
  /**
   * Where the replay diverged; `text` is the report as the CLI prints it. `diff` keeps the first
   * changes, cut short; `entries` is how many there were, and `volatile` what volatileValues() made
   * of all of them, so a reader never judges from the cut-down diff.
   */
  divergence?: {
    type: string;
    callNo: number;
    kind: string;
    name: string;
    replayedBefore: number;
    diff?: Array<{ path: string; op: string; before?: unknown; after?: unknown }>;
    entries?: number;
    hints?: Array<{ message: string; normalizer?: Normalizer }>;
    volatile?: { values: Array<{ path: string; looks: string; op: 'changed' | 'added'; normalizer: Normalizer }>; explainsAll: boolean };
    text: string;
  };
  /** The failure as the CLI printed it under the golden's line. */
  details?: string;
  /** `test --update` re-recorded the golden: the run it replaced, the new one, and its calls. */
  updated?: { from: string | null; to: string; calls: number };
}

/** How one golden did in one session. */
export interface TestResult {
  sessionId: string;
  golden: string;
  at: number;
  revision: string | null;
  ok: boolean;
  failure: TestFailure | null;
  /** One line: why it failed. */
  reason: string | null;
  /** The replay to open: the passing one, or the one that failed. */
  runId: string | null;
  /** The recording that was replayed. */
  goldenRunId: string | null;
  data: TestResultData | null;
}

export type NewTestResult = Partial<Pick<TestResult, 'at' | 'revision' | 'failure' | 'reason' | 'runId' | 'goldenRunId' | 'data'>> & Pick<TestResult, 'sessionId' | 'golden' | 'ok'>;

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

export interface CreateRunInput {
  runId?: string;
  parentRunId?: string | null;
  mode: RunMode;
  command: RunCommand;
  codeVersion?: string | null;
  startedAt?: number;
  meta?: RunMeta;
}

/** Creates a file readable only by its owner, unless something already exists at the path. */
/**
 * The schema version a store records, or null when it has never been stamped (a database this
 * build is about to create, or one from before the key existed). Reads defensively: the `meta`
 * table may not exist yet, and a file that is not a Shadowlap store should fail on the schema
 * itself with a clearer message than this would give.
 */
function storedSchemaVersion(db: SqliteDatabase): number | null {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value?: unknown } | undefined;
    const found = Number(row?.value);
    return Number.isInteger(found) && found > 0 ? found : null;
  } catch {
    return null;
  }
}

function createOnce(path: string, content: string): void {
  try {
    writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
  } catch {
    // it exists (or the directory is read-only, which opening the database reports)
  }
}

/** Takes group and other permissions off a store created by an earlier version. */
function restrictToOwner(path: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const st = lstatSync(file);
      if (st.isFile() && st.uid === process.getuid() && st.mode & 0o077) chmodSync(file, st.mode & 0o700);
    } catch {
      // absent
    }
  }
}

/**
 * The append-only local store: runs, call events and content-addressed blobs in one SQLite file.
 * Every method is synchronous; SQLite on a local disk is fast enough and it
 * keeps the sidecar's bookkeeping free of interleaving bugs.
 */
export class Store {
  private readonly db: SqliteDatabase;
  private readonly stmts: {
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
    deleteRun: SqliteStatement;
  };

  private constructor(db: SqliteDatabase) {
    this.db = db;
    this.stmts = {
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
      deleteRun: db.prepare(`DELETE FROM runs WHERE run_id = ?`),
    };
  }

  /** The schema version recorded in this store, which is what it was last written under. */
  schemaVersion(): number {
    return storedSchemaVersion(this.db) ?? SCHEMA_VERSION;
  }

  /** Opens (creating if needed) the store at `path`, or an in-memory store for `:memory:`. */
  static open(path: string): Store {
    if (path !== ':memory:') {
      const dir = dirname(path);
      // Recordings hold prompts and tool I/O: a new directory is the owner's alone.
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Keep the directory out of git without touching the project's .gitignore. `wx` never follows
      // a symbolic link a checkout could have planted there.
      createOnce(join(dir, '.gitignore'), '*\n');
      // An empty file is a valid new SQLite database; SQLite gives its WAL and shared-memory files
      // the database file's permissions.
      createOnce(path, '');
      restrictToOwner(path);
    }
    const db = new DatabaseSync(path);
    // The CLI, the TUI, the dashboard and test workers may open one store at once; wait for a lock
    // rather than fail. First, because switching a new database to WAL already needs one.
    db.exec('PRAGMA busy_timeout = 10000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA synchronous = NORMAL');
    // Schema and migrations under one write lock: two processes opening the same old store must not
    // both see a column missing and both add it.
    db.exec('BEGIN IMMEDIATE');
    try {
      // A store written by a newer Shadowlap is refused rather than used. Migrations here are
      // additive, so every `CREATE TABLE IF NOT EXISTS` would quietly no-op, the version would be
      // stamped backwards, and the run would be read under assumptions that no longer hold. A
      // recording is the thing people keep; misreading one is worse than not opening it.
      const found = storedSchemaVersion(db);
      if (found !== null && found > SCHEMA_VERSION) {
        throw new Error(
          `${path} was written by a newer Shadowlap (store schema v${found}; this build understands v${SCHEMA_VERSION}). Upgrade Shadowlap, or point --db at another store.`,
        );
      }
      db.exec(SCHEMA);
      // v2: per-run metadata (redaction rules). Additive, so older stores upgrade in place.
      const columns = db.prepare(`PRAGMA table_info(runs)`).all().map((r) => String(r.name));
      if (!columns.includes('meta')) db.exec(`ALTER TABLE runs ADD COLUMN meta TEXT`);
      // v3: full-text search over recorded content, built on demand (search.ts). Additive too.
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(text, run_id UNINDEXED, call_no UNINDEXED, field UNINDEXED, tokenize = 'unicode61')`);
      db.exec(`CREATE TABLE IF NOT EXISTS search_state (run_id TEXT PRIMARY KEY, calls INTEGER NOT NULL, status TEXT NOT NULL)`);
      db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

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

  /** Activity events, newest first. `before` pages back (exclusive); `kinds` filters. */
  listEvents(options: { limit?: number; before?: number; kinds?: string[] } = {}): StoredEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.before !== undefined) {
      where.push('at < ?');
      params.push(options.before);
    }
    if (options.kinds?.length) {
      where.push(`kind IN (${options.kinds.map(() => '?').join(', ')})`);
      params.push(...options.kinds);
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

  // ---- tests (v4): shadowlap test sessions and each golden's result ----

  /** Starts a test session; finishTestSession fills in its totals. */
  startTestSession(input: NewTestSession): TestSession {
    const session: TestSession = {
      sessionId: input.sessionId ?? ulidNow(),
      startedAt: input.startedAt ?? Date.now(),
      endedAt: null,
      command: input.command,
      revision: input.revision ?? null,
      passed: 0,
      failed: 0,
      upstreamRequests: 0,
      actor: input.actor ?? null,
    };
    this.db
      .prepare(`INSERT INTO test_sessions (session_id, started_at, ended_at, command, revision, passed, failed, upstream_requests, actor) VALUES (?, ?, NULL, ?, ?, 0, 0, 0, ?)`)
      .run(session.sessionId, session.startedAt, JSON.stringify(session.command), session.revision, session.actor);
    return session;
  }

  /** Records a session's totals once its goldens have run. */
  finishTestSession(sessionId: string, totals: { passed: number; failed: number; upstreamRequests: number; endedAt?: number }): void {
    this.db
      .prepare(`UPDATE test_sessions SET ended_at = ?, passed = ?, failed = ?, upstream_requests = ? WHERE session_id = ?`)
      .run(totals.endedAt ?? Date.now(), totals.passed, totals.failed, totals.upstreamRequests, sessionId);
  }

  getTestSession(sessionId: string): TestSession | null {
    const row = this.db.prepare(`SELECT * FROM test_sessions WHERE session_id = ?`).get(sessionId);
    return row ? rowToTestSession(row) : null;
  }

  /** Sessions, newest first; `before` pages back (exclusive), `finished` leaves out sessions that never ended. */
  listTestSessions(options: { limit?: number; before?: number; finished?: boolean } = {}): TestSession[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.before !== undefined) {
      where.push('started_at < ?');
      params.push(options.before);
    }
    if (options.finished) where.push('ended_at IS NOT NULL');
    params.push(Math.max(1, Math.min(10_000, options.limit ?? 100)));
    return this.db
      .prepare(`SELECT * FROM test_sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, session_id DESC LIMIT ?`)
      .all(...params)
      .map(rowToTestSession);
  }

  /** Records how one golden did in a session; a second result for the same golden in the same session replaces the first. */
  addTestResult(input: NewTestResult): TestResult {
    const result: TestResult = {
      sessionId: input.sessionId,
      golden: input.golden,
      at: input.at ?? Date.now(),
      revision: input.revision ?? null,
      ok: input.ok,
      failure: input.ok ? null : (input.failure ?? 'error'),
      reason: input.reason ?? null,
      runId: input.runId ?? null,
      goldenRunId: input.goldenRunId ?? null,
      data: input.data ?? null,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO test_results (session_id, golden, at, revision, ok, failure, reason, run_id, golden_run_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(result.sessionId, result.golden, result.at, result.revision, result.ok ? 1 : 0, result.failure, result.reason, result.runId, result.goldenRunId, result.data === null ? null : JSON.stringify(result.data));
    return result;
  }

  /** Results, newest first: of one session or several, of one golden, or of every session (`limit`, default 1000). */
  listTestResults(options: { sessionId?: string; sessionIds?: readonly string[]; golden?: string; since?: number; limit?: number } = {}): TestResult[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.sessionId !== undefined) {
      where.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.sessionIds !== undefined) {
      if (!options.sessionIds.length) return [];
      where.push(`session_id IN (${options.sessionIds.map(() => '?').join(', ')})`);
      params.push(...options.sessionIds);
    }
    if (options.golden !== undefined) {
      where.push('golden = ?');
      params.push(options.golden);
    }
    if (options.since !== undefined) {
      where.push('at >= ?');
      params.push(options.since);
    }
    params.push(Math.max(1, Math.min(100_000, options.limit ?? 1000)));
    return this.db
      .prepare(`SELECT * FROM test_results ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, session_id DESC, golden ASC LIMIT ?`)
      .all(...params)
      .map(rowToTestResult);
  }

  /** The newest result of each golden, at or before `until` when given: one row per golden, newest first. */
  latestTestResults(options: { until?: number } = {}): TestResult[] {
    const where = options.until !== undefined ? 'WHERE at <= ?' : '';
    return this.db
      .prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY golden ORDER BY at DESC, session_id DESC) AS n FROM test_results ${where}) WHERE n = 1 ORDER BY at DESC, golden ASC`)
      .all(...(options.until !== undefined ? [options.until] : []))
      .map(rowToTestResult);
  }

  /** The runs `shadowlap test` made for these goldens (`meta.test.golden`), newest first. */
  testReplays(goldens: readonly string[]): RunRecord[] {
    if (!goldens.length) return [];
    return this.db
      .prepare(`SELECT * FROM runs WHERE json_extract(meta, '$.test.golden') IN (${goldens.map(() => '?').join(', ')}) ORDER BY started_at DESC, run_id DESC`)
      .all(...goldens)
      .map(rowToRun);
  }

  /**
   * The revisions runs were made at (their code version), newest first: when each was last seen,
   * how many runs ended there and how many of those failed (a non-zero exit, a crash, or a failed
   * check). `argv` counts only runs of that command, `before` only runs started before it. Blame's
   * probes and verify's attempts are left out: they ran with a change of their own. Bisect offers
   * these as commits where a run still worked.
   */
  runRevisions(options: { argv?: readonly string[]; before?: number; limit?: number } = {}): Array<{ revision: string; lastAt: number; runs: number; failed: number }> {
    const where = [`code_version IS NOT NULL`, `status <> 'running'`, `json_extract(meta, '$.probe') IS NULL`, `json_extract(meta, '$.verify') IS NULL`];
    const params: unknown[] = [];
    if (options.argv) {
      where.push(`json_extract(command, '$.argv') = json(?)`);
      params.push(JSON.stringify(options.argv));
    }
    if (options.before !== undefined) {
      where.push('started_at < ?');
      params.push(options.before);
    }
    params.push(Math.max(1, Math.min(1000, options.limit ?? 50)));
    const failed = `status IN ('failed', 'crashed') OR EXISTS (SELECT 1 FROM json_each(meta, '$.checks') WHERE json_extract(value, '$.ok') = 0)`;
    return this.db
      .prepare(`SELECT code_version, MAX(started_at) AS last_at, COUNT(*) AS runs, SUM(CASE WHEN ${failed} THEN 1 ELSE 0 END) AS failed FROM runs WHERE ${where.join(' AND ')} GROUP BY code_version ORDER BY last_at DESC, code_version ASC LIMIT ?`)
      .all(...params)
      .map((row) => ({ revision: String(row.code_version), lastAt: Number(row.last_at), runs: Number(row.runs), failed: Number(row.failed) }));
  }

  // ---- runs ----

  createRun(input: CreateRunInput): RunRecord {
    const run: RunRecord = {
      runId: input.runId ?? ulidNow(),
      parentRunId: input.parentRunId ?? null,
      mode: input.mode,
      status: 'running',
      divergence: null,
      command: input.command,
      codeVersion: input.codeVersion ?? null,
      startedAt: input.startedAt ?? Date.now(),
      endedAt: null,
      ...(input.meta ? { meta: input.meta } : {}),
    };
    this.stmts.insertRun.run(run.runId, run.parentRunId, run.mode, JSON.stringify(run.command), run.codeVersion, run.startedAt);
    if (input.meta) this.db.prepare(`UPDATE runs SET meta = ? WHERE run_id = ?`).run(JSON.stringify(input.meta), run.runId);
    return run;
  }

  /** Inserts a complete run record as-is (used by unpack). A parent that isn't present is kept as a dangling reference. */
  importRun(run: RunRecord): void {
    const parentPresent = run.parentRunId ? this.getRun(run.parentRunId) !== null : false;
    this.db
      .prepare(
        `INSERT INTO runs (run_id, parent_run_id, mode, status, divergence, command, code_version, started_at, ended_at, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.runId,
        parentPresent ? run.parentRunId : null,
        run.mode,
        run.status,
        run.divergence ? JSON.stringify(run.divergence) : null,
        JSON.stringify(run.command),
        run.codeVersion,
        run.startedAt,
        run.endedAt,
        run.meta ? JSON.stringify(run.meta) : null,
      );
  }

  endRun(runId: string, status: Exclude<RunStatus, 'running'>, endedAt: number = Date.now()): void {
    this.stmts.endRun.run(status, endedAt, runId);
  }

  setDivergence(runId: string, report: DivergenceReport): void {
    this.stmts.setDivergence.run(JSON.stringify(report), runId);
  }

  getRun(runId: string): RunRecord | null {
    const row = this.stmts.getRun.get(runId);
    return row ? rowToRun(row) : null;
  }

  /** Resolves a full run id or a unique prefix (case-insensitive). */
  findRun(idOrPrefix: string): RunRecord | null {
    const exact = this.getRun(idOrPrefix.toUpperCase());
    if (exact) return exact;
    const rows = this.stmts.findRunByPrefix.all(idOrPrefix.toUpperCase().replace(/[%_]/g, '') + '%');
    if (rows.length === 1) return rowToRun(rows[0]!);
    if (rows.length > 1) throw new Error(`run id prefix "${idOrPrefix}" is ambiguous`);
    return null;
  }

  listRuns(limit = 50): RunRecord[] {
    return this.stmts.listRuns.all(limit).map(rowToRun);
  }

  childRuns(runId: string): RunRecord[] {
    return this.stmts.childRuns.all(runId).map(rowToRun);
  }

  /** Merges `patch` into a run's metadata. */
  updateRunMeta(runId: string, patch: Partial<RunMeta>): void {
    const run = this.getRun(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    this.db.prepare(`UPDATE runs SET meta = ? WHERE run_id = ?`).run(JSON.stringify({ ...(run.meta ?? {}), ...patch }), runId);
  }

  deleteRun(runId: string): void {
    this.stmts.deleteRun.run(runId);
    this.db.prepare(`DELETE FROM search_docs WHERE run_id = ?`).run(runId);
    this.db.prepare(`DELETE FROM search_state WHERE run_id = ?`).run(runId);
  }

  /** How much of a run the search index covers: its call count and status when it was indexed. */
  searchState(runId: string): { calls: number; status: string } | null {
    const row = this.db.prepare(`SELECT calls, status FROM search_state WHERE run_id = ?`).get(runId);
    return row ? { calls: Number(row.calls), status: String(row.status) } : null;
  }

  /** Replaces a run's search documents. */
  replaceSearchDocs(runId: string, calls: number, status: string, docs: Array<{ callNo: number; field: string; text: string }>): void {
    this.transaction(() => {
      this.db.prepare(`DELETE FROM search_docs WHERE run_id = ?`).run(runId);
      const insert = this.db.prepare(`INSERT INTO search_docs (text, run_id, call_no, field) VALUES (?, ?, ?, ?)`);
      for (const d of docs) insert.run(d.text, runId, d.callNo, d.field);
      this.db.prepare(`INSERT OR REPLACE INTO search_state (run_id, calls, status) VALUES (?, ?, ?)`).run(runId, calls, status);
    });
  }

  /** Full-text matches, best first. `match` is an FTS5 expression; snippets mark matches with characters 1 and 2. */
  searchDocs(match: string, limit: number, runId?: string): Array<{ runId: string; callNo: number; field: string; snippet: string }> {
    const sql = `SELECT run_id, call_no, field, snippet(search_docs, 0, char(1), char(2), '…', 14) AS snip FROM search_docs WHERE search_docs MATCH ?${runId ? ' AND run_id = ?' : ''} ORDER BY rank LIMIT ?`;
    const rows = this.db.prepare(sql).all(...(runId ? [match, runId, limit] : [match, limit]));
    return rows.map((r) => ({ runId: String(r.run_id), callNo: Number(r.call_no), field: String(r.field), snippet: String(r.snip) }));
  }

  /** Every run, oldest last. */
  allRuns(): RunRecord[] {
    return this.listRuns(Number.MAX_SAFE_INTEGER);
  }

  /**
   * Deletes blobs that no call references (a run's rows go with `deleteRun`; its blobs are shared by
   * content, so they are collected here). Returns what was removed.
   */
  gcBlobs(): { removed: number; bytes: number } {
    const referenced = new Set<string>();
    for (const r of this.db.prepare(`SELECT kind, request_ref, response_ref FROM call_events`).all()) {
      const req = r.request_ref as string | null;
      const res = r.response_ref as string | null;
      if (res) referenced.add(res);
      if (req) {
        referenced.add(req);
        if (r.kind === 'api') for (const h of manifestRefs(this, req)) referenced.add(h);
      }
    }
    const del = this.db.prepare(`DELETE FROM blobs WHERE hash = ?`);
    let removed = 0;
    let bytes = 0;
    this.transaction(() => {
      for (const b of this.db.prepare(`SELECT hash, size FROM blobs`).all()) {
        const hash = String(b.hash);
        if (referenced.has(hash)) continue;
        del.run(hash);
        removed++;
        bytes += Number(b.size);
      }
    });
    return { removed, bytes };
  }

  /** Gives freed pages back to the filesystem. */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  // ---- blobs ----

  /** Stores bytes under their SHA-256 (of the uncompressed content). Idempotent. */
  putBlob(bytes: Uint8Array): string {
    const hash = sha256(bytes);
    if (this.stmts.hasBlob.get(hash)) return hash;
    if (bytes.length > GZIP_THRESHOLD) {
      this.stmts.insertBlob.run(hash, 'gzip', bytes.length, gzipSync(bytes));
    } else {
      this.stmts.insertBlob.run(hash, 'raw', bytes.length, bytes);
    }
    return hash;
  }

  getBlob(hash: string): Buffer | null {
    const row = this.stmts.getBlob.get(hash);
    if (!row) return null;
    const bytes = Buffer.from(row.bytes as Uint8Array);
    return row.codec === 'gzip' ? gunzipSync(bytes) : bytes;
  }

  putJson(value: unknown): string {
    return this.putBlob(Buffer.from(JSON.stringify(value), 'utf8'));
  }

  getJson<T = unknown>(hash: string): T | null {
    const bytes = this.getBlob(hash);
    return bytes === null ? null : (JSON.parse(bytes.toString('utf8')) as T);
  }

  // ---- call events ----

  nextCallNo(runId: string): number {
    const row = this.stmts.maxCallNo.get(runId);
    return Number(row?.n ?? 0) + 1;
  }

  countCalls(runId: string): number {
    return Number(this.stmts.countCalls.get(runId)?.n ?? 0);
  }

  appendCallStart(row: CallStartRow): void {
    this.stmts.insertEvent.run(
      row.runId,
      row.callNo,
      'start',
      0,
      row.kind,
      row.name,
      row.fingerprint,
      row.occurrence,
      row.origin,
      row.effect,
      row.requestRef,
      null,
      null,
      JSON.stringify(row.meta),
      row.at,
    );
  }

  appendCallEnd(identity: Pick<CallStartRow, 'kind' | 'name' | 'fingerprint' | 'occurrence'>, row: CallEndRow): void {
    this.stmts.insertEvent.run(
      row.runId,
      row.callNo,
      'end',
      row.attempt,
      identity.kind,
      identity.name,
      identity.fingerprint,
      identity.occurrence,
      null,
      null,
      null,
      row.responseRef,
      row.outcome,
      JSON.stringify(row.meta),
      row.at,
    );
  }

  /** All calls of a run in arrival order, each with its final end row and earlier attempts. */
  getCalls(runId: string): CallRecord[] {
    const rows = this.stmts.eventsForRun.all(runId);
    const byCall = new Map<number, CallRecord>();
    for (const r of rows) {
      const callNo = Number(r.call_no);
      if (r.phase === 'start') {
        byCall.set(callNo, {
          runId,
          callNo,
          kind: r.kind as CallKind,
          name: String(r.name),
          fingerprint: String(r.fingerprint),
          occurrence: Number(r.occurrence),
          origin: r.origin as Origin,
          effect: (r.effect as Effect | null) ?? null,
          requestRef: (r.request_ref as string | null) ?? null,
          meta: parseMeta(r.meta),
          at: Number(r.at),
          end: null,
          attempts: [],
        });
      } else {
        const call = byCall.get(callNo);
        if (!call) continue; // an end without a start: tolerated, never expected
        const end: CallEndRow = {
          runId,
          callNo,
          attempt: Number(r.attempt),
          responseRef: (r.response_ref as string | null) ?? null,
          outcome: r.outcome as Outcome,
          meta: parseMeta(r.meta),
          at: Number(r.at),
        };
        if (call.end) call.attempts.push(call.end);
        call.end = end;
      }
    }
    return [...byCall.values()].sort((a, b) => a.callNo - b.callNo);
  }
}

function parseMeta(raw: unknown): CallMeta {
  if (typeof raw !== 'string' || raw === '') return {};
  try {
    return JSON.parse(raw) as CallMeta;
  } catch {
    return {};
  }
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  return {
    runId: String(row.run_id),
    parentRunId: (row.parent_run_id as string | null) ?? null,
    mode: row.mode as RunMode,
    status: row.status as RunStatus,
    divergence: typeof row.divergence === 'string' ? (JSON.parse(row.divergence) as DivergenceReport) : null,
    command: JSON.parse(String(row.command)) as RunCommand,
    codeVersion: (row.code_version as string | null) ?? null,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    ...(typeof row.meta === 'string' ? { meta: JSON.parse(row.meta) as RunMeta } : {}),
  };
}

function parseJsonColumn<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToTestSession(row: Record<string, unknown>): TestSession {
  const command = parseJsonColumn<unknown>(row.command, []);
  return {
    sessionId: String(row.session_id),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    command: Array.isArray(command) ? command.map(String) : [],
    revision: row.revision === null || row.revision === undefined ? null : String(row.revision),
    passed: Number(row.passed),
    failed: Number(row.failed),
    upstreamRequests: Number(row.upstream_requests),
    actor: row.actor === null || row.actor === undefined ? null : String(row.actor),
  };
}

function rowToTestResult(row: Record<string, unknown>): TestResult {
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    sessionId: String(row.session_id),
    golden: String(row.golden),
    at: Number(row.at),
    revision: str(row.revision),
    ok: Number(row.ok) === 1,
    failure: str(row.failure) as TestFailure | null,
    reason: str(row.reason),
    runId: str(row.run_id),
    goldenRunId: str(row.golden_run_id),
    data: parseJsonColumn<TestResultData | null>(row.data, null),
  };
}

let lastUlidMs = 0;
let ulidSeq = 0;
/** Monotonic within a process so runs created in the same millisecond still sort by creation order. */
function ulidNow(): string {
  const now = Date.now();
  if (now === lastUlidMs) ulidSeq++;
  else {
    lastUlidMs = now;
    ulidSeq = 0;
  }
  // Bumping the millisecond keeps same-ms ids ordered; 80 random bits keep them unique across processes.
  return ulid(now + ulidSeq);
}
