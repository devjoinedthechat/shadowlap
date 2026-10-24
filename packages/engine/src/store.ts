import { Activity } from './store/activity.js';
import { Chaos } from './store/chaos.js';
import { Cleanup } from './store/cleanup.js';
import { Fixes } from './store/fixes.js';
import { inTransaction, parseJsonColumn, prepareStatements, StorePart, ulidNow, type SqliteDatabase, type SqliteStatement, type Statements } from './store/core.js';
import { ReadModels } from './store/read-models.js';
import { Recording } from './store/recording.js';
import { Search } from './store/search.js';
import { Tests } from './store/tests.js';
import { openDatabase, openDatabaseReadOnly, SCHEMA_VERSION, storedSchemaVersion } from './store/schema.js';

export type { NewStoredEvent, StoredEvent } from './store/activity.js';
export type { ChaosResult, ChaosResultData, ChaosSession, ChaosVerdict, NewChaosResult, NewChaosSession } from './store/chaos.js';
export type { SqlValue } from './store/core.js';
export type { FixData, FixLink, FixLinkKind, FixStatus, StoredBlame, StoredFix, StoredRepair, StoredVerdict, VerdictStanding } from './store/fixes.js';
export { RECORDING_RUNS_SQL, rowToRun, splitRecordingRuns } from './store/recording.js';
export type { CreateRunInput } from './store/recording.js';
export type { SearchState } from './store/search.js';
export type { InjectionGateData, NewTestResult, NewTestSession, TestFailure, TestResult, TestResultData, TestSession } from './store/tests.js';
export { noFullTextSearch, SCHEMA_VERSION } from './store/schema.js';

// ---- Decisions: the shapes of the decision tables ----

/** A decisions or migrate session as the store lists it: what changed, over how many runs, and when. */
export interface DecisionSessionRow {
  sessionId: string;
  kind: 'decisions' | 'migrate';
  at: number;
  /** The change in words: `the model claude-haiku-4-5`. */
  change: string;
  runs: number;
  /** Runs with a rank 1 or 2 change. */
  flagged: number;
  actor: string | null;
  revision: string | null;
}

/** One run's part of a session: its rank and changed steps, and its report (a `DecisionRun`) whole. */
export interface DecisionRunRow {
  sessionId: string;
  runId: string;
  golden: string | null;
  rank: number | null;
  changed: number;
  at: number;
  data: Record<string, unknown>;
}

export interface NewDecisionSession extends Omit<DecisionSessionRow, 'runs' | 'flagged'> {
  /** The report without its runs. */
  data: Record<string, unknown>;
  runs: Array<Pick<DecisionRunRow, 'runId' | 'golden' | 'rank' | 'changed' | 'data'>>;
}

// ---- coverage (v4): the shapes of the coverage tables ----

/** One `shadowlap coverage` scan: what it read and what it found. */
export interface CoverageScan {
  scanId: string;
  at: number;
  /** Imported runs read. */
  runs: number;
  groups: number;
  /** Groups no golden covers. */
  uncovered: number;
  /** Goldens read. */
  goldens: number;
  actor: string | null;
  /** The goldens read (by name), the ones that couldn't be (and why), and what the scan packed. */
  data: CoverageScanData | null;
}

export interface CoverageScanData {
  goldens?: string[];
  unreadable?: Array<{ golden: string; error: string }>;
  /** The goldens the \`--pack\` before this scan made, and the behaviours it couldn't pack, with why. */
  packed?: Array<{ key: string; golden: string; runId: string; mode?: CoveragePackMode }>;
  notPacked?: Array<{ key: string; reason: CoverageNotPacked; why: string }>;
}

/** How \`coverage --pack\` packed a behaviour: a golden that replays its capture, or one that forks (\`--fork\`). */
export type CoveragePackMode = 'replay' | 'fork';

/**
 * Why \`coverage --pack\` couldn't pack a behaviour: nothing says what starts the agent (\`no-command\`),
 * the command started it with another first message than production's (\`other-message\`), the agent
 * sends something else now (\`not-reproduced\`: \`--fork\` packs it as the test that the change holds),
 * the agent failed on what production got back (\`agent-error\`), or its runs were deleted (\`gone\`).
 */
export type CoverageNotPacked = 'no-command' | 'other-message' | 'not-reproduced' | 'agent-error' | 'gone';

