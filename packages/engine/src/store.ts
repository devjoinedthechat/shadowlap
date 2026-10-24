import { Activity } from './store/activity.js';
import { Chaos } from './store/chaos.js';
import { Cleanup } from './store/cleanup.js';
import { Coverage } from './store/coverage.js';
import { Decisions } from './store/decisions.js';
import { Fixes } from './store/fixes.js';
import { Injection } from './store/injection.js';
import { inTransaction, parseJsonColumn, prepareStatements, StorePart, ulidNow, type SqliteDatabase, type SqliteStatement, type Statements } from './store/core.js';
import { ReadModels } from './store/read-models.js';
import { Recording } from './store/recording.js';
import { Search } from './store/search.js';
import { Tests } from './store/tests.js';
import { Training } from './store/training.js';
import { openDatabase, openDatabaseReadOnly, SCHEMA_VERSION, storedSchemaVersion } from './store/schema.js';

export type { NewStoredEvent, StoredEvent } from './store/activity.js';
export type { ChaosResult, ChaosResultData, ChaosSession, ChaosVerdict, NewChaosResult, NewChaosSession } from './store/chaos.js';
export type { SqlValue } from './store/core.js';
export type { DecisionRunRow, DecisionSessionRow, NewDecisionSession } from './store/decisions.js';
export type { CoverageBehaviour, CoverageNotPacked, CoveragePackMode, CoverageScan, CoverageScanData, StoredCoverageGroup, StoredCoveragePack } from './store/coverage.js';
export type { FixData, FixLink, FixLinkKind, FixStatus, StoredBlame, StoredFix, StoredRepair, StoredVerdict, VerdictStanding } from './store/fixes.js';
export type { StoredInjectionResult } from './store/injection.js';
export { RECORDING_RUNS_SQL, rowToRun, splitRecordingRuns } from './store/recording.js';
export type { CreateRunInput } from './store/recording.js';
export type { SearchState } from './store/search.js';
export type { NewPairsExport, PairsExport, TaskScoreRow } from './store/training.js';
export type { InjectionGateData, NewTestResult, NewTestSession, TestFailure, TestResult, TestResultData, TestSession } from './store/tests.js';
export { noFullTextSearch, SCHEMA_VERSION } from './store/schema.js';

// ---- Team store (v4): the shapes of the team tables ----

/** How a run stands with the team store (v4 team_runs). */
export type TeamRunState = 'queued' | 'pushed' | 'pulled' | 'listed';

/** One row of team_runs: a run in the project's bucket, or on its way there. */
export interface TeamRunRow {
  runId: string;
  state: TeamRunState;
  /** When it was last synced (or queued), ms. */
  at: number;
  /** The run's shared metadata as of the last sync: the base of a three-way merge. */
  base: Record<string, unknown> | null;
  baseHash: string | null;
  /** The metadata hash the bucket's index last gave for it. */
  remoteHash: string | null;
  /** The bucket's index entry for it: who made it, when, its status, labels and calls. */
  entry: Record<string, unknown> | null;
}

/** A fix this machine and the store last agreed on (v4 team_fixes). */
export interface TeamFixRow {
  fixId: string;
  /** The hash of the fix as both sides last had it. */
  hash: string;
  /** The version (ETag, generation) of the store's object last read or written. */
  version: string | null;
  at: number;
}

/** When this machine last pushed to and pulled from a store, and what setup recorded about it. */
export interface TeamSyncRow {
  pushedAt: number | null;
  pulledAt: number | null;
  data: Record<string, unknown>;
}

// Store's methods that are a part's (mixIn, below): their signatures and comments are the part's own,
// where the methods are written.
export interface Store extends Pick<Recording, keyof Recording>, Pick<Cleanup, keyof Cleanup>, Pick<Search, keyof Search>, Pick<ReadModels, keyof ReadModels>, Pick<Activity, keyof Activity>, Pick<Fixes, keyof Fixes>, Pick<Tests, keyof Tests>, Pick<Chaos, keyof Chaos>, Pick<Injection, keyof Injection>, Pick<Coverage, keyof Coverage>, Pick<Decisions, keyof Decisions>, Pick<Training, keyof Training> {}

