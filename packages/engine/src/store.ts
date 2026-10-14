import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { manifestRefs } from './manifest.js';
import { sha256, ulid } from './ids.js';
import type { BlameReport } from './blame.js';
import type { RepairOutcome, RepairReport } from './repair.js';
import type { VerifyOutcome, VerifyReport } from './verify.js';
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

-- v4: Fixes. A fix is one failure, from the blame that reproduced it to a change that held: its
-- title, how runs are grouped into it (the failing run's label, else the check), the check, and
-- whether it is open, verified or applied. A blame creates or joins one; repair and verify link
-- to the fix of the runs they were given. Every blame, verdict and repair report is kept whole.
-- Links and reports name runs by id with no foreign key: a fix outlives a run deleted from the store.
CREATE TABLE IF NOT EXISTS fixes (
  fix_id       TEXT    PRIMARY KEY,
  title        TEXT    NOT NULL,
  group_key    TEXT    NOT NULL,
  label        TEXT,
  check_expect TEXT,
  check_text   TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('open', 'verified', 'applied')),
  opened_at    INTEGER NOT NULL,
  verified_at  INTEGER,
  applied_at   INTEGER,
  data         TEXT
);
CREATE INDEX IF NOT EXISTS fixes_group ON fixes (group_key);
CREATE TABLE IF NOT EXISTS fix_links (
  fix_id  TEXT    NOT NULL REFERENCES fixes(fix_id) ON DELETE CASCADE,
  kind    TEXT    NOT NULL CHECK (kind IN ('failing', 'good', 'blame', 'repair', 'verify')),
  ref     TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (fix_id, kind, ref)
);
CREATE INDEX IF NOT EXISTS fix_links_ref ON fix_links (ref, kind);
CREATE TABLE IF NOT EXISTS blames (
  blame_id  TEXT    PRIMARY KEY,
  run_id    TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  outcome   TEXT    NOT NULL,
  record    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS blames_run ON blames (run_id, at);
CREATE TABLE IF NOT EXISTS verdicts (
  verify_id  TEXT    PRIMARY KEY,
  at         INTEGER NOT NULL,
  verdict    TEXT    NOT NULL CHECK (verdict IN ('accepted', 'rejected', 'incomplete')),
  repair_id  TEXT,
  record     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS verdicts_at ON verdicts (at);
CREATE TABLE IF NOT EXISTS repairs (
  repair_id  TEXT    PRIMARY KEY,
  at         INTEGER NOT NULL,
  dir        TEXT    NOT NULL,
  outcome    TEXT    NOT NULL,
  accepted   INTEGER NOT NULL,
  record     TEXT    NOT NULL
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

// ---- Fixes (v4): the rows of the fixes, fix_links, blames, verdicts and repairs tables. fixes.ts
// decides what goes in them; these are only their shapes.

export type FixStatus = 'open' | 'verified' | 'applied';
export type FixLinkKind = 'failing' | 'good' | 'blame' | 'repair' | 'verify';

/** One failure, from the blame that reproduced it to a change that held. */
export interface StoredFix {
  /** `fx-<ulid>`. */
  fixId: string;
  title: string;
  /** What groups runs into it: `label:<name>` (the failing run's label) or `check:<canonical --expect>`. */
  groupKey: string;
  /** The label it groups by, or null when it groups by its check. */
  label: string | null;
  /** The check a run passes: the `--expect` JSON as given (null for the exit code alone), and in words. */
  check: { expect: unknown; text: string };
  status: FixStatus;
  openedAt: number;
  verifiedAt: number | null;
  appliedAt: number | null;
  data: FixData;
}

export interface FixData {
  /** Where it came from: a CI provider it was opened under, the pull request a repair opened for it. */
  source?: { ci?: string; pr?: { url: string; number: number | null } };
  /** Who opened it (resolveAuthor). */
  openedBy?: string | null;
  /** Someone gave it a title of their own (`shadowlap fix title`). */
  titleEdited?: boolean;
  /** What `shadowlap fix apply` did. */
  applied?: { patch: 'applied' | 'already' | 'none'; repairId: string | null; goldens: string[]; tests: 'passed' | 'failed' | 'skipped'; by?: string | null };
}

export interface FixLink {
  fixId: string;
  kind: FixLinkKind;
  /** A run id (failing, good), a blame id, a repair id or a verdict id. */
  ref: string;
  at: number;
}

/** One `shadowlap blame`, kept whole: a later blame of the same run doesn't overwrite it, as `meta.blame` is. */
export interface StoredBlame {
  /** `bl-<ulid>`. */
  blameId: string;
  /** The failed run that was blamed. */
  runId: string;
  at: number;
  outcome: BlameReport['outcome'];
  report: BlameReport;
  /** The `--expect` the oracle came from, as given, or null for the exit code alone. */
  expect: unknown;
  /** The scope whose model calls were probed, when blame was limited to one. */
  scope: string | null;
  /** A command that blames the run the same way again. */
  command: string;
}

/** One verdict of `shadowlap verify`, or of the verify a repair ran on the candidate it accepted. */
export interface StoredVerdict {
  /** `vf-<ulid>`. */
  verifyId: string;
  at: number;
  verdict: VerifyOutcome;
  /** The repair whose candidate this verified, and which candidate; null for a verify of the working tree. */
  repairId: string | null;
  candidate: number | null;
  report: VerifyReport;
  expect: unknown;
  command: string;
}

/** One `shadowlap repair`: its report.json, and where its files are. */
export interface StoredRepair {
  /** The name of its directory, `repair-<time>`. */
  repairId: string;
  at: number;
  /** Its directory, relative to the folder the repair ran in: `.shadowlap/repairs/<id>`. */
  dir: string;
  outcome: RepairOutcome;
  accepted: boolean;
  report: RepairReport;
  expect: unknown;
  command: string;
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

  // ---- Fixes (v4): fixes, their links, and the blame, verdict and repair reports behind them ----

  insertFix(fix: StoredFix): void {
    this.db
      .prepare(
        `INSERT INTO fixes (fix_id, title, group_key, label, check_expect, check_text, status, opened_at, verified_at, applied_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(fix.fixId, fix.title, fix.groupKey, fix.label, fix.check.expect === null || fix.check.expect === undefined ? null : JSON.stringify(fix.check.expect), fix.check.text, fix.status, fix.openedAt, fix.verifiedAt, fix.appliedAt, JSON.stringify(fix.data));
  }

  getFix(fixId: string): StoredFix | null {
    const row = this.db.prepare(`SELECT * FROM fixes WHERE fix_id = ?`).get(fixId);
    return row ? rowToFix(row) : null;
  }

  /** Every fix, the most recently opened first. */
  listFixes(): StoredFix[] {
    return this.db.prepare(`SELECT * FROM fixes ORDER BY opened_at DESC, fix_id DESC`).all().map(rowToFix);
  }

  /** The fixes that group runs by `groupKey`, the first opened first. */
  fixesByGroup(groupKey: string): StoredFix[] {
    return this.db.prepare(`SELECT * FROM fixes WHERE group_key = ? ORDER BY opened_at ASC, fix_id ASC`).all(groupKey).map(rowToFix);
  }

  updateFix(fixId: string, patch: Partial<Pick<StoredFix, 'title' | 'status' | 'verifiedAt' | 'appliedAt' | 'data'>>): void {
    const fix = this.getFix(fixId);
    if (!fix) throw new Error(`unknown fix ${fixId}`);
    const next = { ...fix, ...patch };
    this.db
      .prepare(`UPDATE fixes SET title = ?, status = ?, verified_at = ?, applied_at = ?, data = ? WHERE fix_id = ?`)
      .run(next.title, next.status, next.verifiedAt, next.appliedAt, JSON.stringify(next.data), fixId);
  }

  /** Links a run or a report to a fix; linking it again keeps the first link. */
  addFixLink(fixId: string, kind: FixLinkKind, ref: string, at: number = Date.now()): void {
    this.db.prepare(`INSERT OR IGNORE INTO fix_links (fix_id, kind, ref, at) VALUES (?, ?, ?, ?)`).run(fixId, kind, ref, at);
  }

  /** A fix's links, in the order they were made. */
  fixLinks(fixId: string, kind?: FixLinkKind): FixLink[] {
    const rows = kind
      ? this.db.prepare(`SELECT * FROM fix_links WHERE fix_id = ? AND kind = ? ORDER BY at ASC, ref ASC`).all(fixId, kind)
      : this.db.prepare(`SELECT * FROM fix_links WHERE fix_id = ? ORDER BY at ASC, ref ASC`).all(fixId);
    return rows.map(rowToFixLink);
  }

  /** The links to a run or a report, from every fix, in the order they were made. */
  linksTo(ref: string, kind?: FixLinkKind): FixLink[] {
    const rows = kind
      ? this.db.prepare(`SELECT * FROM fix_links WHERE ref = ? AND kind = ? ORDER BY at ASC, fix_id ASC`).all(ref, kind)
      : this.db.prepare(`SELECT * FROM fix_links WHERE ref = ? ORDER BY at ASC, fix_id ASC`).all(ref);
    return rows.map(rowToFixLink);
  }

  /** Every link of one kind, from every fix: what the read models count. */
  allFixLinks(kind: FixLinkKind): FixLink[] {
    return this.db.prepare(`SELECT * FROM fix_links WHERE kind = ? ORDER BY at ASC, fix_id ASC, ref ASC`).all(kind).map(rowToFixLink);
  }

  putBlame(b: StoredBlame): void {
    this.db
      .prepare(`INSERT INTO blames (blame_id, run_id, at, outcome, record) VALUES (?, ?, ?, ?, ?)`)
      .run(b.blameId, b.runId, b.at, b.outcome, JSON.stringify({ report: b.report, expect: b.expect ?? null, scope: b.scope, command: b.command }));
  }

  getBlame(blameId: string): StoredBlame | null {
    const row = this.db.prepare(`SELECT * FROM blames WHERE blame_id = ?`).get(blameId);
    return row ? rowToBlame(row) : null;
  }

  /** The blames of one run, the first made first. */
  blamesOfRun(runId: string): StoredBlame[] {
    return this.db.prepare(`SELECT * FROM blames WHERE run_id = ? ORDER BY at ASC, blame_id ASC`).all(runId).map(rowToBlame);
  }

  /** Every blame, the first made first. */
  listBlames(): StoredBlame[] {
    return this.db.prepare(`SELECT * FROM blames ORDER BY at ASC, blame_id ASC`).all().map(rowToBlame);
  }

  putVerdict(v: StoredVerdict): void {
    this.db
      .prepare(`INSERT INTO verdicts (verify_id, at, verdict, repair_id, record) VALUES (?, ?, ?, ?, ?)`)
      .run(v.verifyId, v.at, v.verdict, v.repairId, JSON.stringify({ report: v.report, candidate: v.candidate, expect: v.expect ?? null, command: v.command }));
  }

  getVerdict(verifyId: string): StoredVerdict | null {
    const row = this.db.prepare(`SELECT * FROM verdicts WHERE verify_id = ?`).get(verifyId);
    return row ? rowToVerdict(row) : null;
  }

  /** Every verdict, the first given first. */
  listVerdicts(): StoredVerdict[] {
    return this.db.prepare(`SELECT * FROM verdicts ORDER BY at ASC, verify_id ASC`).all().map(rowToVerdict);
  }

  putRepair(r: StoredRepair): void {
    this.db
      .prepare(`INSERT INTO repairs (repair_id, at, dir, outcome, accepted, record) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.repairId, r.at, r.dir, r.outcome, r.accepted ? 1 : 0, JSON.stringify({ report: r.report, expect: r.expect ?? null, command: r.command }));
  }

  getRepair(repairId: string): StoredRepair | null {
    const row = this.db.prepare(`SELECT * FROM repairs WHERE repair_id = ?`).get(repairId);
    return row ? rowToRepair(row) : null;
  }

  /** Every repair, the first made first. */
  listRepairs(): StoredRepair[] {
    return this.db.prepare(`SELECT * FROM repairs ORDER BY at ASC, repair_id ASC`).all().map(rowToRepair);
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

// ---- Fixes (v4): rows to records ----

const nullableNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const record = (v: unknown): Record<string, unknown> => {
  const parsed = JSON.parse(String(v)) as unknown;
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
};

function rowToFix(row: Record<string, unknown>): StoredFix {
  return {
    fixId: String(row.fix_id),
    title: String(row.title),
    groupKey: String(row.group_key),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    check: { expect: typeof row.check_expect === 'string' ? (JSON.parse(row.check_expect) as unknown) : null, text: String(row.check_text) },
    status: row.status as FixStatus,
    openedAt: Number(row.opened_at),
    verifiedAt: nullableNumber(row.verified_at),
    appliedAt: nullableNumber(row.applied_at),
    data: typeof row.data === 'string' ? (record(row.data) as FixData) : {},
  };
}

function rowToFixLink(row: Record<string, unknown>): FixLink {
  return { fixId: String(row.fix_id), kind: row.kind as FixLinkKind, ref: String(row.ref), at: Number(row.at) };
}

function rowToBlame(row: Record<string, unknown>): StoredBlame {
  const r = record(row.record);
  return {
    blameId: String(row.blame_id),
    runId: String(row.run_id),
    at: Number(row.at),
    outcome: row.outcome as StoredBlame['outcome'],
    report: r.report as BlameReport,
    expect: r.expect ?? null,
    scope: typeof r.scope === 'string' ? r.scope : null,
    command: typeof r.command === 'string' ? r.command : '',
  };
}

function rowToVerdict(row: Record<string, unknown>): StoredVerdict {
  const r = record(row.record);
  return {
    verifyId: String(row.verify_id),
    at: Number(row.at),
    verdict: row.verdict as VerifyOutcome,
    repairId: row.repair_id === null || row.repair_id === undefined ? null : String(row.repair_id),
    candidate: typeof r.candidate === 'number' ? r.candidate : null,
    report: r.report as VerifyReport,
    expect: r.expect ?? null,
    command: typeof r.command === 'string' ? r.command : '',
  };
}

function rowToRepair(row: Record<string, unknown>): StoredRepair {
  const r = record(row.record);
  return {
    repairId: String(row.repair_id),
    at: Number(row.at),
    dir: String(row.dir),
    outcome: row.outcome as RepairOutcome,
    accepted: Number(row.accepted) === 1,
    report: r.report as RepairReport,
    expect: r.expect ?? null,
    command: typeof r.command === 'string' ? r.command : '',
  };
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