/** What \`coverage --pack\` last made of a behaviour. */
export interface StoredCoveragePack {
  key: string;
  at: number;
  /** The golden it packed, or null when it couldn't. */
  golden: string | null;
  /** The run packed. */
  runId: string | null;
  /** The imported run it reproduces. */
  from: string | null;
  mode: CoveragePackMode | null;
  reason: CoverageNotPacked | null;
  /** Why it wasn't packed, in a sentence. */
  why: string | null;
  /** The agent's command it ran, and where that came from (\`--\`, or the run that sent the same first request). */
  command: { argv: string[]; from: string } | null;
}

/** A group of imported runs that behave alike, as the last scan left it (coverage.ts `CoverageGroup`, plus what `--pack` made of it). */
export interface StoredCoverageGroup {
  key: string;
  scanId: string;
  behaviour: CoverageBehaviour;
  runs: number;
  runIds: string[];
  sources: string[];
  firstSeen: number;
  lastSeen: number;
  coveredBy: string[];
  nearest: { golden: string; shared: number; differs: { step: number; seen: string | null; golden: string | null } | null } | null;
  /** For a group no golden covers: the command that would reproduce its newest run, and the recording that says so; null when none does. */
  command: { argv: string[]; from: string } | null;
  /** The golden `coverage --pack` made of the group: its name, the run packed, when, and whether it forks. */
  packed: { golden: string; runId: string; at: number; mode?: CoveragePackMode | null } | null;
}

/** coverage.ts `Behaviour`, as stored. */
export interface CoverageBehaviour {
  path: string[];
  writes: string[];
  unknown: string[];
  outcome: string;
}

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

// ---- injection tests: the shape of injection_results ----

/** One `shadowlap injection` of a run, as kept for the dashboard: its counts by verdict, and the report it printed. */
export interface StoredInjectionResult {
  /** `inj-<ulid>`. */
  resultId: string;
  /** The run tested: a recording, a golden's, or a replay (an attempt that obeyed, under --clean). */
  runId: string;
  /** The golden it was, as the project names it (`goldens/refund-flow`), else null. */
  golden: string | null;
  /** The `shadowlap test` session whose injection gate ran it, else null. */
  sessionId: string | null;
  mode: 'plant' | 'clean';
  at: number;
  endedAt: number | null;
  /** Attempts that planted a payload (plant) or replaced the read (clean). */
  attempts: number;
  obeyed: number;
  influenced: number;
  ignored: number;
  inconclusive: number;
  /** plant: obeyed, influenced, ignored or inconclusive; clean: caused, not caused or inconclusive. */
  verdict: string | null;
  actor: string | null;
  /** The report as `shadowlap injection --json` prints it for this run. */
  data: Record<string, unknown>;
}

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
  /** USD spent on the attempt's live model calls (0 on a model that isn't a paid API); its judge checks' are `judgeSpent`. */
  spent: number;
  /**
   * USD its judge checks' calls cost, apart from `spent` (v5): they ask the judge, never the model
   * scored. Null without a judge call, and for a score a v4 build kept, whose `spent` counted them.
   */
  judgeSpent: number | null;
  /** Where the model ran, in words: `Anthropic API`, `Ollama, on this machine`. */
  via: string | null;
  /** The `tasks score` invocation that made it. */
  session: string;
  at: number;
}

