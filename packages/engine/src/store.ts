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
 * PARTS below, the one list the Store interface, StoreOf and mixIn are made from.
 */
import { Activity } from './store/activity.js';
import { Chaos } from './store/chaos.js';
import { Cleanup } from './store/cleanup.js';
import { inTransaction, prepareStatements, StorePart, type QueuedWrites, type SqliteDatabase, type SqliteStatement, type Statements } from './store/core.js';
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
export type { QueuedWrites, SqlValue } from './store/core.js';
export type { CoverageBehaviour, CoverageNotPacked, CoveragePackMode, CoverageScan, CoverageScanData, StoredCoverageGroup, StoredCoveragePack } from './store/coverage.js';
export type { DecisionRunRow, DecisionSessionRow, NewDecisionSession } from './store/decisions.js';
export type { FixData, FixLink, FixLinkKind, FixStatus, PulledFrom, StepRerun, StoredBlame, StoredFix, StoredRepair, StoredVerdict, VerdictStanding } from './store/fixes.js';
export type { StoredInjectionResult } from './store/injection.js';
export { RECORDING_RUNS_SQL, rowToRun, splitRecordingRuns } from './store/recording.js';
export type { CreateRunInput } from './store/recording.js';
export { noFullTextSearch, SCHEMA_VERSION } from './store/schema.js';
export type { SearchState } from './store/search.js';
export type { TeamFixRow, TeamRunRow, TeamRunState, TeamSyncRow } from './store/team.js';
export type { InjectionGateData, NewTestResult, NewTestSession, TestFailure, TestResult, TestResultData, TestSession } from './store/tests.js';
export type { NewPairsExport, PairsExport, TaskScoreRow } from './store/training.js';

/**
 * The store's parts by name, in the order mixIn (below) puts their methods on Store: the one list the
 * Store interface, StoreOf and mixIn are made from, so a part named here is on all three.
 */
const PARTS = { recording: Recording, search: Search, cleanup: Cleanup, readModels: ReadModels, activity: Activity, fixes: Fixes, tests: Tests, chaos: Chaos, injection: Injection, coverage: Coverage, decisions: Decisions, training: Training, team: Team } as const;

/** The name of one of the store's parts (PARTS): what StoreOf narrows the store by. */
export type StorePartName = keyof typeof PARTS;

/** A part's methods as a caller sees them: its public ones. */
type MethodsOfPart<N extends StorePartName> = Pick<InstanceType<(typeof PARTS)[N]>, keyof InstanceType<(typeof PARTS)[N]>>;

/** The parts' methods in a union, as one type that has them all. */
type AllOf<U> = (U extends unknown ? (u: U) => void : never) extends (all: infer A) => void ? A : never;

/** The methods of the parts named. */
type PartsMethods<N extends StorePartName> = AllOf<{ [K in N]: MethodsOfPart<K> }[N]>;

/**
 * The store as code that uses some of its parts sees it: their methods, and the store's own
 * (transaction, close, schemaVersion). A function that takes a `StoreOf<'recording' | 'fixes'>` says
 * what of the store it reads and writes, and a test can hand it no more than that; any Store is one.
 */
export type StoreOf<N extends StorePartName> = Pick<Store, 'transaction' | 'close' | 'schemaVersion'> & PartsMethods<N>;

// Store's methods that are a part's, from PARTS: their signatures and comments are the part's own,
// where the methods are written.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type -- an interface merged with class Store, as mixIn puts every part in PARTS on Store's prototype when this file loads (and refuses a name defined twice)
export interface Store extends PartsMethods<StorePartName> {}

/**
 * The append-only local store: runs, call events and content-addressed blobs in one SQLite file.
 * Every method is synchronous; SQLite on a local disk is fast enough and it
 * keeps the sidecar's bookkeeping free of interleaving bugs.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- its parts' methods, which the interface above declares, are put on it by mixIn
export class Store {
  private readonly db: SqliteDatabase;
  private readonly stmts: Statements;
  // query's statements (store/read-models.ts), one set per connection.
  private readonly readStatements = new Map<string, SqliteStatement>();
  // Writes queued in this process and not made yet (store/recording.ts, queueWrites).
  private readonly queues = new Set<QueuedWrites>();

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

  /** Has each part delete what it keeps of a run deleted (its onRunDeleted), in the order of PARTS: deleteRun's, in its transaction. */
  private forgetRun(runId: string): void {
    for (const forget of runDeletedHooks) forget.call(this, runId);
  }
}

/** Each part's onRunDeleted (store/core.ts), which mixIn keeps here for forgetRun. */
const runDeletedHooks: Array<(this: Store, runId: string) => void> = [];

mixIn(Object.values(PARTS));

/**
 * Puts each part's methods on Store's prototype, as they are: `this` in them is the store, and a call
 * from one to another goes through the store, as a caller's does, so a view of the store (storeView)
 * that replaces a method is what the others call too. A name two places define stops store.ts
 * loading. A part's onRunDeleted is kept aside instead, for forgetRun: more than one part has one.
 */
function mixIn(parts: ReadonlyArray<abstract new (...args: never[]) => StorePart>): void {
  for (const part of parts) {
    if (Object.getPrototypeOf(part.prototype) !== StorePart.prototype) throw new Error(`${part.name} must extend StorePart`);
    for (const key of Reflect.ownKeys(part.prototype as object)) {
      if (key === 'constructor') continue;
      const method = Object.getOwnPropertyDescriptor(part.prototype, key)!;
      if (key === 'onRunDeleted') {
        runDeletedHooks.push(method.value as (this: Store, runId: string) => void);
        continue;
      }
      if (Object.hasOwn(Store.prototype, key)) throw new Error(`Store.${String(key)} is defined twice`);
      Object.defineProperty(Store.prototype, key, method);
    }
  }
}

/** A method of the store as a view replaces it (storeView): its parameters and its result, with no `this`. */
type Replacement<Method> = Method extends (...args: infer Args) => infer Result ? (this: void, ...args: Args) => Result : never;

/**
 * A view of `store`: the store with the methods in `replaced` in place of its own, as a caller makes
 * one to count what is read (getBlob), to read each blob once (getJson) or to show a run otherwise
 * than it is stored (getRun). Each of the store's other methods runs with `this` the view, and so
 * calls a replacement wherever it calls the method replaced, as every part's method calls another
 * through `this`: getJson reads by getBlob, updateRunMeta and findRun given a whole id read a run by
 * getRun, a deletion and gc ask recordingRuns. A method that reads the same rows itself does not:
 * listRuns, childRuns and findRun given a prefix read runs without getRun. A replacement has no
 * `this`: it reaches the store through the store it closes over, whose own method it calls so, not
 * itself. The view keeps nothing of its own but its replacements: the connection, the statements
 * and the writes queued are the store's, as a part only ever reads its fields through `this`.
 */
export function storeView(store: Store, replaced: { [Name in keyof Store]?: Replacement<Store[Name]> }): Store {
  const view = Object.create(store) as Store;
  for (const [name, method] of Object.entries(replaced)) Object.defineProperty(view, name, { value: method, writable: true, configurable: true });
  return view;
}
