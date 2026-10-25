/**
 * The store: one SQLite file holding the runs, their calls and the blobs those reference, and what
 * each feature keeps about them. Store is what every caller opens and holds. It owns the connection,
 * the statements prepared on it and its transactions, and takes its methods from its parts, each the
 * methods over one feature's tables:
 *
 * - store/recording.ts: runs, call events, blobs, the fingerprint cache and the sidecar's writes
 * - store/search.ts: the full-text index
 * - store/cleanup.ts: gc, vacuum, the store's size and what holds a deletion up
 * - store/read-models.ts: what the dashboard reads in SQL, and what it keeps of finished runs
 * - store/activity.ts: activity events and the change feed
 * - store/fixes.ts, tests.ts, chaos.ts, injection.ts, coverage.ts, decisions.ts, training.ts and
 *   team.ts: each feature's tables
 *
 * store/schema.ts holds every table, each feature's in a block of its own, and opens a file at that
 * schema; store/core.ts holds what the parts share. A feature's methods go in its part, and a part in
 * the Store interface and the mixIn below.
 */
import { Activity } from './store/activity.js';
import { Chaos } from './store/chaos.js';
import { Cleanup } from './store/cleanup.js';
import { inTransaction, prepareStatements, StorePart, type SqliteDatabase, type SqliteStatement, type Statements } from './store/core.js';
import { Coverage } from './store/coverage.js';
import { Decisions } from './store/decisions.js';
import { Fixes } from './store/fixes.js';
import { Injection } from './store/injection.js';
import { ReadModels } from './store/read-models.js';
import { Recording } from './store/recording.js';
import { openDatabase, openDatabaseReadOnly, SCHEMA_VERSION, storedSchemaVersion } from './store/schema.js';
import { Search } from './store/search.js';
import { Team } from './store/team.js';
import { Tests } from './store/tests.js';
import { Training } from './store/training.js';

export type { NewStoredEvent, StoredEvent } from './store/activity.js';
export type { ChaosResult, ChaosResultData, ChaosSession, ChaosVerdict, NewChaosResult, NewChaosSession } from './store/chaos.js';
export type { SqlValue } from './store/core.js';
export type { CoverageBehaviour, CoverageNotPacked, CoveragePackMode, CoverageScan, CoverageScanData, StoredCoverageGroup, StoredCoveragePack } from './store/coverage.js';
export type { DecisionRunRow, DecisionSessionRow, NewDecisionSession } from './store/decisions.js';
export type { FixData, FixLink, FixLinkKind, FixStatus, StoredBlame, StoredFix, StoredRepair, StoredVerdict, VerdictStanding } from './store/fixes.js';
export type { StoredInjectionResult } from './store/injection.js';
export { RECORDING_RUNS_SQL, rowToRun, splitRecordingRuns } from './store/recording.js';
export type { CreateRunInput } from './store/recording.js';
export { noFullTextSearch, SCHEMA_VERSION } from './store/schema.js';
export type { SearchState } from './store/search.js';
export type { TeamFixRow, TeamRunRow, TeamRunState, TeamSyncRow } from './store/team.js';
export type { InjectionGateData, NewTestResult, NewTestSession, TestFailure, TestResult, TestResultData, TestSession } from './store/tests.js';
export type { NewPairsExport, PairsExport, TaskScoreRow } from './store/training.js';

// Store's methods that are a part's (mixIn, below): their signatures and comments are the part's own,
// where the methods are written.
export interface Store
  extends Pick<Recording, keyof Recording>,
    Pick<Search, keyof Search>,
    Pick<Cleanup, keyof Cleanup>,
    Pick<ReadModels, keyof ReadModels>,
    Pick<Activity, keyof Activity>,
    Pick<Fixes, keyof Fixes>,
    Pick<Tests, keyof Tests>,
    Pick<Chaos, keyof Chaos>,
    Pick<Injection, keyof Injection>,
    Pick<Coverage, keyof Coverage>,
    Pick<Decisions, keyof Decisions>,
    Pick<Training, keyof Training>,
    Pick<Team, keyof Team> {}

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
}

mixIn([Recording, Search, Cleanup, ReadModels, Activity, Fixes, Tests, Chaos, Injection, Coverage, Decisions, Training, Team]);

/**
 * Puts each part's methods on Store's prototype, as they are: `this` in them is the store, and a call
 * from one to another goes through the store, as a caller's does, so a view of the store made with
 * Object.create that replaces a method (getBlob, to count what is read) is what the others call too.
 * A name two places define stops store.ts loading.
 */
function mixIn(parts: ReadonlyArray<abstract new (...args: never[]) => StorePart>): void {
  for (const part of parts) {
    if (Object.getPrototypeOf(part.prototype) !== StorePart.prototype) throw new Error(`${part.name} must extend StorePart`);
    for (const key of Reflect.ownKeys(part.prototype as object)) {
      if (key === 'constructor') continue;
      if (Object.hasOwn(Store.prototype, key)) throw new Error(`Store.${String(key)} is defined twice`);
      Object.defineProperty(Store.prototype, key, Object.getOwnPropertyDescriptor(part.prototype, key)!);
    }
  }
}
