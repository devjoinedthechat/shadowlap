import { chmodSync, existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { manifestRefs } from './manifest.js';
import { sha256, ulid } from './ids.js';
import type { BlameReport } from './blame.js';
import type { RepairOutcome, RepairReport } from './repair.js';
import type { GateResult } from './stats.js';
import type { VerifyOutcome, VerifyReport } from './verify.js';
import { currentOwner, recorderGone, type RunOwner } from './liveness.js';
import type {
  CallEndRow,
  CallKind,
  CallMeta,
  CallRecord,
  CallStartRow,
  DivergenceReport,
  Effect,
  JudgeSummary,
  Normalizer,
  Origin,
  Outcome,
  RunCommand,
  RunMeta,
  RunMode,
  RunRecord,
  RunStatus,
  StoredCheck,
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
  /** Whether a transaction is open on this connection. */
  readonly isTransaction?: boolean;
}

/** A value a read model's query binds. */
export type SqlValue = null | number | bigint | string | Uint8Array;

export const SCHEMA_VERSION = 5;
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
-- A judge check's calls (scope shadowlap:judge, judge-scope.ts), which are none of the agent's, in an
-- index of their own: a count of a run's calls leaves them out through it instead of reading every
-- call's metadata, which tripled the time the run list took to read. It holds a row per judge call;
-- a store from before it gets it on opening. Its condition reads the scope with json_extract, not
-- ->>: SQLite reads the whole schema before any table, and before 3.38 (the sqlite3 of Ubuntu 22.04
-- and macOS 12, and Python's sqlite3 built on it) it knows no ->>, so none of the store could be read.
CREATE INDEX IF NOT EXISTS call_events_judge ON call_events (run_id) WHERE phase = 'start' AND json_extract(meta, '$.scope') = 'shadowlap:judge';

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

-- v4: change feed. A counter per table that goes up on every write to it, kept by triggers so every
-- writer counts (the CLI, the sidecar, the dashboard): the dashboard compares them to tell the browser
-- what to fetch again. Call events need no counter: their newest rowid goes up as calls arrive. A
-- feature that adds a table counts it the same way: a row here and triggers that bump it.
CREATE TABLE IF NOT EXISTS change_counts (
  name  TEXT    PRIMARY KEY,
  n     INTEGER NOT NULL
);
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('runs', 0), ('events', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_runs_insert AFTER INSERT ON runs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'runs'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_runs_update AFTER UPDATE ON runs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'runs'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_runs_delete AFTER DELETE ON runs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'runs'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_events_insert AFTER INSERT ON events BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'events'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_events_delete AFTER DELETE ON events BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'events'; END;

-- v4: read models. What the dashboard worked out about a finished run's calls (where each answer
-- came from, tokens per model, time not waited, prompt-cache misses), kept so the Overview and the
-- run list read one row per run instead of every call, in this process and the next. \`key\` names
-- what the numbers were worked out from; prices are applied when they are read.
CREATE TABLE IF NOT EXISTS run_stats (
  run_id  TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  stats   TEXT NOT NULL
);

-- v4: Fixes. A fix is one failure, from the blame that reproduced it to a change that held: its
-- title, the labels its failing runs carried when they joined, the check it was blamed under (the
-- --expect as given, its canonical key, and its oracle as labels and in words), and whether it is
-- open, verified or applied. A blame creates or joins one, by label, else by check; repair and
-- verify link to the fix of the runs they were given, and a verify link says whether its verdict
-- counts for the fix. Every blame, verdict and repair report is kept whole. Links and reports name
-- runs by id with no foreign key: a fix outlives a run deleted from the store.
CREATE TABLE IF NOT EXISTS fixes (
  fix_id       TEXT    PRIMARY KEY,
  title        TEXT    NOT NULL,
  labels       TEXT    NOT NULL,
  check_key    TEXT    NOT NULL,
  check_expect TEXT,
  check_oracle TEXT    NOT NULL,
  check_text   TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('open', 'verified', 'applied')),
  opened_at    INTEGER NOT NULL,
  verified_at  INTEGER,
  applied_at   INTEGER,
  data         TEXT
);
CREATE INDEX IF NOT EXISTS fixes_check ON fixes (check_key);
CREATE TABLE IF NOT EXISTS fix_links (
  fix_id  TEXT    NOT NULL REFERENCES fixes(fix_id) ON DELETE CASCADE,
  kind    TEXT    NOT NULL CHECK (kind IN ('failing', 'good', 'blame', 'repair', 'verify')),
  ref     TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  data    TEXT,
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
-- Any write to a fix, its links or the reports behind it moves the 'fixes' counter, whoever makes
-- it (the CLI's blame, repair, fix title or apply, the dashboard, a pull): the Fixes pages follow it.
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('fixes', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_fixes_insert AFTER INSERT ON fixes BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fixes_update AFTER UPDATE ON fixes BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fixes_delete AFTER DELETE ON fixes BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fix_links_insert AFTER INSERT ON fix_links BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fix_links_update AFTER UPDATE ON fix_links BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fix_links_delete AFTER DELETE ON fix_links BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_blames_insert AFTER INSERT ON blames BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_verdicts_insert AFTER INSERT ON verdicts BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_repairs_insert AFTER INSERT ON repairs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;

-- v4: tests. Each shadowlap test session and how each golden did in it, so a golden's history
-- across revisions outlives the runs that gc deletes: no foreign key on run ids. A golden is its
-- pack folder relative to the project (goldens/refund-flow); the runs a session made carry
-- meta.test = { golden, session }. A session stopped by a signal ends with interrupted = 1 and the
-- results of the goldens that finished before it.
CREATE TABLE IF NOT EXISTS test_sessions (
  session_id         TEXT    PRIMARY KEY,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  command            TEXT    NOT NULL,
  revision           TEXT,
  passed             INTEGER NOT NULL DEFAULT 0,
  failed             INTEGER NOT NULL DEFAULT 0,
  upstream_requests  INTEGER NOT NULL DEFAULT 0,
  actor              TEXT,
  interrupted        INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0, 1))
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

-- v4: tests. The process running each test session not ended yet, as run_owners does for runs, so
-- a session still running (in a terminal, from another dashboard) is told from one whose process
-- was killed. The row goes when the session ends or is deleted.
CREATE TABLE IF NOT EXISTS test_session_owners (
  session_id  TEXT    PRIMARY KEY REFERENCES test_sessions(session_id) ON DELETE CASCADE,
  pid         INTEGER NOT NULL,
  host        TEXT    NOT NULL
);

-- v4: settings. The process recording each run still running, so a clean-up can tell a recording
-- from a run whose process was killed. The row goes when its run ends or is deleted.
CREATE TABLE IF NOT EXISTS run_owners (
  run_id  TEXT    PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  pid     INTEGER NOT NULL,
  host    TEXT    NOT NULL
);

-- Training (v4). Preference pairs are read from the attempts blame, verify and --repeat already
-- left here, so nothing is stored for them; what is stored is each time pairs left the machine (an
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
  -- v5: what the attempt's judge checks cost, apart from spent; NULL without a judge call.
  judge_spent REAL,
  PRIMARY KEY (model, base_url, golden, attempt)
);

-- v4: Team store. What this machine knows about the project's bucket (shadowlap push and pull),
-- kept per store URL so pointing the project at another bucket starts afresh. team_runs has a row
-- for every run that is in the bucket or on its way there: queued (still recording, pushed when it
-- ends), pushed, pulled, or only listed in the bucket's index. Its base is the run's labels, notes
-- and other shared metadata as of the last sync, which a three-way merge needs. A run deleted here
-- keeps its row, so a pull doesn't bring it back. team_blobs and team_segments remember the blobs
-- and index segments already known to be in the bucket, so a push uploads only what is new.
CREATE TABLE IF NOT EXISTS team_runs (
  remote       TEXT    NOT NULL,
  run_id       TEXT    NOT NULL,
  state        TEXT    NOT NULL CHECK (state IN ('queued', 'pushed', 'pulled', 'listed')),
  at           INTEGER NOT NULL,
  base         TEXT,
  base_hash    TEXT,
  remote_hash  TEXT,
  entry        TEXT,
  PRIMARY KEY (remote, run_id)
);
CREATE TABLE IF NOT EXISTS team_blobs (
  remote  TEXT NOT NULL,
  hash    TEXT NOT NULL,
  PRIMARY KEY (remote, hash)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS team_segments (
  remote  TEXT    NOT NULL,
  key     TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (remote, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS team_sync (
  remote     TEXT PRIMARY KEY,
  pushed_at  INTEGER,
  pulled_at  INTEGER,
  data       TEXT
);
-- The fixes this machine sent to the store or took from it: the hash of a fix as both sides last
-- agreed on it, which a push compares this machine's copy with, and the version of the store's
-- object last read, so a pull reads only the fixes that changed there.
CREATE TABLE IF NOT EXISTS team_fixes (
  remote   TEXT    NOT NULL,
  fix_id   TEXT    NOT NULL,
  hash     TEXT    NOT NULL,
  version  TEXT,
  at       INTEGER NOT NULL,
  PRIMARY KEY (remote, fix_id)
) WITHOUT ROWID;
-- The repairs that came with a fix from a store: made on a teammate's machine, where the recordings
-- the fixed code made (its goldens) stayed. Their patch and reports are written beside the project.
CREATE TABLE IF NOT EXISTS team_repairs (
  repair_id  TEXT    PRIMARY KEY,
  remote     TEXT    NOT NULL,
  at         INTEGER NOT NULL
) WITHOUT ROWID;
-- Every write to team_runs and team_sync moves the 'team' counter: what is only on this machine is
-- counted again when runs or the store's rows change, never for a call a recording appends, and the
-- dashboard shows a push, a pull or a step of the store's setup as soon as it is made.
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('team', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_team_insert AFTER INSERT ON team_runs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'team'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_team_update AFTER UPDATE ON team_runs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'team'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_team_delete AFTER DELETE ON team_runs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'team'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_team_sync_insert AFTER INSERT ON team_sync BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'team'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_team_sync_update AFTER UPDATE ON team_sync BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'team'; END;

-- Decisions: each shadowlap decisions or migrate session, and how each run's model calls decided
-- under its change (decisions.ts). A session keeps its report as --json prints it, without its runs;
-- each run's part is a row of its own, so a run's page reads its decisions without the rest of the
-- session. Sessions name runs by id with no foreign key: a session outlives a run gc deletes. Every
-- write moves the 'decisions' counter, so the Changes page follows a session another process keeps.
CREATE TABLE IF NOT EXISTS decision_sessions (
  session_id  TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('decisions', 'migrate')),
  at          INTEGER NOT NULL,
  change      TEXT    NOT NULL,
  runs        INTEGER NOT NULL,
  flagged     INTEGER NOT NULL,
  actor       TEXT,
  revision    TEXT,
  data        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_sessions_at ON decision_sessions (at);
CREATE TABLE IF NOT EXISTS decision_runs (
  session_id  TEXT    NOT NULL REFERENCES decision_sessions(session_id) ON DELETE CASCADE,
  run_id      TEXT    NOT NULL,
  position    INTEGER NOT NULL,
  golden      TEXT,
  rank        INTEGER,
  changed     INTEGER NOT NULL DEFAULT 0,
  at          INTEGER NOT NULL,
  data        TEXT    NOT NULL,
  PRIMARY KEY (session_id, run_id)
);
CREATE INDEX IF NOT EXISTS decision_runs_run ON decision_runs (run_id, at);
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('decisions', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_decisions_insert AFTER INSERT ON decision_sessions BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'decisions'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_decisions_update AFTER UPDATE ON decision_sessions BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'decisions'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_decisions_delete AFTER DELETE ON decision_sessions BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'decisions'; END;

-- Injection tests. Each shadowlap injection of a run (a golden's recording, under the gate of
-- shadowlap test or on its own) keeps one row: mode plant tested each untrusted read with each
-- payload, mode clean replaced one read with a neutral result (--clean). The counts are of
-- attempts; data is the report as --json prints it, with each attempt's run (marked
-- meta.injection). No foreign key on run ids: a result outlives the runs gc deletes. Every write
-- moves the 'injection' counter, so the dashboard shows a result as soon as it is kept.
CREATE TABLE IF NOT EXISTS injection_results (
  result_id   TEXT    PRIMARY KEY,
  run_id      TEXT    NOT NULL,
  golden      TEXT,
  session_id  TEXT,
  mode        TEXT    NOT NULL CHECK (mode IN ('plant', 'clean')),
  at          INTEGER NOT NULL,
  ended_at    INTEGER,
  attempts    INTEGER NOT NULL DEFAULT 0,
  obeyed      INTEGER NOT NULL DEFAULT 0,
  influenced  INTEGER NOT NULL DEFAULT 0,
  ignored     INTEGER NOT NULL DEFAULT 0,
  inconclusive INTEGER NOT NULL DEFAULT 0,
  verdict     TEXT,
  actor       TEXT,
  data        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS injection_results_run ON injection_results (run_id, at);
CREATE INDEX IF NOT EXISTS injection_results_golden ON injection_results (golden, at);
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('injection', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_injection_insert AFTER INSERT ON injection_results BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'injection'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_injection_update AFTER UPDATE ON injection_results BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'injection'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_injection_delete AFTER DELETE ON injection_results BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'injection'; END;

-- v4: coverage. What \`shadowlap coverage\` found when it last looked: the imported runs (captures
-- and traces) grouped by behaviour (the tools the model called in order, the writes among them, how
-- the run ended), each group with the goldens whose recordings behave the same way, as of that scan.
-- A scan replaces the groups of the one before; coverage_scans keeps every scan's totals. A group no
-- golden covers keeps the agent's command that would reproduce its newest run, when a recording here
-- says it, and one \`--pack\` made a golden of says which. No foreign key on run ids: gc may delete them.
CREATE TABLE IF NOT EXISTS coverage_scans (
  scan_id    TEXT    PRIMARY KEY,
  at         INTEGER NOT NULL,
  runs       INTEGER NOT NULL,
  groups     INTEGER NOT NULL,
  uncovered  INTEGER NOT NULL,
  goldens    INTEGER NOT NULL,
  actor      TEXT,
  data       TEXT
);
CREATE INDEX IF NOT EXISTS coverage_scans_at ON coverage_scans (at);
CREATE TABLE IF NOT EXISTS coverage_groups (
  key         TEXT    PRIMARY KEY,
  scan_id     TEXT    NOT NULL,
  behaviour   TEXT    NOT NULL,
  runs        INTEGER NOT NULL,
  run_ids     TEXT    NOT NULL,
  sources     TEXT    NOT NULL,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  covered_by  TEXT    NOT NULL,
  nearest     TEXT,
  command     TEXT,
  packed      TEXT
);
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('coverage', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_coverage_scans_insert AFTER INSERT ON coverage_scans BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'coverage'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_coverage_groups_insert AFTER INSERT ON coverage_groups BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'coverage'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_coverage_groups_update AFTER UPDATE ON coverage_groups BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'coverage'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_coverage_groups_delete AFTER DELETE ON coverage_groups BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'coverage'; END;
-- What \`coverage --pack\` last made of each behaviour, by its key, kept across scans: the golden it
-- packed (and whether that golden forks), or why it couldn't (a reason word and a sentence), so the
-- dashboard can say why before it offers Pack one again.
CREATE TABLE IF NOT EXISTS coverage_packs (
  key       TEXT    PRIMARY KEY,
  at        INTEGER NOT NULL,
  golden    TEXT,
  run_id    TEXT,
  from_run  TEXT,
  mode      TEXT    CHECK (mode IS NULL OR mode IN ('replay', 'fork')),
  reason    TEXT,
  why       TEXT,
  command   TEXT
);
CREATE TRIGGER IF NOT EXISTS change_counts_coverage_packs_insert AFTER INSERT ON coverage_packs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'coverage'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_coverage_packs_update AFTER UPDATE ON coverage_packs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'coverage'; END;

-- v4: error-path presets. Each \`shadowlap test --chaos\` or \`replay --chaos\` session, and how each
-- preset came out on each recording it forked: the call it hit, the verdict its gate reached
-- (passed, failed, inconclusive, or not-applicable when the recording has no call the preset can
-- hit), and the attempts it took, each a run. A result is one golden's (or, for replay --chaos, one
-- run's): two goldens that hold the same recording keep a result each. A session stopped by a
-- signal ends with interrupted = 1 and the results that finished. No foreign key on run ids: a
-- result outlives the runs gc deletes.
CREATE TABLE IF NOT EXISTS chaos_sessions (
  session_id         TEXT    PRIMARY KEY,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  command            TEXT    NOT NULL,
  revision           TEXT,
  actor              TEXT,
  presets            TEXT    NOT NULL,
  passed             INTEGER NOT NULL DEFAULT 0,
  failed             INTEGER NOT NULL DEFAULT 0,
  inconclusive       INTEGER NOT NULL DEFAULT 0,
  upstream_requests  INTEGER NOT NULL DEFAULT 0,
  interrupted        INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0, 1))
);
CREATE INDEX IF NOT EXISTS chaos_sessions_started ON chaos_sessions (started_at);
CREATE TABLE IF NOT EXISTS chaos_results (
  session_id  TEXT    NOT NULL REFERENCES chaos_sessions(session_id) ON DELETE CASCADE,
  run_id      TEXT    NOT NULL,
  golden      TEXT,
  preset      TEXT    NOT NULL,
  at          INTEGER NOT NULL,
  verdict     TEXT    NOT NULL CHECK (verdict IN ('passed', 'failed', 'inconclusive', 'not-applicable')),
  call_no     INTEGER,
  passes      INTEGER NOT NULL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,
  data        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS chaos_results_key ON chaos_results (session_id, run_id, preset, coalesce(golden, ''));
CREATE INDEX IF NOT EXISTS chaos_results_run ON chaos_results (run_id, at);
CREATE INDEX IF NOT EXISTS chaos_results_golden ON chaos_results (golden, at);
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('chaos', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_chaos_sessions_insert AFTER INSERT ON chaos_sessions BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'chaos'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_chaos_sessions_update AFTER UPDATE ON chaos_sessions BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'chaos'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_chaos_results_insert AFTER INSERT ON chaos_results BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'chaos'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_chaos_results_delete AFTER DELETE ON chaos_results BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'chaos'; END;

-- v5: error-path presets. The process running each session of presets not ended yet, as
-- test_session_owners does for test sessions, so a session still running (in a terminal, from
-- another dashboard) is told from one whose process was killed. The row goes when the session ends
-- or is deleted.
CREATE TABLE IF NOT EXISTS chaos_session_owners (
  session_id  TEXT    PRIMARY KEY REFERENCES chaos_sessions(session_id) ON DELETE CASCADE,
  pid         INTEGER NOT NULL,
  host        TEXT    NOT NULL
);

-- Replay start: the fingerprint a stored request came to under one set of matching rules, so a
-- replay of a long run doesn't read and hash every request again (the sidecar's
-- fingerprint-cache.ts). The key names the request by its content and every rule that went into its
-- fingerprint; \`clock\` lists the dates and times the request holds and whether each was masked, so
-- an entry serves only a replay whose start masks them the same. Additive and rebuilt on demand:
-- gcBlobs drops the entries whose request is gone.
CREATE TABLE IF NOT EXISTS fingerprint_cache (
  key          TEXT PRIMARY KEY,
  request_ref  TEXT NOT NULL,
  fingerprint  TEXT NOT NULL,
  clock        TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS fingerprint_cache_request ON fingerprint_cache (request_ref);
`;

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

// ---- tests (v4): the shapes of the test tables ----

/** One `shadowlap test` session: what ran, at which revision, and how it came out. */
export interface TestSession {
  sessionId: string;
  startedAt: number;
  /** Null while the session runs, or when its process was killed before it could end it. */
  endedAt: number | null;
  /** The command as given, without global options: `['shadowlap', 'test', 'goldens/*']`. */
  command: string[];
  /** The code version it tested (`codeVersion`): a short sha, with `+dirty` for uncommitted changes. */
  revision: string | null;
  /**
   * Set when it ends: the goldens that finished, by how they came out. An inconclusive one is
   * neither (its result's `data.verdict` says so); sessions before verdicts counted it by CI's call.
   */
  passed: number;
  failed: number;
  /** Requests that reached a provider: 0 for goldens that replay offline. */
  upstreamRequests: number;
  /** Who ran it (resolveAuthor). */
  actor: string | null;
  /** A signal stopped it (Ctrl-C, a job stopped): the golden it was replaying has no result, and the ones after it didn't run. */
  interrupted: boolean;
}

export type NewTestSession = Partial<Pick<TestSession, 'sessionId' | 'startedAt' | 'revision' | 'actor'>> &
  Pick<TestSession, 'command'> & {
    /** The process running it, until it ends: this one unless given; null names none (a session recorded elsewhere). */
    owner?: RunOwner | null;
  };

/**
 * Why a golden failed: its replay sent a request the recording doesn't have, a check failed, the
 * agent exited non-zero, it made no calls, it couldn't run at all, or (`injection`) its injection
 * gate saw more attempts obey a planted instruction than it allows; or why it didn't pass:
 * `inconclusive`, its gate ran out of attempts between its bounds, or a check couldn't be decided (a
 * judge check with no verdict, and no way to ask the judge).
 */
export type TestFailure = 'diverged' | 'check' | 'exit' | 'no-calls' | 'error' | 'inconclusive' | 'injection';

/** What a result keeps besides its verdict, for the Tests screen. Every field is optional to readers. */
export interface TestResultData {
  /** `replay` must send the requests it recorded; `fork` may diverge and passes on its checks. */
  mode?: 'replay' | 'fork';
  calls?: { total: number; replayed: number; live: number; blocked: number; stubbed: number };
  upstreamRequests?: number;
  tokensNotRespent?: number;
  /** Input tokens of the run's model requests, cache reads included: what it costs to run live. */
  inputTokens?: number;
  /** Each check of the attempt shown, a judge check's with its verdict, reason and where the verdict came from. */
  checks?: StoredCheck[];
  /** What its judge checks' calls did and cost over every attempt, apart from the agent's (`calls`, `upstreamRequests`). */
  judge?: JudgeSummary;
  /**
   * Attempts run, passed and needed, and each attempt's run: kept for every result since gates
   * pool them, one attempt included (a result kept before has it only for a recording that
   * repeats). `inconclusive`: attempts a check couldn't judge, which count neither way.
   */
  attempts?: { total: number; passed: number; required: number | null; runs: string[]; inconclusive?: number };
  /** How the golden came out: passed, failed, or inconclusive (its gate ran out between its bounds, or a check couldn't be decided). Absent before results said. */
  verdict?: 'passed' | 'failed' | 'inconclusive';
  /** A golden with a gate: its decision, interval, pass^k, evidence path and sentence (stats.ts), as the reports show it. */
  gate?: GateResult;
  /** USD its attempts spent on live calls, so a dashboard can say what more attempts would cost. */
  spent?: number;
  /**
   * `test --continue` carried an inconclusive gate's attempts over: the sessions they came from,
   * oldest first, and how many. `gate` counts them; `attempts` is this session's own, so a baseline
   * pools each attempt once.
   */
  continued?: { sessions: string[]; attempts: number };
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
    volatile?: { values: Array<{ path: string; looks: string; op: 'changed' | 'added'; certain?: boolean; normalizer: Normalizer }>; explainsAll: boolean; coversAll?: boolean };
    /** The first change the normalizers in force did not mask: what made it diverge (the report lists the masked ones too). */
    cause?: string | null;
    text: string;
  };
  /** The failure as the CLI printed it under the golden's line. */
  details?: string;
  /** For a failure: the last lines the agent printed, as `test --markdown` shows them (at most 20, cut short). */
  output?: string;
  /** `test --update` re-recorded the golden: the run it replaced, the new one, its calls, and what the agent sends differently. */
  updated?: { from: string | null; to: string; calls: number; changes?: string[] };
  /**
   * The golden's injection gate (`"injection"` under its tests entry): the result kept for it, the
   * attempts by verdict, what the gate allows, and whether it passed; `skipped` says why it planted
   * nothing, when it didn't.
   */
  injection?: InjectionGateData;
}

/**
 * An injection gate's outcome, as the test history and the JSON report keep it: `verdict` passed,
 * failed (more attempts obeyed, or were influenced, than allowed) or inconclusive (the test showed
 * too little to say: nothing to plant in, an attempt that failed, none a model read, a run cut
 * short), with `reason`; null with `skipped` when the gate did not run (the golden failed, or is
 * inconclusive, first).
 */
export interface InjectionGateData {
  resultId: string | null;
  attempts: number;
  obeyed: number;
  influenced: number;
  ignored: number;
  inconclusive: number;
  allowed: { obeyed: number; influenced: number | null };
  verdict: 'passed' | 'failed' | 'inconclusive' | null;
  /** One line: why it failed or is inconclusive. */
  reason: string | null;
  /** Why it did not run (the golden failed, or is inconclusive), else null. */
  skipped: string | null;
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

// ---- error-path presets (v4): the shapes of the chaos tables ----

/** One `shadowlap test --chaos` (or `replay --chaos`) session. */
export interface ChaosSession {
  sessionId: string;
  startedAt: number;
  /** Null while it runs, or when its process was killed before it could end it. */
  endedAt: number | null;
  /** The command as given, without global options. */
  command: string[];
  revision: string | null;
  actor: string | null;
  /** The presets it was asked to run, in order. */
  presets: string[];
  /** Set when it ends: the results by verdict (not-applicable ones aren't counted). */
  passed: number;
  failed: number;
  inconclusive: number;
  upstreamRequests: number;
  interrupted: boolean;
}

export type ChaosVerdict = 'passed' | 'failed' | 'inconclusive' | 'not-applicable';

/** How one preset came out on one recording. */
export interface ChaosResult {
  sessionId: string;
  /** The recording it forked: a golden's run, or the run `replay --chaos` was given. */
  runId: string;
  /** The golden, for `test --chaos`; null for a run. */
  golden: string | null;
  preset: string;
  at: number;
  verdict: ChaosVerdict;
  /** The call the preset hit, or null when it found none to hit. */
  callNo: number | null;
  passes: number;
  attempts: number;
  data: ChaosResultData | null;
}

/** What a result keeps besides its verdict. Every field is optional to readers. */
export interface ChaosResultData {
  /** The call it hit: its kind (`tool` or `api`) and name. */
  target?: { kind: string; name: string } | null;
  /** One sentence: what came out, naming the values involved. */
  detail?: string;
  /** For a failure, the first failing attempt's reason; for one inconclusive for a reason of its own (not a gate that ran out), why. */
  reason?: string | null;
  /**
   * Each attempt: its run, its verdict, whether it passed, the agent's exit code, its checks, why it
   * failed or is inconclusive, and the error the agent died of. An attempt is inconclusive when it
   * says nothing of the error path: its replay never reached the call, or all that kept it from
   * passing is a check no attempt can decide. A result kept before attempts had a verdict has none.
   */
  runs?: Array<{ runId: string; verdict?: Exclude<ChaosVerdict, 'not-applicable'>; passed: boolean; exitCode: number; checks?: Array<{ ok: boolean; label: string; detail: string | null }>; reason?: string | null; lastLine?: string }>;
  /** The gate the attempts were decided by, as configured. */
  gate?: Record<string, unknown> | null;
  revision?: string | null;
  upstreamRequests?: number;
  spent?: number;
}

export type NewChaosSession = Partial<Pick<ChaosSession, 'sessionId' | 'startedAt' | 'revision' | 'actor'>> &
  Pick<ChaosSession, 'command' | 'presets'> & {
    /** The process running it, until it ends: this one unless given; null names none (a session recorded elsewhere). */
    owner?: RunOwner | null;
  };

export type NewChaosResult = Partial<Pick<ChaosResult, 'at' | 'golden' | 'callNo' | 'passes' | 'attempts' | 'data'>> & Pick<ChaosResult, 'sessionId' | 'runId' | 'preset' | 'verdict'>;

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

/** How much of a run the search index covers (search.ts): a row of `search_state`. */
export interface SearchState {
  /** Calls indexed. */
  calls: number;
  /** The run's status when they were. */
  status: string;
  /** Where indexing stopped, as search.ts writes it; null for a row that covers its run whole. */
  progress: string | null;
}

// ---- Fixes (v4): the rows of the fixes, fix_links, blames, verdicts and repairs tables. fixes.ts
// decides what goes in them; these are only their shapes.

export type FixStatus = 'open' | 'verified' | 'applied';
export type FixLinkKind = 'failing' | 'good' | 'blame' | 'repair' | 'verify';

/** One failure, from the blame that reproduced it to a change that held. */
export interface StoredFix {
  /** `fx-<ulid>`. */
  fixId: string;
  title: string;
  /** Every label but `good` its failing runs carried when they joined it, in the order they came. */
  labels: string[];
  /**
   * The check its first blame was made under: the `--expect` JSON as given (null for the exit code
   * alone), its canonical key (`check:<canonical JSON>`, `check:exit`), the oracle as the labels of
   * what a passing run does, and in words.
   */
  check: { expect: unknown; key: string; oracle: string[]; text: string };
  status: FixStatus;
  openedAt: number;
  verifiedAt: number | null;
  appliedAt: number | null;
  data: FixData;
}

export interface FixData {
  /** Where it came from: a CI provider it was opened under, the pull request a repair opened for it. */
  source?: { ci?: string; pr?: { url: string; number: number | null; state?: 'open' | 'merged' | 'closed'; at?: number } };
  /** Who opened it (resolveAuthor). */
  openedBy?: string | null;
  /** Someone gave it a title of their own (`shadowlap fix title`). */
  titleEdited?: boolean;
  /** When the title was last given (ms): of two copies renamed apart, the later rename wins. */
  titleEditedAt?: number;
  /** How it was applied: by `shadowlap fix apply`, or by `repair --apply`, which copies no goldens unless asked and runs no test. */
  applied?: { patch: 'applied' | 'already' | 'none'; repairId: string | null; goldens: string[]; tests: 'passed' | 'failed' | 'skipped'; by?: string | null; via?: 'fix apply' | 'repair --apply' };
}

/**
 * Whether a verdict counts for a fix: it checked everything the fix's check asks, on at least one
 * of the fix's failing runs that failed it as recorded. One that doesn't is kept and shown, and
 * changes nothing: `another-check` (it left out `missing`), `already-passing` (every failing run
 * of the fix it replayed already passed as recorded), `no-runs` (none of its runs fails in the fix).
 */
export type VerdictStanding = { counts: true; why: null } | { counts: false; why: 'another-check' | 'already-passing' | 'no-runs'; missing?: string[] };

export interface FixLink {
  fixId: string;
  kind: FixLinkKind;
  /** A run id (failing, good), a blame id, a repair id or a verdict id. */
  ref: string;
  at: number;
  /** For a verdict, whether it counts for the fix; null otherwise. */
  data: VerdictStanding | null;
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

export interface CreateRunInput {
  runId?: string;
  parentRunId?: string | null;
  mode: RunMode;
  command: RunCommand;
  codeVersion?: string | null;
  startedAt?: number;
  meta?: RunMeta;
}

/** How long a write that only keeps a cache (saveRunStats, a batch of the search index) waits for another command's lock before it gives up. */
const CACHE_WAIT_MS = 100;

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

/**
 * Why a store can't be opened on a Node whose built-in SQLite has no full-text search, which every
 * store uses: Node has it from 22.16 on, and in 24 and later, never in 23. One of those without it
 * is a build that left it out (a custom or a distribution's build), which another version of Node
 * wouldn't mend: an official build has it, as doctor says.
 */
export function noFullTextSearch(version: string = process.version): string {
  const v = version.replace(/^v?/, '');
  const [major = 0, minor = 0] = v.split('.').map(Number);
  if ((major === 22 && minor >= 16) || major >= 24) return `this build of Node ${v} has no full-text search (FTS5) in its built-in SQLite, which the store needs: use an official Node build`;
  const node = major === 23 ? `Node ${v}, like every Node 23,` : `Node ${v}`;
  return `${node} has no full-text search (FTS5) in its built-in SQLite, which the store needs: use Node 22.16 or later (not 23)`;
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
    countAgentCalls: SqliteStatement;
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
      // The agent's calls: every call but a judge check's (scope `shadowlap:judge`, judge-scope.ts),
      // which are counted through their own index (call_events_judge, whose condition this repeats).
      countAgentCalls: db.prepare(
        `SELECT (SELECT COUNT(*) FROM call_events WHERE run_id = ? AND phase = 'start')
              - (SELECT COUNT(*) FROM call_events WHERE run_id = ? AND phase = 'start' AND json_extract(meta, '$.scope') = 'shadowlap:judge') AS n`,
      ),
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
    // SQLite answers "database is locked" at once, without the busy handler, when several processes
    // switch a new database to WAL in the same instant. Wait a little and ask again.
    for (let attempt = 1; ; attempt++) {
      try {
        db.exec('PRAGMA journal_mode = WAL');
        break;
      } catch (err) {
        if (attempt >= 100 || (err as { errcode?: number }).errcode !== 5) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 40));
      }
    }
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
      try {
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(text, run_id UNINDEXED, call_no UNINDEXED, field UNINDEXED, tokenize = 'unicode61')`);
      } catch (err) {
        // SQLite's own words, "no such module: fts5", would read as a damaged store.
        if (/no such module: fts5/i.test(err instanceof Error ? err.message : String(err))) throw new Error(noFullTextSearch());
        throw err;
      }
      db.exec(`CREATE TABLE IF NOT EXISTS search_state (run_id TEXT PRIMARY KEY, calls INTEGER NOT NULL, status TEXT NOT NULL)`);
      // Where indexing a run stopped (search.ts), so a long run is indexed a batch at a time and a run
      // still recording from its newest calls on. Additive: a row without it covers its run whole.
      const searchColumns = db.prepare(`PRAGMA table_info(search_state)`).all().map((r) => String(r.name));
      if (!searchColumns.includes('progress')) db.exec(`ALTER TABLE search_state ADD COLUMN progress TEXT`);
      // Which documents of the index are each run's: search_docs finds a run's only by reading every
      // document, which made deleting a run cost 35 ms on an index of 200,000 documents, and gc of
      // 500 runs 17 s. Additive: an index from before it is mapped once, here.
      const mapped = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_rows'`).get() !== undefined;
      db.exec(`CREATE TABLE IF NOT EXISTS search_rows (run_id TEXT NOT NULL, doc INTEGER NOT NULL)`);
      db.exec(`CREATE INDEX IF NOT EXISTS search_rows_run ON search_rows (run_id)`);
      if (!mapped) db.exec(`INSERT INTO search_rows (run_id, doc) SELECT run_id, rowid FROM search_docs`);
      // v5: who runs each session of error-path presets (chaos_session_owners). Additive: the SCHEMA
      // above creates the table, and a session a v4 build left without an end names no process, so
      // it reads as one that did not finish, as a test session from before its owner was kept does.
      // And what each scored attempt's judge checks cost, apart from its own spend: a score a v4
      // build kept has none, its spend having counted them.
      const scoreColumns = db.prepare(`PRAGMA table_info(task_scores)`).all().map((r) => String(r.name));
      if (!scoreColumns.includes('judge_spent')) db.exec(`ALTER TABLE task_scores ADD COLUMN judge_spent REAL`);
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

  /**
   * Runs `fn` in one transaction, which takes the write lock first (`immediate`): another process
   * writing waits for this one, then reads what it wrote, and this one waits for it the same way.
   * A deferred transaction that reads before it writes gets "database is locked" at once when
   * another process wrote in between: SQLite won't wait out the busy timeout to turn a read into a
   * write. So `deferred` is only for a transaction that never writes.
   */
  transaction<T>(fn: () => T, mode: 'deferred' | 'immediate' = 'immediate'): T {
    this.db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
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

  // ---- Fixes (v4): fixes, their links, and the blame, verdict and repair reports behind them ----

  insertFix(fix: StoredFix): void {
    this.db
      .prepare(
        `INSERT INTO fixes (fix_id, title, labels, check_key, check_expect, check_oracle, check_text, status, opened_at, verified_at, applied_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fix.fixId,
        fix.title,
        JSON.stringify(fix.labels),
        fix.check.key,
        fix.check.expect === null || fix.check.expect === undefined ? null : JSON.stringify(fix.check.expect),
        JSON.stringify(fix.check.oracle),
        fix.check.text,
        fix.status,
        fix.openedAt,
        fix.verifiedAt,
        fix.appliedAt,
        JSON.stringify(fix.data),
      );
  }

  getFix(fixId: string): StoredFix | null {
    const row = this.db.prepare(`SELECT * FROM fixes WHERE fix_id = ?`).get(fixId);
    return row ? rowToFix(row) : null;
  }

  /** Every fix, the most recently opened first. */
  listFixes(): StoredFix[] {
    return this.db.prepare(`SELECT * FROM fixes ORDER BY opened_at DESC, fix_id DESC`).all().map(rowToFix);
  }

  /**
   * Sets the columns given, and only those, so two commands changing different things about one fix
   * at once don't undo each other. `data` goes through `mergeFixData`.
   */
  updateFix(fixId: string, patch: Partial<Pick<StoredFix, 'title' | 'labels' | 'status' | 'verifiedAt' | 'appliedAt'>>): void {
    const columns: Array<[string, string | number | null]> = [];
    if (patch.title !== undefined) columns.push(['title', patch.title]);
    if (patch.labels !== undefined) columns.push(['labels', JSON.stringify(patch.labels)]);
    if (patch.status !== undefined) columns.push(['status', patch.status]);
    if (patch.verifiedAt !== undefined) columns.push(['verified_at', patch.verifiedAt]);
    if (patch.appliedAt !== undefined) columns.push(['applied_at', patch.appliedAt]);
    if (!columns.length) return;
    const done = this.db.prepare(`UPDATE fixes SET ${columns.map(([c]) => `${c} = ?`).join(', ')} WHERE fix_id = ?`).run(...columns.map(([, v]) => v), fixId);
    if (Number(done.changes) === 0) throw new Error(`unknown fix ${fixId}`);
  }

  /**
   * Merges `patch` into a fix's data in one statement (a JSON merge patch: objects merge, anything
   * else replaces, null removes), so it never writes back data another command changed meanwhile.
   */
  mergeFixData(fixId: string, patch: Record<string, unknown>): void {
    const done = this.db.prepare(`UPDATE fixes SET data = json_patch(coalesce(data, '{}'), ?) WHERE fix_id = ?`).run(JSON.stringify(patch), fixId);
    if (Number(done.changes) === 0) throw new Error(`unknown fix ${fixId}`);
  }

  /** Links a run or a report to a fix; linking it again keeps the first link. */
  addFixLink(fixId: string, kind: FixLinkKind, ref: string, at: number = Date.now(), data: FixLink['data'] = null): void {
    this.db.prepare(`INSERT OR IGNORE INTO fix_links (fix_id, kind, ref, at, data) VALUES (?, ?, ?, ?, ?)`).run(fixId, kind, ref, at, data === null ? null : JSON.stringify(data));
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
      interrupted: false,
    };
    this.db
      .prepare(`INSERT INTO test_sessions (session_id, started_at, ended_at, command, revision, passed, failed, upstream_requests, actor, interrupted) VALUES (?, ?, NULL, ?, ?, 0, 0, 0, ?, 0)`)
      .run(session.sessionId, session.startedAt, JSON.stringify(session.command), session.revision, session.actor);
    // Who runs it, until it ends (testSessionOwner).
    const owner = input.owner === undefined ? currentOwner() : input.owner;
    if (owner) this.db.prepare(`INSERT OR REPLACE INTO test_session_owners (session_id, pid, host) VALUES (?, ?, ?)`).run(session.sessionId, owner.pid, owner.host);
    return session;
  }

  /** Records a session's totals once its goldens have run, or once a signal stopped it (`interrupted`). */
  finishTestSession(sessionId: string, totals: { passed: number; failed: number; upstreamRequests: number; endedAt?: number; interrupted?: boolean }): void {
    this.db
      .prepare(`UPDATE test_sessions SET ended_at = ?, passed = ?, failed = ?, upstream_requests = ?, interrupted = ? WHERE session_id = ?`)
      .run(totals.endedAt ?? Date.now(), totals.passed, totals.failed, totals.upstreamRequests, totals.interrupted ? 1 : 0, sessionId);
    this.db.prepare(`DELETE FROM test_session_owners WHERE session_id = ?`).run(sessionId);
  }

  /**
   * The process running a session that hasn't ended, for `recorderGone` to ask; null once it ended,
   * and for a session no process here was named for (one from before owners were kept).
   */
  testSessionOwner(sessionId: string): RunOwner | null {
    const row = this.db.prepare(`SELECT pid, host FROM test_session_owners WHERE session_id = ?`).get(sessionId);
    return row ? { pid: Number(row.pid), host: String(row.host) } : null;
  }

  getTestSession(sessionId: string): TestSession | null {
    const row = this.db.prepare(`SELECT * FROM test_sessions WHERE session_id = ?`).get(sessionId);
    return row ? rowToTestSession(row) : null;
  }

  /**
   * Sessions, newest first; `before` pages back (exclusive), `finished` leaves out sessions that
   * haven't ended, and `withResults` the ones with no golden's result yet (one that just started, or
   * was stopped during its first golden).
   */
  listTestSessions(options: { limit?: number; before?: number; finished?: boolean; withResults?: boolean } = {}): TestSession[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.before !== undefined) {
      where.push('started_at < ?');
      params.push(options.before);
    }
    if (options.finished) where.push('ended_at IS NOT NULL');
    if (options.withResults) where.push('EXISTS (SELECT 1 FROM test_results r WHERE r.session_id = test_sessions.session_id)');
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

  /** When each golden was first tested: the time of its oldest result, by golden. */
  firstTestResultAt(): Map<string, number> {
    const rows = this.db.prepare(`SELECT golden, MIN(at) AS first FROM test_results GROUP BY golden`).all();
    return new Map(rows.map((r) => [String(r.golden), Number(r.first)]));
  }

  /** The goldens each of these sessions has a result for, by session, without reading the results themselves. */
  testSessionGoldens(sessionIds: readonly string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    if (!sessionIds.length) return out;
    const rows = this.db.prepare(`SELECT session_id, golden FROM test_results WHERE session_id IN (${sessionIds.map(() => '?').join(', ')})`).all(...sessionIds);
    for (const r of rows) {
      const id = String(r.session_id);
      let set = out.get(id);
      if (!set) out.set(id, (set = new Set()));
      set.add(String(r.golden));
    }
    return out;
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
   * check: not one that could not be decided, nor one that did not apply). `argv` counts only runs
   * of that command, `before` only runs started before it. Blame's probes, verify's attempts and the
   * error-path presets' attempts are left out: they ran with a change of their own. Bisect offers
   * these as commits where a run still worked.
   */
  runRevisions(options: { argv?: readonly string[]; before?: number; limit?: number } = {}): Array<{ revision: string; lastAt: number; runs: number; failed: number }> {
    const where = [`code_version IS NOT NULL`, `status <> 'running'`, `json_extract(meta, '$.probe') IS NULL`, `json_extract(meta, '$.verify') IS NULL`, `json_extract(meta, '$.chaos') IS NULL`];
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
    // A check kept before checks had a status failed when it was not ok.
    const failed = `status IN ('failed', 'crashed') OR EXISTS (SELECT 1 FROM json_each(meta, '$.checks') WHERE json_extract(value, '$.ok') = 0 AND COALESCE(json_extract(value, '$.status'), 'failed') = 'failed')`;
    return this.db
      .prepare(`SELECT code_version, MAX(started_at) AS last_at, COUNT(*) AS runs, SUM(CASE WHEN ${failed} THEN 1 ELSE 0 END) AS failed FROM runs WHERE ${where.join(' AND ')} GROUP BY code_version ORDER BY last_at DESC, code_version ASC LIMIT ?`)
      .all(...params)
      .map((row) => ({ revision: String(row.code_version), lastAt: Number(row.last_at), runs: Number(row.runs), failed: Number(row.failed) }));
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

  // ---- error-path presets (v4): test --chaos sessions and each preset's result ----

  /** Starts a session; finishChaosSession fills in its totals. */
  startChaosSession(input: NewChaosSession): ChaosSession {
    const session: ChaosSession = {
      sessionId: input.sessionId ?? ulidNow(),
      startedAt: input.startedAt ?? Date.now(),
      endedAt: null,
      command: input.command,
      revision: input.revision ?? null,
      actor: input.actor ?? null,
      presets: input.presets,
      passed: 0,
      failed: 0,
      inconclusive: 0,
      upstreamRequests: 0,
      interrupted: false,
    };
    this.db
      .prepare(`INSERT INTO chaos_sessions (session_id, started_at, ended_at, command, revision, actor, presets) VALUES (?, ?, NULL, ?, ?, ?, ?)`)
      .run(session.sessionId, session.startedAt, JSON.stringify(session.command), session.revision, session.actor, JSON.stringify(session.presets));
    // Who runs it, until it ends (chaosSessionOwner).
    const owner = input.owner === undefined ? currentOwner() : input.owner;
    if (owner) this.db.prepare(`INSERT OR REPLACE INTO chaos_session_owners (session_id, pid, host) VALUES (?, ?, ?)`).run(session.sessionId, owner.pid, owner.host);
    return session;
  }

  /** Records a session's totals once its presets have run, or once a signal stopped it (`interrupted`). */
  finishChaosSession(sessionId: string, totals: { passed: number; failed: number; inconclusive: number; upstreamRequests: number; endedAt?: number; interrupted?: boolean }): void {
    this.db
      .prepare(`UPDATE chaos_sessions SET ended_at = ?, passed = ?, failed = ?, inconclusive = ?, upstream_requests = ?, interrupted = ? WHERE session_id = ?`)
      .run(totals.endedAt ?? Date.now(), totals.passed, totals.failed, totals.inconclusive, totals.upstreamRequests, totals.interrupted ? 1 : 0, sessionId);
    this.db.prepare(`DELETE FROM chaos_session_owners WHERE session_id = ?`).run(sessionId);
  }

  /**
   * The process running a session of presets that hasn't ended, for `recorderGone` to ask; null once
   * it ended, and for a session no process here was named for (one a v4 store kept, or one recorded
   * elsewhere).
   */
  chaosSessionOwner(sessionId: string): RunOwner | null {
    const row = this.db.prepare(`SELECT pid, host FROM chaos_session_owners WHERE session_id = ?`).get(sessionId);
    return row ? { pid: Number(row.pid), host: String(row.host) } : null;
  }

  getChaosSession(sessionId: string): ChaosSession | null {
    const row = this.db.prepare(`SELECT * FROM chaos_sessions WHERE session_id = ?`).get(sessionId);
    return row ? rowToChaosSession(row) : null;
  }

  /** Sessions, newest first. */
  listChaosSessions(options: { limit?: number } = {}): ChaosSession[] {
    return this.db
      .prepare(`SELECT * FROM chaos_sessions ORDER BY started_at DESC, session_id DESC LIMIT ?`)
      .all(Math.max(1, Math.min(10_000, options.limit ?? 100)))
      .map(rowToChaosSession);
  }

  /** Records how one preset came out on one golden's recording (or one run); a second result for the same one in the same session replaces the first. */
  addChaosResult(input: NewChaosResult): ChaosResult {
    const result: ChaosResult = {
      sessionId: input.sessionId,
      runId: input.runId,
      golden: input.golden ?? null,
      preset: input.preset,
      at: input.at ?? Date.now(),
      verdict: input.verdict,
      callNo: input.callNo ?? null,
      passes: input.passes ?? 0,
      attempts: input.attempts ?? 0,
      data: input.data ?? null,
    };
    this.db
      .prepare(`INSERT OR REPLACE INTO chaos_results (session_id, run_id, golden, preset, at, verdict, call_no, passes, attempts, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(result.sessionId, result.runId, result.golden, result.preset, result.at, result.verdict, result.callNo, result.passes, result.attempts, result.data === null ? null : JSON.stringify(result.data));
    return result;
  }

  /** Results, newest first: of one session, one recording, or one golden (`limit`, default 1000). */
  listChaosResults(options: { sessionId?: string; runId?: string; golden?: string; limit?: number } = {}): ChaosResult[] {
    const where: string[] = [];
    const params: unknown[] = [];
    for (const [column, value] of [['session_id', options.sessionId], ['run_id', options.runId], ['golden', options.golden]] as const) {
      if (value === undefined) continue;
      where.push(`${column} = ?`);
      params.push(value);
    }
    params.push(Math.max(1, Math.min(100_000, options.limit ?? 1000)));
    return this.db
      .prepare(`SELECT * FROM chaos_results ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, session_id DESC, preset ASC LIMIT ?`)
      .all(...params)
      .map(rowToChaosResult);
  }

  /** The newest result of each preset on each golden's recording (and each run presets ran on alone): one row per golden, recording and preset, newest first. */
  latestChaosResults(): ChaosResult[] {
    return this.db
      .prepare(`SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY coalesce(golden, ''), run_id, preset ORDER BY at DESC, session_id DESC) AS n FROM chaos_results) WHERE n = 1 ORDER BY at DESC, run_id ASC, preset ASC`)
      .all()
      .map(rowToChaosResult);
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
    // settings: who records it, until it ends (recordingRuns).
    const owner = currentOwner();
    this.db.prepare(`INSERT OR REPLACE INTO run_owners (run_id, pid, host) VALUES (?, ?, ?)`).run(run.runId, owner.pid, owner.host);
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

  /**
   * Puts another copy of a run in place of the one held (a pull's copy of a run that a pull
   * request's folder brought first): the held record and its calls go, the copy's record comes in
   * for the caller to append its calls, and the runs made from it stay linked to it.
   */
  replaceRun(run: RunRecord): void {
    const children = this.childRuns(run.runId).map((r) => r.runId);
    this.deleteRun(run.runId);
    this.importRun(run);
    const link = this.db.prepare(`UPDATE runs SET parent_run_id = ? WHERE run_id = ?`);
    for (const child of children) link.run(run.runId, child);
  }

  /**
   * Links a run that came here without its parent (unset, as an import leaves it when the parent
   * isn't here) to that parent, once the parent is here. A link already set stays, and one that
   * would make the run its own ancestor is never made. Whether it was linked.
   */
  linkParent(runId: string, parentRunId: string): boolean {
    if (this.getRun(runId)?.parentRunId !== null) return false;
    for (let at: string | null = parentRunId, depth = 0; at; depth++) {
      if (at === runId || depth > 10_000) return false;
      const up = this.getRun(at);
      if (!up) return false;
      at = up.parentRunId;
    }
    return Number(this.db.prepare(`UPDATE runs SET parent_run_id = ? WHERE run_id = ? AND parent_run_id IS NULL`).run(parentRunId, runId).changes) > 0;
  }

  /**
   * Gives a run another start time. An import writes its run as of the moment it starts, so the
   * store hears from it now (recordingRuns) however old the capture's times are, and gives it the
   * capture's start once it has ended.
   */
  setRunStart(runId: string, startedAt: number): void {
    this.db.prepare(`UPDATE runs SET started_at = ? WHERE run_id = ?`).run(startedAt, runId);
  }

  endRun(runId: string, status: Exclude<RunStatus, 'running'>, endedAt: number = Date.now()): void {
    this.stmts.endRun.run(status, endedAt, runId);
    this.db.prepare(`DELETE FROM run_owners WHERE run_id = ?`).run(runId);
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
    // All of it or none: a run whose rows went while its search index could not be written (a Node
    // whose SQLite has no full-text search) would leave the text it recorded behind. A savepoint, as
    // a caller may have a transaction open already (replaceRun in a pull's).
    this.db.exec('SAVEPOINT delete_run');
    try {
      this.stmts.deleteRun.run(runId);
      this.deleteSearchDocs(runId);
      this.db.prepare(`DELETE FROM search_state WHERE run_id = ?`).run(runId);
      // A run queued for a push while it recorded goes nowhere now. (A row of a run synced stays: it
      // is what keeps a run deleted here from coming back with the next pull.)
      this.db.prepare(`DELETE FROM team_runs WHERE run_id = ? AND state = 'queued'`).run(runId);
      this.db.exec('RELEASE delete_run');
    } catch (err) {
      this.db.exec('ROLLBACK TO delete_run');
      this.db.exec('RELEASE delete_run');
      throw err;
    }
  }

  /**
   * A run's documents out of the search index, found by the rows that map them (search_rows), not by
   * reading every document. `all` reads every document after all, for a run indexed again from its
   * start (rare): an earlier Shadowlap may have written some of its documents without their rows.
   */
  private deleteSearchDocs(runId: string, all = false): void {
    if (all) this.db.prepare(`DELETE FROM search_docs WHERE run_id = ?`).run(runId);
    else this.db.prepare(`DELETE FROM search_docs WHERE rowid IN (SELECT doc FROM search_rows WHERE run_id = ?)`).run(runId);
    this.db.prepare(`DELETE FROM search_rows WHERE run_id = ?`).run(runId);
  }

  /** A run's documents into the search index, each mapped to the run. */
  private insertSearchDocs(runId: string, docs: ReadonlyArray<{ callNo: number; field: string; text: string }>): void {
    const insert = this.db.prepare(`INSERT INTO search_docs (text, run_id, call_no, field) VALUES (?, ?, ?, ?)`);
    const map = this.db.prepare(`INSERT INTO search_rows (run_id, doc) VALUES (?, ?)`);
    for (const d of docs) map.run(runId, insert.run(d.text, runId, d.callNo, d.field).lastInsertRowid);
  }

  /**
   * How much of a run the search index covers: the calls indexed, the run's status then, and where
   * indexing stopped (search.ts), or null for a row that covers the run whole.
   */
  searchState(runId: string): SearchState | null {
    const row = this.db.prepare(`SELECT calls, status, progress FROM search_state WHERE run_id = ?`).get(runId);
    return row ? searchStateOf(row) : null;
  }

  /** Every run's search state, by run: one read to tell which runs the index is behind on. */
  searchStates(): Map<string, SearchState> {
    return new Map(this.db.prepare(`SELECT run_id, calls, status, progress FROM search_state`).all().map((r) => [String(r.run_id), searchStateOf(r)]));
  }

  /** Replaces a run's search documents. */
  replaceSearchDocs(runId: string, calls: number, status: string, docs: Array<{ callNo: number; field: string; text: string }>): void {
    this.transaction(() => {
      this.deleteSearchDocs(runId, true);
      this.insertSearchDocs(runId, docs);
      this.db.prepare(`INSERT OR REPLACE INTO search_state (run_id, calls, status, progress) VALUES (?, ?, ?, NULL)`).run(runId, calls, status);
    });
  }

  /**
   * Adds a batch of a run's search documents and moves its state on to `next`, in one write, if its
   * state is still `expected`: another process indexing the same run meanwhile wins, and this batch
   * is dropped (false). `fresh` drops the run's documents first, for a run indexed again from its start.
   * `briefly` waits for another command's write lock a moment only, as saveRunStats does, not the
   * 10 s anything else waits: a dashboard indexes on the thread that answers its pages. Then it is
   * 'busy' while that command writes (gc's VACUUM, a pull), and nothing is written.
   */
  addSearchDocs(runId: string, o: { expected: SearchState | null; next: SearchState; docs: Array<{ callNo: number; field: string; text: string }>; fresh?: boolean; briefly?: boolean }): boolean | 'busy' {
    const write = () =>
      this.transaction(() => {
        const now = this.searchState(runId);
        const same = now === null || o.expected === null ? now === o.expected : now.calls === o.expected.calls && now.status === o.expected.status && now.progress === o.expected.progress;
        if (!same) return false;
        if (o.fresh && now !== null) this.deleteSearchDocs(runId, true);
        this.insertSearchDocs(runId, o.docs);
        this.db.prepare(`INSERT OR REPLACE INTO search_state (run_id, calls, status, progress) VALUES (?, ?, ?, ?)`).run(runId, o.next.calls, o.next.status, o.next.progress);
        return true;
      }, 'immediate');
    if (!o.briefly) return write();
    const wait = Number((this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)?.timeout ?? 10_000);
    this.db.exec(`PRAGMA busy_timeout = ${Math.min(wait, CACHE_WAIT_MS)}`);
    try {
      return write();
    } catch (err) {
      // SQLITE_BUSY, its extended codes included: the lock was not free in time.
      if (((err as { errcode?: number }).errcode ?? 0) % 256 === 5) return 'busy';
      throw err;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${wait}`);
    }
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
   * content, so they are collected here). Returns what was removed: `bytes` uncompressed, `stored`
   * as the store keeps them.
   *
   * Never while a run is recording, in this process or another: a recording stores a blob a moment
   * before the call row that references it, and a call whose content is already stored references
   * the existing blob without writing it again, so a blob that looks unreferenced may be one a
   * recording is about to use. With a run still recording, nothing is deleted and `recording` names
   * the runs. A run its process left `running` (killed, out of memory) is not recording and holds
   * nothing up (recordingRuns). The check and the deletes share one write transaction, so no run
   * can start between them; the slow part, reading every request manifest, happens before it, and
   * only what changed meanwhile is read again under the lock. `among` limits the collection to
   * those blobs (calibrate collects only what its own attempts wrote).
   */
  gcBlobs(options: { among?: Iterable<string> } = {}): { removed: number; bytes: number; stored: number; recording: string[] } {
    const recordingNow = () => this.recordingRuns().live.map((r) => r.run.runId);
    const early = recordingNow();
    if (early.length) return { removed: 0, bytes: 0, stored: 0, recording: early };
    const manifests = new Map<string, string[]>();
    const among = options.among ? new Set(options.among) : null;
    const candidates = this.blobsNotIn(this.referencedBlobs(new Set(), manifests)).filter((b) => !among || among.has(b.hash));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const recording = recordingNow();
      let removed = 0;
      let bytes = 0;
      let stored = 0;
      if (!recording.length && candidates.length) {
        // Calls committed since the first read may reference a candidate now: read their rows again.
        const referenced = this.referencedBlobs(new Set(), manifests);
        const del = this.db.prepare(`DELETE FROM blobs WHERE hash = ?`);
        for (const b of candidates) {
          if (referenced.has(b.hash)) continue;
          if (Number(del.run(b.hash).changes) === 0) continue;
          removed++;
          bytes += b.size;
          stored += b.stored;
        }
        // The fingerprints worked out for requests that are gone now.
        if (removed) this.db.exec(`DELETE FROM fingerprint_cache WHERE request_ref NOT IN (SELECT hash FROM blobs)`);
      }
      this.db.exec('COMMIT');
      return { removed, bytes, stored, recording };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Gives freed pages back to the filesystem, then checkpoints the write-ahead log so the file on
   * disk shrinks now rather than at the next checkpoint (as far as readers on other connections
   * allow; `size()` doesn't depend on it).
   */
  vacuum(): void {
    this.db.exec('VACUUM');
    try {
      this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    } catch {
      // a reader kept part of the log: the next checkpoint finishes it
    }
  }

  /**
   * The store's size as SQLite counts it, whatever its write-ahead log holds: `bytes` is every page
   * of the database, `free` the pages a vacuum would give back. Another connection holding the
   * store open (a dashboard) can keep the files on disk larger for a while; this is what they
   * come back to.
   */
  size(): { bytes: number; free: number } {
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get()?.page_size ?? 0);
    const pages = Number(this.db.prepare('PRAGMA page_count').get()?.page_count ?? 0);
    const free = Number(this.db.prepare('PRAGMA freelist_count').get()?.freelist_count ?? 0);
    return { bytes: pages * pageSize, free: free * pageSize };
  }

  // ---- settings: tools across runs, counts, cleanup ----

  /** Every blob the calls of a run reference, the parts of its request manifests included. */
  runBlobRefs(runId: string): string[] {
    const refs = new Set<string>();
    for (const r of this.db.prepare(`SELECT kind, request_ref, response_ref FROM call_events WHERE run_id = ?`).all(runId)) {
      const req = r.request_ref as string | null;
      const res = r.response_ref as string | null;
      if (res) refs.add(res);
      if (req) {
        refs.add(req);
        if (r.kind === 'api') for (const h of manifestRefs(this, req)) refs.add(h);
      }
    }
    return [...refs];
  }

  /**
   * The blobs some call references, leaving out the runs in `skip`. A request manifest never
   * changes (it is stored by its content), so `manifests` keeps what each one lists between reads.
   */
  private referencedBlobs(skip: Set<string>, manifests: Map<string, string[]>): Set<string> {
    const referenced = new Set<string>();
    for (const r of this.db.prepare(`SELECT run_id, kind, request_ref, response_ref FROM call_events`).all()) {
      if (skip.has(String(r.run_id))) continue;
      const req = r.request_ref as string | null;
      const res = r.response_ref as string | null;
      if (res) referenced.add(res);
      if (req) {
        referenced.add(req);
        if (r.kind !== 'api') continue;
        let parts = manifests.get(req);
        if (!parts) {
          parts = manifestRefs(this, req);
          manifests.set(req, parts);
        }
        for (const h of parts) referenced.add(h);
      }
    }
    return referenced;
  }

  private blobsNotIn(referenced: Set<string>): Array<{ hash: string; size: number; stored: number }> {
    const out: Array<{ hash: string; size: number; stored: number }> = [];
    for (const b of this.db.prepare(`SELECT hash, size, length(bytes) AS stored FROM blobs`).all()) {
      const hash = String(b.hash);
      if (!referenced.has(hash)) out.push({ hash, size: Number(b.size), stored: Number(b.stored) });
    }
    return out;
  }

  /**
   * The blobs no call would reference once the runs in `without` are deleted, those nothing
   * references now included: what `gcBlobs` removes after those runs go (once no run is
   * recording), found without deleting anything. `bytes` is what they take in the store, `size`
   * their uncompressed length.
   */
  unreferencedBlobs(without: Iterable<string> = []): { hashes: string[]; bytes: number; size: number } {
    const blobs = this.blobsNotIn(this.referencedBlobs(new Set(without), new Map()));
    return { hashes: blobs.map((b) => b.hash), bytes: blobs.reduce((n, b) => n + b.stored, 0), size: blobs.reduce((n, b) => n + b.size, 0) };
  }

  /**
   * Every tool name called in any run, by the effect it was called with: how many calls, in how many
   * runs, and the latest. One query over all runs, for the Settings page's tools.
   */
  toolUsage(): Array<{ name: string; effect: Effect | null; calls: number; runs: number; lastAt: number }> {
    const rows = this.db
      .prepare(`SELECT name, effect, COUNT(*) AS calls, COUNT(DISTINCT run_id) AS runs, MAX(at) AS last_at FROM call_events WHERE phase = 'start' AND kind = 'tool' GROUP BY name, effect ORDER BY name`)
      .all();
    return rows.map((r) => ({ name: String(r.name), effect: (r.effect as Effect | null) ?? null, calls: Number(r.calls), runs: Number(r.runs), lastAt: Number(r.last_at) }));
  }

  /**
   * How many runs the store holds: `attempts` are the runs blame, verify, `replay --repeat` and the
   * error-path presets make (marked `probe`, `verify`, `repeat` or `chaos`), and `running` the runs
   * not ended yet.
   */
  runCounts(): { runs: number; attempts: number; running: number } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN json_valid(meta) THEN (json_type(meta, '$.probe') IS NOT NULL OR json_type(meta, '$.verify') IS NOT NULL OR json_type(meta, '$.repeat') IS NOT NULL OR json_type(meta, '$.chaos') IS NOT NULL) ELSE 0 END) AS attempts,
                SUM(status = 'running') AS running
         FROM runs`,
      )
      .get();
    const total = Number(row?.total ?? 0);
    const attempts = Number(row?.attempts ?? 0);
    return { runs: total - attempts, attempts, running: Number(row?.running ?? 0) };
  }

  /** Recordings that ran to an end (completed or failed), newest first. */
  finishedRecordings(limit = 50): RunRecord[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE mode = 'record' AND status IN ('completed', 'failed') ORDER BY started_at DESC, run_id DESC LIMIT ?`)
      .all(limit)
      .map(rowToRun);
  }

  /**
   * The runs still `running`, oldest first: `live` ones a process is recording, and `abandoned` ones
   * whose process stopped without ending them (see liveness.ts). `lastAt` is the run's start or its
   * latest call, whichever is later.
   */
  recordingRuns(now = Date.now()): { live: Array<{ run: RunRecord; lastAt: number }>; abandoned: Array<{ run: RunRecord; lastAt: number }> } {
    return splitRecordingRuns(this.db.prepare(RECORDING_RUNS_SQL).all(), now);
  }

  /**
   * Why a run can't be deleted now, or null. A run a process is still recording (or replaying) is
   * left alone, and so is one a run in progress reads from: a replay, a fork or an attempt of it
   * serves its answers from it as it goes. A run its process left marked running holds nothing up,
   * as for gc. `live` is the runs in progress, when the caller has them already.
   */
  deletionHold(runId: string, live: readonly RunRecord[] = this.recordingRuns().live.map((r) => r.run)): string | null {
    const run = live.find((r) => r.runId === runId);
    if (run) return run.mode === 'record' ? 'still recording' : 'still running';
    return live.some((r) => r.parentRunId === runId) ? 'a replay of it is still running' : null;
  }

  /**
   * The MCP servers recorded tool calls came through (`shadowlap mcp` names each in the call's
   * `meta.mcp`): per server, its calls, the latest, and the tools it offered when last listed,
   * with their effects, or null when no call carried the list. One query over all runs.
   */
  mcpServerUsage(): Array<{ transport: string; server: string; calls: number; lastAt: number; tools: Array<{ name: string; effect: Effect }> | null; called: Array<{ name: string; effect: Effect | null }> }> {
    // CASE, so a meta that isn't JSON is never handed to json_type, whatever order SQLite tries the terms in.
    const where = `phase = 'start' AND kind = 'tool' AND (CASE WHEN json_valid(meta) THEN json_type(meta, '$.mcp.server') END) = 'text'`;
    const servers = new Map<string, { transport: string; server: string; calls: number; lastAt: number; tools: Array<{ name: string; effect: Effect }> | null; called: Array<{ name: string; effect: Effect | null }> }>();
    const key = (transport: unknown, server: unknown) => `${String(transport)}\u0000${String(server)}`;
    for (const r of this.db
      .prepare(`SELECT json_extract(meta, '$.mcp.transport') AS transport, json_extract(meta, '$.mcp.server') AS server, name, effect, COUNT(*) AS calls, MAX(at) AS last_at FROM call_events WHERE ${where} GROUP BY transport, server, name, effect ORDER BY name`)
      .all()) {
      const k = key(r.transport, r.server);
      const s = servers.get(k) ?? { transport: String(r.transport), server: String(r.server), calls: 0, lastAt: 0, tools: null, called: [] };
      s.calls += Number(r.calls);
      s.lastAt = Math.max(s.lastAt, Number(r.last_at));
      s.called.push({ name: String(r.name), effect: (r.effect as Effect | null) ?? null });
      servers.set(k, s);
    }
    // The tools each server offered, from the latest call that listed them.
    for (const r of this.db
      .prepare(
        `SELECT transport, server, tools FROM (
           SELECT json_extract(meta, '$.mcp.transport') AS transport, json_extract(meta, '$.mcp.server') AS server, json_extract(meta, '$.mcp.tools') AS tools,
                  ROW_NUMBER() OVER (PARTITION BY json_extract(meta, '$.mcp.transport'), json_extract(meta, '$.mcp.server') ORDER BY at DESC, run_id DESC, call_no DESC) AS latest
           FROM call_events WHERE ${where} AND (CASE WHEN json_valid(meta) THEN json_type(meta, '$.mcp.tools') END) = 'array'
         ) WHERE latest = 1`,
      )
      .all()) {
      const s = servers.get(key(r.transport, r.server));
      if (!s) continue;
      try {
        const listed = JSON.parse(String(r.tools)) as unknown[];
        s.tools = listed.flatMap((t) => (typeof t === 'object' && t !== null && typeof (t as { name?: unknown }).name === 'string' && ['pure', 'read', 'write'].includes(String((t as { effect?: unknown }).effect)) ? [{ name: (t as { name: string }).name, effect: (t as { effect: Effect }).effect }] : []));
      } catch {
        s.tools = null;
      }
    }
    return [...servers.values()].sort((a, b) => a.server.localeCompare(b.server));
  }

  // ---- read models (the dashboard's overview, run list and calendar) ----

  private readonly readStatements = new Map<string, SqliteStatement>();
  private queryOnlyState: SqliteStatement | null = null;

  /**
   * Runs one read-only statement and returns its rows, for read models that aggregate in SQL instead
   * of loading every call of every run. Callers pass fixed SQL and bind every value. SQLite itself
   * refuses a write here (`query_only`), whatever the SQL says; only the first statement runs. A
   * connection that was read-only before is left read-only.
   */
  query(sql: string, ...params: SqlValue[]): Record<string, unknown>[] {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error('Store.query runs read-only SELECT statements');
    let statement = this.readStatements.get(sql);
    if (!statement) {
      // Read models use a handful of fixed statements: past that, nothing is worth keeping.
      if (this.readStatements.size >= 64) this.readStatements.clear();
      statement = this.db.prepare(sql);
      this.readStatements.set(sql, statement);
    }
    this.queryOnlyState ??= this.db.prepare('PRAGMA query_only');
    const readOnly = Number(this.queryOnlyState.get()?.query_only) === 1;
    if (!readOnly) this.db.exec('PRAGMA query_only = ON');
    try {
      return statement.all(...params);
    } finally {
      if (!readOnly) this.db.exec('PRAGMA query_only = OFF');
    }
  }

  /**
   * Keeps what a read model worked out about finished runs (`run_stats`), so no later read, in this
   * process or the next, reads their calls again. A run deleted meanwhile is skipped. Best effort:
   * false when the store can't be written just now, and the caller keeps its numbers in memory. It
   * waits a moment for the write lock, not the 10 s anything else waits: a dashboard saves these on
   * its only thread, which would stop answering while another command holds the store.
   */
  saveRunStats(rows: ReadonlyArray<{ runId: string; key: string; stats: string }>): boolean {
    if (!rows.length) return true;
    const wait = Number((this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)?.timeout ?? 10_000);
    this.db.exec(`PRAGMA busy_timeout = ${Math.min(wait, CACHE_WAIT_MS)}`);
    try {
      this.transaction(() => {
        const put = this.db.prepare(`INSERT OR REPLACE INTO run_stats (run_id, key, stats) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE run_id = ?)`);
        for (const r of rows) put.run(r.runId, r.key, r.stats, r.runId);
      });
      return true;
    } catch {
      return false;
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${wait}`);
    }
  }

  // ---- Team store (v4): what this machine knows about the project's bucket ----

  /** Whether a blob is here, without reading it. */
  hasBlob(hash: string): boolean {
    return this.stmts.hasBlob.get(hash) !== undefined;
  }

  /** A blob's size in bytes, without reading it; null when it isn't here. */
  blobSize(hash: string): number | null {
    const row = this.db.prepare(`SELECT size FROM blobs WHERE hash = ?`).get(hash);
    return row ? Number(row.size) : null;
  }

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

  /** The agent's calls in a run: every call but a judge check's, which are none of the agent's. */
  countAgentCalls(runId: string): number {
    return Number(this.stmts.countAgentCalls.get(runId, runId)?.n ?? 0);
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

  /**
   * Runs `fn` as one write, waiting at most `waitMs` for another connection's write lock instead of
   * the busy timeout every other write waits: the sidecar writes its calls on the thread that streams
   * answers, so a store another process holds (the dashboard, gc, another recording) must never hold
   * the agent up. When the lock isn't free in time this throws SQLITE_BUSY and nothing was written;
   * the sidecar tries again later (its StoreWriter). Inside a transaction already open, `fn` joins it.
   */
  tryWrite<T>(fn: () => T, waitMs: number): T {
    if (this.db.isTransaction) return fn();
    const wait = Number((this.db.prepare('PRAGMA busy_timeout').get() as { timeout?: number } | undefined)?.timeout ?? 10_000);
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(waitMs))}`);
    try {
      return this.transaction(fn, 'immediate');
    } finally {
      this.db.exec(`PRAGMA busy_timeout = ${wait}`);
    }
  }

  // ---- fingerprint cache: what replay start reads instead of every stored request ----

  /** The fingerprints the cache holds under these keys, each with the dates and times its request holds (`clock`, as cached). */
  cachedFingerprints(keys: readonly string[]): Map<string, { fingerprint: string; clock: string | null }> {
    const found = new Map<string, { fingerprint: string; clock: string | null }>();
    if (!keys.length) return found;
    const rows = this.db.prepare(`SELECT key, fingerprint, clock FROM fingerprint_cache WHERE key IN (SELECT value FROM json_each(?))`).all(JSON.stringify(keys));
    for (const r of rows) found.set(String(r.key), { fingerprint: String(r.fingerprint), clock: typeof r.clock === 'string' ? r.clock : null });
    return found;
  }

  /** Keeps fingerprints worked out for stored requests, for the next replay to start from. */
  cacheFingerprints(rows: ReadonlyArray<{ key: string; requestRef: string; fingerprint: string; clock: string | null }>): void {
    const put = this.db.prepare(`INSERT OR REPLACE INTO fingerprint_cache (key, request_ref, fingerprint, clock) VALUES (?, ?, ?, ?)`);
    for (const r of rows) put.run(r.key, r.requestRef, r.fingerprint, r.clock);
  }

  /**
   * All calls of a run in arrival order, each with its final end row and earlier attempts. `range`
   * reads only some of them: the first `limit` (all, without one) numbered after `after`, or those
   * named in `only`.
   */
  getCalls(runId: string, range?: { after?: number; limit?: number; only?: readonly number[] }): CallRecord[] {
    const rows = !range
      ? this.stmts.eventsForRun.all(runId)
      : range.only
        ? this.db.prepare(`SELECT * FROM call_events WHERE run_id = ? AND call_no IN (SELECT value FROM json_each(?)) ORDER BY call_no ASC, phase DESC, attempt ASC`).all(runId, JSON.stringify(range.only))
        : this.db
            .prepare(
              `SELECT * FROM call_events WHERE run_id = ? AND call_no > ? AND call_no <= COALESCE(
                 (SELECT MAX(call_no) FROM (SELECT call_no FROM call_events WHERE run_id = ? AND phase = 'start' AND call_no > ? ORDER BY call_no LIMIT ?)), -1)
               ORDER BY call_no ASC, phase DESC, attempt ASC`,
            )
            .all(runId, range.after ?? 0, runId, range.after ?? 0, range.limit ?? -1);
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

function searchStateOf(row: Record<string, unknown>): SearchState {
  return { calls: Number(row.calls), status: String(row.status), progress: typeof row.progress === 'string' ? row.progress : null };
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

const strings = (v: unknown): string[] => {
  const parsed = typeof v === 'string' ? (JSON.parse(v) as unknown) : [];
  return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
};

function rowToFix(row: Record<string, unknown>): StoredFix {
  return {
    fixId: String(row.fix_id),
    title: String(row.title),
    labels: strings(row.labels),
    check: { expect: typeof row.check_expect === 'string' ? (JSON.parse(row.check_expect) as unknown) : null, key: String(row.check_key), oracle: strings(row.check_oracle), text: String(row.check_text) },
    status: row.status as FixStatus,
    openedAt: Number(row.opened_at),
    verifiedAt: nullableNumber(row.verified_at),
    appliedAt: nullableNumber(row.applied_at),
    data: typeof row.data === 'string' ? (record(row.data) as FixData) : {},
  };
}

function rowToFixLink(row: Record<string, unknown>): FixLink {
  return { fixId: String(row.fix_id), kind: row.kind as FixLinkKind, ref: String(row.ref), at: Number(row.at), data: typeof row.data === 'string' ? (record(row.data) as unknown as VerdictStanding) : null };
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

/** The runs still `running`, with the process the store names for each and their latest call: read by recordingRuns, and by a project's store opened read-only. */
export const RECORDING_RUNS_SQL = `SELECT r.*, o.pid AS owner_pid, o.host AS owner_host, (SELECT MAX(c.at) FROM call_events c WHERE c.run_id = r.run_id) AS last_call
  FROM runs r LEFT JOIN run_owners o ON o.run_id = r.run_id
  WHERE r.status = 'running' ORDER BY r.started_at, r.run_id`;

/** Rows of {@link RECORDING_RUNS_SQL} split into the runs a process records and those it left (recorderGone). */
export function splitRecordingRuns(rows: readonly Record<string, unknown>[], now: number): { live: Array<{ run: RunRecord; lastAt: number }>; abandoned: Array<{ run: RunRecord; lastAt: number }> } {
  const live: Array<{ run: RunRecord; lastAt: number }> = [];
  const abandoned: Array<{ run: RunRecord; lastAt: number }> = [];
  for (const row of rows) {
    const run = rowToRun(row);
    const lastAt = Math.max(run.startedAt, Number(row.last_call ?? 0));
    const owner: RunOwner | null = row.owner_pid === null || row.owner_pid === undefined ? null : { pid: Number(row.owner_pid), host: String(row.owner_host) };
    (recorderGone(owner, lastAt, now) ? abandoned : live).push({ run, lastAt });
  }
  return { live, abandoned };
}

/** A `runs` row as a run. Exported for readers that open a store read-only (projects/store-reader.ts). */
export function rowToRun(row: Record<string, unknown>): RunRecord {
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
    interrupted: Number(row.interrupted ?? 0) === 1,
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

// ---- error-path presets (v4): rows to records ----

function rowToChaosSession(row: Record<string, unknown>): ChaosSession {
  const command = parseJsonColumn<unknown>(row.command, []);
  const presets = parseJsonColumn<unknown>(row.presets, []);
  return {
    sessionId: String(row.session_id),
    startedAt: Number(row.started_at),
    endedAt: row.ended_at === null || row.ended_at === undefined ? null : Number(row.ended_at),
    command: Array.isArray(command) ? command.map(String) : [],
    revision: row.revision === null || row.revision === undefined ? null : String(row.revision),
    actor: row.actor === null || row.actor === undefined ? null : String(row.actor),
    presets: Array.isArray(presets) ? presets.map(String) : [],
    passed: Number(row.passed),
    failed: Number(row.failed),
    inconclusive: Number(row.inconclusive),
    upstreamRequests: Number(row.upstream_requests),
    interrupted: Number(row.interrupted ?? 0) === 1,
  };
}

function rowToChaosResult(row: Record<string, unknown>): ChaosResult {
  return {
    sessionId: String(row.session_id),
    runId: String(row.run_id),
    golden: row.golden === null || row.golden === undefined ? null : String(row.golden),
    preset: String(row.preset),
    at: Number(row.at),
    verdict: String(row.verdict) as ChaosVerdict,
    callNo: row.call_no === null || row.call_no === undefined ? null : Number(row.call_no),
    passes: Number(row.passes),
    attempts: Number(row.attempts),
    data: parseJsonColumn<ChaosResultData | null>(row.data, null),
  };
}

let lastUlidTime = 0;
/**
 * Monotonic within a process so runs and events created in the same millisecond still sort by
 * creation order. An id made in a burst takes the next millisecond along, and the clock catching up
 * continues after the last one issued rather than from itself, which could sort an id before one
 * made earlier. 80 random bits keep ids unique across processes.
 */
function ulidNow(): string {
  const now = Date.now();
  lastUlidTime = now > lastUlidTime ? now : lastUlidTime + 1;
  return ulid(lastUlidTime);
}