// Store's methods that are a part's (mixIn, below): their signatures and comments are the part's own,
// where the methods are written.
export interface Store extends Pick<Recording, keyof Recording>, Pick<Cleanup, keyof Cleanup>, Pick<Search, keyof Search>, Pick<ReadModels, keyof ReadModels>, Pick<Activity, keyof Activity>, Pick<Fixes, keyof Fixes>, Pick<Tests, keyof Tests>, Pick<Chaos, keyof Chaos> {}

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

  // ---- Training (v4): pairs exports and task scores ----

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
  replaceTaskScores(model: string, baseUrl: string | null, golden: string, rows: Array<Omit<TaskScoreRow, 'model' | 'baseUrl' | 'golden' | 'judgeSpent'> & { judgeSpent?: number | null }>): void {
    const base = baseUrl ?? '';
    this.transaction(() => {
      this.db.prepare(`DELETE FROM task_scores WHERE model = ? AND base_url = ? AND golden = ?`).run(model, base, golden);
      const insert = this.db.prepare(`INSERT INTO task_scores (model, base_url, golden, attempt, run_id, score, checks, spent, via, session, at, judge_spent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of rows) insert.run(model, base, golden, r.attempt, r.runId, r.score, JSON.stringify(r.checks), r.spent, r.via, r.session, r.at, r.judgeSpent ?? null);
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
        judgeSpent: r.judge_spent === null || r.judge_spent === undefined ? null : Number(r.judge_spent),
        via: r.via === null ? null : String(r.via),
        session: String(r.session),
        at: Number(r.at),
      }));
  }

  // ---- Decisions: decisions and migrate sessions, and each run's part of one ----

  /** Keeps a session and its runs, in one transaction; a session kept again under its id is replaced. */
  putDecisionSession(s: NewDecisionSession): void {
    const flagged = s.runs.filter((r) => r.rank !== null && r.rank <= 2).length;
    this.transaction(() => {
      this.db.prepare(`DELETE FROM decision_sessions WHERE session_id = ?`).run(s.sessionId);
      this.db
        .prepare(`INSERT INTO decision_sessions (session_id, kind, at, change, runs, flagged, actor, revision, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(s.sessionId, s.kind, s.at, s.change, s.runs.length, flagged, s.actor, s.revision, JSON.stringify(s.data));
      const insert = this.db.prepare(`INSERT OR REPLACE INTO decision_runs (session_id, run_id, position, golden, rank, changed, at, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      s.runs.forEach((r, i) => insert.run(s.sessionId, r.runId, i, r.golden, r.rank, r.changed, s.at, JSON.stringify(r.data)));
    });
  }

  private decisionSessionRow(r: Record<string, unknown>): DecisionSessionRow {
    return {
      sessionId: String(r.session_id),
      kind: r.kind === 'migrate' ? 'migrate' : 'decisions',
      at: Number(r.at),
      change: String(r.change),
      runs: Number(r.runs),
      flagged: Number(r.flagged),
      actor: r.actor === null ? null : String(r.actor),
      revision: r.revision === null ? null : String(r.revision),
    };
  }

  private decisionRunRow(r: Record<string, unknown>): DecisionRunRow {
    return {
      sessionId: String(r.session_id),
      runId: String(r.run_id),
      golden: r.golden === null ? null : String(r.golden),
      rank: r.rank === null ? null : Number(r.rank),
      changed: Number(r.changed),
      at: Number(r.at),
      data: JSON.parse(String(r.data)) as Record<string, unknown>,
    };
  }

  /** A session with its report and its runs in the order it asked them, or null. */
  getDecisionSession(sessionId: string): (DecisionSessionRow & { data: Record<string, unknown>; runRows: DecisionRunRow[] }) | null {
    const row = this.db.prepare(`SELECT * FROM decision_sessions WHERE session_id = ?`).get(sessionId);
    if (!row) return null;
    const runRows = this.db.prepare(`SELECT * FROM decision_runs WHERE session_id = ? ORDER BY position`).all(sessionId).map((r) => this.decisionRunRow(r));
    return { ...this.decisionSessionRow(row), data: JSON.parse(String(row.data)) as Record<string, unknown>, runRows };
  }

  /** Sessions, newest first; `kind` keeps one kind. */
  listDecisionSessions(options: { limit?: number; kind?: 'decisions' | 'migrate' } = {}): DecisionSessionRow[] {
    const limit = Math.max(1, Math.min(10_000, options.limit ?? 50));
    const rows = options.kind
      ? this.db.prepare(`SELECT * FROM decision_sessions WHERE kind = ? ORDER BY at DESC, session_id DESC LIMIT ?`).all(options.kind, limit)
      : this.db.prepare(`SELECT * FROM decision_sessions ORDER BY at DESC, session_id DESC LIMIT ?`).all(limit);
    return rows.map((r) => this.decisionSessionRow(r));
  }

  /** A run's part of each session that asked its model calls again, newest first, with the session's kind and change. */
  decisionsOfRun(runId: string, limit = 20): Array<DecisionRunRow & Pick<DecisionSessionRow, 'kind' | 'change'>> {
    return this.db
      .prepare(`SELECT r.*, s.kind AS kind, s.change AS change FROM decision_runs r JOIN decision_sessions s ON s.session_id = r.session_id WHERE r.run_id = ? ORDER BY r.at DESC, r.session_id DESC LIMIT ?`)
      .all(runId, Math.max(1, Math.min(1000, limit)))
      .map((r) => ({ ...this.decisionRunRow(r), kind: r.kind === 'migrate' ? ('migrate' as const) : ('decisions' as const), change: String(r.change) }));
  }

  /**
   * The judge verdicts every session that asked a run again kept for it, newest first: each side of a
   * step's judge check that got one (`recorded` or `now`), by the digest of the request it answered.
   * The decision diff answers the very same request again from it, for free. Only those values are
   * read out of each session's part of the run, however many sessions there are.
   */
  decisionJudgeVerdicts(runId: string): Array<{ request: string; verdict: 'yes' | 'no'; reason: string }> {
    return this.db
      .prepare(
        `SELECT json_extract(side.value, '$.request') AS request, json_extract(side.value, '$.verdict') AS verdict, json_extract(side.value, '$.reason') AS reason
         FROM decision_runs r,
           json_each(r.data, '$.decisions') step,
           json_each(CASE step.type WHEN 'object' THEN step.value END, '$.judge') j,
           json_each(CASE j.type WHEN 'object' THEN j.value END) side
         WHERE r.run_id = ? AND side.key IN ('recorded', 'now') AND side.type = 'object'
           AND json_extract(side.value, '$.verdict') IN ('yes', 'no') AND json_type(side.value, '$.request') = 'text'
         ORDER BY r.at DESC, r.session_id DESC`,
      )
      .all(runId)
      .map((r) => ({ request: String(r.request), verdict: r.verdict === 'yes' ? ('yes' as const) : ('no' as const), reason: typeof r.reason === 'string' ? r.reason : '' }));
  }

  deleteDecisionSession(sessionId: string): void {
    this.db.prepare(`DELETE FROM decision_sessions WHERE session_id = ?`).run(sessionId);
  }

  // ---- injection tests: shadowlap injection's results ----

  /** Keeps a result, replacing the one under the same id (a test still running writes its row again as attempts end). */
  putInjectionResult(r: StoredInjectionResult): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO injection_results (result_id, run_id, golden, session_id, mode, at, ended_at, attempts, obeyed, influenced, ignored, inconclusive, verdict, actor, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.resultId, r.runId, r.golden, r.sessionId, r.mode, r.at, r.endedAt, r.attempts, r.obeyed, r.influenced, r.ignored, r.inconclusive, r.verdict, r.actor, JSON.stringify(r.data));
  }

  getInjectionResult(resultId: string): StoredInjectionResult | null {
    const row = this.db.prepare(`SELECT * FROM injection_results WHERE result_id = ?`).get(resultId);
    return row ? rowToInjectionResult(row) : null;
  }

  /** Results, newest first: of one run tested, one golden, one test session, or all (`limit`, default 100). */
  listInjectionResults(options: { runId?: string; golden?: string; sessionId?: string; limit?: number } = {}): StoredInjectionResult[] {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [
      ['run_id', options.runId],
      ['golden', options.golden],
      ['session_id', options.sessionId],
    ] as const) {
      if (value === undefined) continue;
      where.push(`${column} = ?`);
      params.push(value);
    }
    params.push(Math.max(1, Math.min(10_000, options.limit ?? 100)));
    return this.db
      .prepare(`SELECT * FROM injection_results ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, result_id DESC LIMIT ?`)
      .all(...params)
      .map(rowToInjectionResult);
  }

  deleteInjectionResult(resultId: string): void {
    this.db.prepare(`DELETE FROM injection_results WHERE result_id = ?`).run(resultId);
  }

  // ---- coverage (v4): what the last `shadowlap coverage` found ----

  /** Keeps a scan and its groups: the groups of the scan before it go. */
  saveCoverageScan(scan: CoverageScan, groups: readonly StoredCoverageGroup[]): void {
    this.transaction(() => {
      this.db
        .prepare(`INSERT INTO coverage_scans (scan_id, at, runs, groups, uncovered, goldens, actor, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(scan.scanId, scan.at, scan.runs, scan.groups, scan.uncovered, scan.goldens, scan.actor, scan.data === null ? null : JSON.stringify(scan.data));
      this.db.prepare(`DELETE FROM coverage_groups`).run();
      const insert = this.db.prepare(
        `INSERT INTO coverage_groups (key, scan_id, behaviour, runs, run_ids, sources, first_seen, last_seen, covered_by, nearest, command, packed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const g of groups) {
        insert.run(g.key, scan.scanId, JSON.stringify(g.behaviour), g.runs, JSON.stringify(g.runIds), JSON.stringify(g.sources), g.firstSeen, g.lastSeen, JSON.stringify(g.coveredBy), g.nearest ? JSON.stringify(g.nearest) : null, g.command ? JSON.stringify(g.command) : null, g.packed ? JSON.stringify(g.packed) : null);
      }
    });
  }

  /** Keeps what \`coverage --pack\` made of a behaviour, replacing what it made of it before. */
  saveCoveragePack(p: StoredCoveragePack): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO coverage_packs (key, at, golden, run_id, from_run, mode, reason, why, command) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.key, p.at, p.golden, p.runId, p.from, p.mode, p.reason, p.why, p.command ? JSON.stringify(p.command) : null);
  }

  /** What \`coverage --pack\` last made of each behaviour it tried, newest first. */
  coveragePacks(): StoredCoveragePack[] {
    return this.db
      .prepare(`SELECT * FROM coverage_packs ORDER BY at DESC, key ASC`)
      .all()
      .map((r) => ({
        key: String(r.key),
        at: Number(r.at),
        golden: r.golden === null ? null : String(r.golden),
        runId: r.run_id === null ? null : String(r.run_id),
        from: r.from_run === null ? null : String(r.from_run),
        mode: r.mode === null ? null : (String(r.mode) as CoveragePackMode),
        reason: r.reason === null ? null : (String(r.reason) as CoverageNotPacked),
        why: r.why === null ? null : String(r.why),
        command: parseJsonColumn<StoredCoveragePack['command']>(r.command, null),
      }));
  }

  /** The newest scans, newest first. */
  listCoverageScans(limit = 20): CoverageScan[] {
    return this.db
      .prepare(`SELECT * FROM coverage_scans ORDER BY at DESC, scan_id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(1000, limit)))
      .map((r) => ({
        scanId: String(r.scan_id),
        at: Number(r.at),
        runs: Number(r.runs),
        groups: Number(r.groups),
        uncovered: Number(r.uncovered),
        goldens: Number(r.goldens),
        actor: r.actor === null ? null : String(r.actor),
        data: r.data === null ? null : (JSON.parse(String(r.data)) as CoverageScanData),
      }));
  }

  /** The groups of the last scan: not covered first, as the scan ordered them. */
  coverageGroups(): StoredCoverageGroup[] {
    const parse = <T>(v: unknown, fallback: T): T => (v === null || v === undefined ? fallback : (JSON.parse(String(v)) as T));
    return this.db
      .prepare(`SELECT * FROM coverage_groups ORDER BY rowid ASC`)
      .all()
      .map((r) => ({
        key: String(r.key),
        scanId: String(r.scan_id),
        behaviour: parse<CoverageBehaviour>(r.behaviour, { path: [], writes: [], unknown: [], outcome: 'answered' }),
        runs: Number(r.runs),
        runIds: parse<string[]>(r.run_ids, []),
        sources: parse<string[]>(r.sources, []),
        firstSeen: Number(r.first_seen),
        lastSeen: Number(r.last_seen),
        coveredBy: parse<string[]>(r.covered_by, []),
        nearest: parse<StoredCoverageGroup['nearest']>(r.nearest, null),
        command: parse<StoredCoverageGroup['command']>(r.command, null),
        packed: parse<StoredCoverageGroup['packed']>(r.packed, null),
      }));
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

mixIn([Recording, Cleanup, Search, ReadModels, Activity, Fixes, Tests, Chaos]);

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

function rowToInjectionResult(row: Record<string, unknown>): StoredInjectionResult {
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    resultId: String(row.result_id),
    runId: String(row.run_id),
    golden: str(row.golden),
    sessionId: str(row.session_id),
    mode: row.mode === 'clean' ? 'clean' : 'plant',
    at: Number(row.at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    attempts: Number(row.attempts),
    obeyed: Number(row.obeyed),
    influenced: Number(row.influenced),
    ignored: Number(row.ignored),
    inconclusive: Number(row.inconclusive),
    verdict: str(row.verdict),
    actor: str(row.actor),
    data: parseJsonColumn<Record<string, unknown>>(row.data, {}),
  };
}

