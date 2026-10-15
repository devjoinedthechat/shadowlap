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

-- v4: training. Preference pairs are read from the attempts blame, verify and --repeat already left
-- here, so nothing is stored for them; what is stored is each time pairs left the machine (an
-- export: how many, the file, when), and each scored attempt of a model on a task. Scoring a model
-- on a task again replaces its rows. No foreign key on run_id: a score outlives its attempt's run.
CREATE TABLE IF NOT EXISTS pair_exports (
  export_id       TEXT    PRIMARY KEY,
  at              INTEGER NOT NULL,
  pairs           INTEGER NOT NULL,
  file            TEXT    NOT NULL,
  format          TEXT    NOT NULL,
  min_confidence  TEXT    NOT NULL,
  left_out        INTEGER NOT NULL DEFAULT 0,
  actor           TEXT,
  data            TEXT
);
CREATE INDEX IF NOT EXISTS pair_exports_at ON pair_exports (at);

CREATE TABLE IF NOT EXISTS task_scores (
  model     TEXT    NOT NULL,
  base_url  TEXT    NOT NULL DEFAULT '',
  golden    TEXT    NOT NULL,
  attempt   INTEGER NOT NULL,
  run_id    TEXT,
  score     REAL    NOT NULL,
  checks    TEXT    NOT NULL,
  spent     REAL    NOT NULL DEFAULT 0,
  via       TEXT,
  session   TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (model, base_url, golden, attempt)
);
`;

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

/** One `shadowlap export pairs` (v4 training): how many pairs left the machine, to which file, and when. */
export interface PairsExport {
  exportId: string;
  at: number;
  pairs: number;
  /** The file written, as given (`pairs.jsonl`), or `-` for standard output. */
  file: string;
  format: string;
  minConfidence: string;
  /** Pairs below the confidence asked for, not written. */
  leftOut: number;
  actor: string | null;
  data: Record<string, unknown> | null;
}

export type NewPairsExport = Pick<PairsExport, 'pairs' | 'file' | 'format' | 'minConfidence'> & Partial<Pick<PairsExport, 'exportId' | 'at' | 'leftOut' | 'actor' | 'data'>>;

/** One scored attempt (v4 training): a model under test, a task (by its golden), and what the checks said. */
export interface TaskScoreRow {
  model: string;
  /** The OpenAI-compatible endpoint the model was asked at, or null for a provider's own API. */
  baseUrl: string | null;
  /** The golden, as the project names it: `goldens/refund-over-limit`. */
  golden: string;
  attempt: number;
  /** The attempt's run, kept in the store like any fork. */
  runId: string | null;
  /** The share of the task's checks the attempt passed, from 0 to 1. */
  score: number;
  checks: Array<{ label: string; ok: boolean; detail: string | null }>;
  /** USD spent on the attempt's live model calls (0 on a model that isn't a paid API). */
  spent: number;
  /** Where the model ran, in words: `Anthropic API`, `Ollama, on this machine`. */
  via: string | null;
  /** The `tasks score` invocation that made it. */
  session: string;
  at: number;
}

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

  // ---- training (v4): pairs exports and task scores ----

  /** Records one pairs export; returns it as stored. */
  addPairsExport(input: NewPairsExport): PairsExport {
    const record: PairsExport = {
      exportId: input.exportId ?? ulidNow(),
      at: input.at ?? Date.now(),
      pairs: input.pairs,
      file: input.file,
      format: input.format,
      minConfidence: input.minConfidence,
      leftOut: input.leftOut ?? 0,
      actor: input.actor ?? null,
      data: input.data ?? null,
    };
    this.db
      .prepare(`INSERT INTO pair_exports (export_id, at, pairs, file, format, min_confidence, left_out, actor, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.exportId, record.at, record.pairs, record.file, record.format, record.minConfidence, record.leftOut, record.actor, record.data === null ? null : JSON.stringify(record.data));
    return record;
  }

  /** Pairs exports, newest first: the first is what "left this machine" last. */
  listPairsExports(limit = 20): PairsExport[] {
    const rows = this.db.prepare(`SELECT * FROM pair_exports ORDER BY at DESC, export_id DESC LIMIT ?`).all(Math.max(1, Math.min(10_000, limit)));
    return rows.map((r) => ({
      exportId: String(r.export_id),
      at: Number(r.at),
      pairs: Number(r.pairs),
      file: String(r.file),
      format: String(r.format),
      minConfidence: String(r.min_confidence),
      leftOut: Number(r.left_out),
      actor: r.actor === null ? null : String(r.actor),
      data: r.data === null ? null : (JSON.parse(String(r.data)) as Record<string, unknown>),
    }));
  }

  /** A model's scores on one task, replacing whatever it scored there before. */
  replaceTaskScores(model: string, baseUrl: string | null, golden: string, rows: Array<Omit<TaskScoreRow, 'model' | 'baseUrl' | 'golden'>>): void {
    const base = baseUrl ?? '';
    this.transaction(() => {
      this.db.prepare(`DELETE FROM task_scores WHERE model = ? AND base_url = ? AND golden = ?`).run(model, base, golden);
      const insert = this.db.prepare(`INSERT INTO task_scores (model, base_url, golden, attempt, run_id, score, checks, spent, via, session, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of rows) insert.run(model, base, golden, r.attempt, r.runId, r.score, JSON.stringify(r.checks), r.spent, r.via, r.session, r.at);
    });
  }

  /** Every scored attempt, by model, task and attempt. */
  listTaskScores(): TaskScoreRow[] {
    return this.db
      .prepare(`SELECT * FROM task_scores ORDER BY model, base_url, golden, attempt`)
      .all()
      .map((r) => ({
        model: String(r.model),
        baseUrl: r.base_url === '' || r.base_url === null ? null : String(r.base_url),
        golden: String(r.golden),
        attempt: Number(r.attempt),
        runId: r.run_id === null ? null : String(r.run_id),
        score: Number(r.score),
        checks: JSON.parse(String(r.checks)) as TaskScoreRow['checks'],
        spent: Number(r.spent),
        via: r.via === null ? null : String(r.via),
        session: String(r.session),
        at: Number(r.at),
      }));
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