/**
 * The append-only local store: runs, call events and content-addressed blobs in one SQLite file.
 * Every method is synchronous; SQLite on a local disk is fast enough and it
 * keeps the sidecar's bookkeeping free of interleaving bugs.
 */
export class Store {
  private readonly db: SqliteDatabase;
  private readonly stmts: Statements;
  // query's statements (store/read-models.ts), one set per connection.
  private readonly readStatements = new Map<string, SqliteStatement>();
  private queryOnlyState: SqliteStatement | null = null;

  private constructor(db: SqliteDatabase) {
    this.db = db;
    this.stmts = prepareStatements(db);
  }

  /** The schema version recorded in this store, which is what it was last written under. */
  schemaVersion(): number {
    return storedSchemaVersion(this.db) ?? SCHEMA_VERSION;
  }

  /** Opens (creating if needed) the store at `path`, or an in-memory store for `:memory:`. */
  static open(path: string): Store {
    return new Store(openDatabase(path));
  }

  // ---- read-only connections (the dashboard's read-model threads) ----

  /**
   * Opens an existing store for reading only, as the dashboard's worker threads read it beside the
   * connection that writes: nothing is created or migrated (the writing connection did that when it
   * opened the store), and SQLite refuses any write made through it. In WAL mode a reader never
   * waits for a writer, nor holds one up. A store from a newer Shadowlap is refused, as `open`
   * refuses it.
   */
  static openReadOnly(path: string): Store {
    return new Store(openDatabaseReadOnly(path));
  }

  close(): void {
    this.db.close();
  }

  /**
   * Runs `fn` in one transaction, which takes the write lock first (`immediate`): another process
   * writing waits for this one, then reads what it wrote, and this one waits for it the same way.
   * A deferred transaction that reads before it writes gets "database is locked" at once when
   * another process wrote in between: SQLite won't wait out the busy timeout to turn a read into a
   * write. So `deferred` is only for a transaction that never writes.
   */
  transaction<T>(fn: () => T, mode: 'deferred' | 'immediate' = 'immediate'): T {
    return inTransaction(this.db, fn, mode);
  }

  // ---- Team store (v4): what this machine knows about the project's bucket ----

  teamRun(remote: string, runId: string): TeamRunRow | null {
    const row = this.db.prepare(`SELECT * FROM team_runs WHERE remote = ? AND run_id = ?`).get(remote, runId);
    return row ? rowToTeamRun(row) : null;
  }

  /** Every run this machine knows to be in the store (or queued for it). */
  teamRuns(remote: string): TeamRunRow[] {
    return this.db.prepare(`SELECT * FROM team_runs WHERE remote = ? ORDER BY run_id`).all(remote).map(rowToTeamRun);
  }

  setTeamRun(remote: string, row: TeamRunRow): void {
    this.db
      .prepare(
        `INSERT INTO team_runs (remote, run_id, state, at, base, base_hash, remote_hash, entry) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (remote, run_id) DO UPDATE SET state = excluded.state, at = excluded.at, base = excluded.base, base_hash = excluded.base_hash, remote_hash = excluded.remote_hash, entry = excluded.entry`,
      )
      .run(remote, row.runId, row.state, row.at, row.base === null ? null : JSON.stringify(row.base), row.baseHash, row.remoteHash, row.entry === null ? null : JSON.stringify(row.entry));
  }

  /** Forgets a run the store no longer has (deleted from the bucket), so pulls stop looking for it. */
  deleteTeamRun(remote: string, runId: string): void {
    this.db.prepare(`DELETE FROM team_runs WHERE remote = ? AND run_id = ?`).run(remote, runId);
  }

  /** Which of these blobs are known to be in the store already. */
  knownTeamBlobs(remote: string, hashes: readonly string[]): Set<string> {
    const known = new Set<string>();
    const get = this.db.prepare(`SELECT 1 AS x FROM team_blobs WHERE remote = ? AND hash = ?`);
    for (const h of hashes) if (get.get(remote, h)) known.add(h);
    return known;
  }

  addTeamBlobs(remote: string, hashes: Iterable<string>): void {
    const put = this.db.prepare(`INSERT OR IGNORE INTO team_blobs (remote, hash) VALUES (?, ?)`);
    this.transaction(() => {
      for (const h of hashes) put.run(remote, h);
    });
  }

  /** Index segments of the store already read. */
  seenTeamSegments(remote: string): Set<string> {
    return new Set(this.db.prepare(`SELECT key FROM team_segments WHERE remote = ?`).all(remote).map((r) => String(r.key)));
  }

  addTeamSegments(remote: string, keys: Iterable<string>, at: number = Date.now()): void {
    const put = this.db.prepare(`INSERT OR IGNORE INTO team_segments (remote, key, at) VALUES (?, ?, ?)`);
    this.transaction(() => {
      for (const k of keys) put.run(remote, k, at);
    });
  }

  teamSync(remote: string): TeamSyncRow | null {
    const row = this.db.prepare(`SELECT * FROM team_sync WHERE remote = ?`).get(remote);
    if (!row) return null;
    return { pushedAt: row.pushed_at === null ? null : Number(row.pushed_at), pulledAt: row.pulled_at === null ? null : Number(row.pulled_at), data: typeof row.data === 'string' ? (JSON.parse(row.data) as Record<string, unknown>) : {} };
  }

  /** Records a push, a pull, or setup progress (merged into `data`). */
  setTeamSync(remote: string, patch: { pushedAt?: number; pulledAt?: number; data?: Record<string, unknown> }): void {
    const current = this.teamSync(remote) ?? { pushedAt: null, pulledAt: null, data: {} };
    const next = { pushedAt: patch.pushedAt ?? current.pushedAt, pulledAt: patch.pulledAt ?? current.pulledAt, data: { ...current.data, ...(patch.data ?? {}) } };
    this.db
      .prepare(`INSERT INTO team_sync (remote, pushed_at, pulled_at, data) VALUES (?, ?, ?, ?) ON CONFLICT (remote) DO UPDATE SET pushed_at = excluded.pushed_at, pulled_at = excluded.pulled_at, data = excluded.data`)
      .run(remote, next.pushedAt, next.pulledAt, JSON.stringify(next.data));
  }

  /** The fixes this machine and a store last agreed on, by fix id. */
  teamFixes(remote: string): Map<string, TeamFixRow> {
    const rows = this.db.prepare(`SELECT * FROM team_fixes WHERE remote = ?`).all(remote);
    return new Map(rows.map((r) => [String(r.fix_id), { fixId: String(r.fix_id), hash: String(r.hash), version: r.version === null ? null : String(r.version), at: Number(r.at) }]));
  }

  setTeamFix(remote: string, row: TeamFixRow): void {
    this.db
      .prepare(`INSERT INTO team_fixes (remote, fix_id, hash, version, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (remote, fix_id) DO UPDATE SET hash = excluded.hash, version = excluded.version, at = excluded.at`)
      .run(remote, row.fixId, row.hash, row.version, row.at);
  }

  /** Marks a repair as one that came with a fix from a store (`remote`): made on another machine. */
  markRepairPulled(remote: string, repairId: string, at: number = Date.now()): void {
    this.db.prepare(`INSERT OR IGNORE INTO team_repairs (repair_id, remote, at) VALUES (?, ?, ?)`).run(repairId, remote, at);
  }

  /** The store a repair came from, and when; null for a repair made on this machine. */
  repairPulled(repairId: string): { remote: string; at: number } | null {
    const row = this.db.prepare(`SELECT remote, at FROM team_repairs WHERE repair_id = ?`).get(repairId);
    return row ? { remote: String(row.remote), at: Number(row.at) } : null;
  }

  /**
   * What this machine knows the store holds, counted in SQL rather than read row by row: runs its
   * index lists (a row not queued, with an index hash, as teamRunInStore in @shadowlap/remote has
   * it), runs queued, each author with their runs, and the CI providers of runs made by `ci`.
   */
  teamSummary(remote: string): { inStore: number; queued: number; authors: Array<{ author: string | null; runs: number }>; ciProviders: string[] } {
    const listed = `remote = ? AND state != 'queued' AND remote_hash IS NOT NULL`;
    const inStore = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM team_runs WHERE ${listed}`).get(remote)?.n ?? 0);
    // Queued and still recording: one that ended since goes with the next push, one deleted goes nowhere.
    const queued = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM team_runs t JOIN runs r ON r.run_id = t.run_id WHERE t.remote = ? AND t.state = 'queued' AND r.status = 'running'`).get(remote)?.n ?? 0);
    const authors = this.db
      .prepare(`SELECT json_extract(entry, '$.author') AS author, COUNT(*) AS n FROM team_runs WHERE ${listed} GROUP BY author ORDER BY author`)
      .all(remote)
      .map((r) => ({ author: typeof r.author === 'string' ? r.author : null, runs: Number(r.n) }));
    const ciProviders = this.db
      .prepare(`SELECT DISTINCT json_extract(entry, '$.ci') AS ci FROM team_runs WHERE ${listed} AND json_extract(entry, '$.author') = 'ci' AND json_extract(entry, '$.ci') IS NOT NULL ORDER BY ci`)
      .all(remote)
      .map((r) => String(r.ci));
    return { inStore, queued, authors, ciProviders };
  }

  /**
   * Runs on this machine the store's index doesn't list, runs still recording and runs pulled from a
   * pull request's folder aside (a push never sends those): how many, and the ids of the newest
   * `limit` of them. The Runs page's `local` tag.
   */
  teamLocalOnly(remote: string, limit: number): { count: number; ids: string[] } {
    const where = `r.status != 'running' AND json_extract(r.meta, '$.imported.pr') IS NULL AND NOT EXISTS (SELECT 1 FROM team_runs t WHERE t.remote = ? AND t.run_id = r.run_id AND t.state != 'queued' AND t.remote_hash IS NOT NULL)`;
    const count = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM runs r WHERE ${where}`).get(remote)?.n ?? 0);
    const ids = this.db
      .prepare(`SELECT r.run_id FROM runs r WHERE ${where} ORDER BY r.started_at DESC, r.run_id DESC LIMIT ?`)
      .all(remote, limit)
      .map((r) => String(r.run_id));
    return { count, ids };
  }
}

mixIn([Recording, Cleanup, Search, ReadModels, Activity, Fixes, Tests, Chaos, Injection, Coverage, Decisions, Training]);

/**
 * Puts each part's methods on Store's prototype, as they are: `this` in them is the store, and a call
 * from one to another goes through the store, as a caller's does, so a view of the store made with
 * Object.create that replaces a method (getBlob, to count what is read) is what the others call too.
 * A name two places define stops store.ts loading.
 */
function mixIn(parts: ReadonlyArray<abstract new (...args: never[]) => StorePart>): void {
  for (const part of parts) {
    if (Object.getPrototypeOf(part.prototype) !== StorePart.prototype) throw new Error(`${part.name} must extend StorePart`);
    for (const key of Reflect.ownKeys(part.prototype)) {
      if (key === 'constructor') continue;
      if (Object.hasOwn(Store.prototype, key)) throw new Error(`Store.${String(key)} is defined twice`);
      Object.defineProperty(Store.prototype, key, Object.getOwnPropertyDescriptor(part.prototype, key)!);
    }
  }
}

// ---- Team store (v4): rows to records ----

function rowToTeamRun(row: Record<string, unknown>): TeamRunRow {
  const json = (v: unknown) => (typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : null);
  return {
    runId: String(row.run_id),
    state: row.state as TeamRunState,
    at: Number(row.at),
    base: json(row.base),
    baseHash: (row.base_hash as string | null) ?? null,
    remoteHash: (row.remote_hash as string | null) ?? null,
    entry: json(row.entry),
  };
}

