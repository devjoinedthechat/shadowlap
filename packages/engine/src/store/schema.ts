/**
 * The store's schema, and opening a store file at it: the tables every store has, under the version
 * this build writes (each feature's tables in a block of their own, added to a store as it opens),
 * and the connection Store.open makes, which creates the file for its owner alone, switches it to
 * WAL and brings an older store up to this version under one write lock, or the read-only one
 * Store.openReadOnly makes. A store a newer Shadowlap wrote is refused either way.
 */
import { chmodSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { messageOf } from '../message-of.js';
import { DatabaseSync, rollBack, type SqliteDatabase } from './core.js';

export const SCHEMA_VERSION = 6;

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

-- Which runs each write to the runs table touched, in the order written, kept by triggers so every
-- writer logs: a reader that keeps every run in memory (the dashboard's run index) reads again only
-- the runs written since it last looked, where the runs counter alone says only that one was. The
-- log keeps the last few thousand writes; a reader further behind reads every run.
CREATE TABLE IF NOT EXISTS run_changes (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT    NOT NULL
);
CREATE TRIGGER IF NOT EXISTS run_changes_insert AFTER INSERT ON runs BEGIN INSERT INTO run_changes (run_id) VALUES (NEW.run_id); END;
CREATE TRIGGER IF NOT EXISTS run_changes_update AFTER UPDATE ON runs BEGIN INSERT INTO run_changes (run_id) VALUES (NEW.run_id); END;
CREATE TRIGGER IF NOT EXISTS run_changes_delete AFTER DELETE ON runs BEGIN INSERT INTO run_changes (run_id) VALUES (OLD.run_id); END;
CREATE TRIGGER IF NOT EXISTS run_changes_trim AFTER INSERT ON run_changes WHEN NEW.seq % 1024 = 0 BEGIN DELETE FROM run_changes WHERE seq <= NEW.seq - 8192; END;

-- v4: read models. What the dashboard worked out about a finished run's calls (where each answer
-- came from, tokens per model, time not waited, prompt-cache misses), kept so the Overview and the
-- run list read one row per run instead of every call, in this process and the next. \`key\` names
-- what the numbers were worked out from; prices are applied when they are read.
CREATE TABLE IF NOT EXISTS run_stats (
  run_id  TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  stats   TEXT NOT NULL
);

-- Run about lines (dashboard): what a finished recording's user asked first, which its about line
-- quotes (the engine's runAsk, as JSON, or null when it asked nothing), kept apart from run_stats so
-- the run index reads it with each run and the run list's filter matches about lines without
-- reading any request. \`key\` names what it was worked out from. Additive: no version bump; a store
-- without it works the asks out again and keeps them here.
CREATE TABLE IF NOT EXISTS run_asks (
  run_id  TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  ask     TEXT
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
-- v6: each check a fix has had, in the order it had them, the last the one it has (its own check_*
-- columns): the check its first blame was made under, then each one it was given since, with when
-- and by whom. A blame, repair or verdict made under an earlier check keeps that check here, by its
-- key, after the fix takes another. A fix kept before has the check it has as its first.
CREATE TABLE IF NOT EXISTS fix_checks (
  fix_id        TEXT    NOT NULL REFERENCES fixes(fix_id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  at            INTEGER NOT NULL,
  check_key     TEXT    NOT NULL,
  check_expect  TEXT,
  check_oracle  TEXT    NOT NULL,
  check_text    TEXT    NOT NULL,
  actor         TEXT,
  PRIMARY KEY (fix_id, position)
);
-- Any write to a fix, its links, its checks or the reports behind it moves the 'fixes' counter,
-- whoever makes it (the CLI's blame, repair, fix title or apply, the dashboard, a pull): the Fixes
-- pages follow it.
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('fixes', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_fixes_insert AFTER INSERT ON fixes BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fixes_update AFTER UPDATE ON fixes BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fixes_delete AFTER DELETE ON fixes BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fix_links_insert AFTER INSERT ON fix_links BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fix_links_update AFTER UPDATE ON fix_links BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fix_links_delete AFTER DELETE ON fix_links BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fix_checks_insert AFTER INSERT ON fix_checks BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fix_checks_update AFTER UPDATE ON fix_checks BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_fix_checks_delete AFTER DELETE ON fix_checks BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_blames_insert AFTER INSERT ON blames BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_verdicts_insert AFTER INSERT ON verdicts BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_repairs_insert AFTER INSERT ON repairs BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'fixes'; END;

-- v4: tests. Each shadowlap test session and how each golden did in it, so a golden's history
-- across revisions outlives the runs that gc deletes: no foreign key on run ids. A golden is its
-- pack folder relative to the project (goldens/refund-flow); the runs a session made carry
-- meta.test = { golden, session }. A session stopped by a signal ends with interrupted = 1 and the
-- results of the goldens that finished before it. v6: the pull or merge request a CI session ran
-- for and where it stands (pull_request; every session that ran for it is told) and what the
-- comment the Action keeps on it carried beside each golden's verdict line (comment), as JSON in
-- the shapes store/tests.ts gives.
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
  interrupted        INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0, 1)),
  pull_request       TEXT,
  comment            TEXT
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
-- v6: every write to a session or a golden's result moves the 'tests' counter, whoever makes it (a
-- test in a terminal, CI's, the dashboard's), so Tests and Changes follow a session another process
-- keeps, the parts of its pull request comment as each is kept, and where that pull request stands.
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('tests', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_test_sessions_insert AFTER INSERT ON test_sessions BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'tests'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_test_sessions_update AFTER UPDATE ON test_sessions BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'tests'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_test_sessions_delete AFTER DELETE ON test_sessions BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'tests'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_test_results_insert AFTER INSERT ON test_results BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'tests'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_test_results_update AFTER UPDATE ON test_results BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'tests'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_test_results_delete AFTER DELETE ON test_results BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'tests'; END;

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
-- v6: a migration's config change once applied (applied: when, by whom, and the goldens it left
-- behind, as JSON in the shape store/decisions.ts gives); null until then, and for a decisions session.
CREATE TABLE IF NOT EXISTS decision_sessions (
  session_id  TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK (kind IN ('decisions', 'migrate')),
  at          INTEGER NOT NULL,
  change      TEXT    NOT NULL,
  runs        INTEGER NOT NULL,
  flagged     INTEGER NOT NULL,
  actor       TEXT,
  revision    TEXT,
  data        TEXT    NOT NULL,
  applied     TEXT
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

-- v6: dismissals. The advice Needs a look shows (behaviours no golden covers, runs only on this
-- machine, a model that retires) that whoever keeps this store put away: by the advice's key, with
-- the facts it stated then, when, and who. It stays put away while every fact it states is one of
-- those, so only a new fact brings it back. Kept in this store alone, so it is per project and its
-- owner's: a push and a pull leave it out, and nobody's Dismiss changes what a teammate sees. Every
-- write moves the 'dismissals' counter, so a page follows one made in another tab.
CREATE TABLE IF NOT EXISTS dismissals (
  key    TEXT    PRIMARY KEY,
  facts  TEXT    NOT NULL,
  at     INTEGER NOT NULL,
  actor  TEXT
);
INSERT OR IGNORE INTO change_counts (name, n) VALUES ('dismissals', 0);
CREATE TRIGGER IF NOT EXISTS change_counts_dismissals_insert AFTER INSERT ON dismissals BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'dismissals'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_dismissals_update AFTER UPDATE ON dismissals BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'dismissals'; END;
CREATE TRIGGER IF NOT EXISTS change_counts_dismissals_delete AFTER DELETE ON dismissals BEGIN UPDATE change_counts SET n = n + 1 WHERE name = 'dismissals'; END;

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

/**
 * The schema version a store records, or null when it has never been stamped (a database this
 * build is about to create, or one from before the key existed). Reads defensively: the `meta`
 * table may not exist yet, and a file that is not a Shadowlap store should fail on the schema
 * itself with a clearer message than this would give.
 */
export function storedSchemaVersion(db: SqliteDatabase): number | null {
  try {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value?: unknown } | undefined;
    const found = Number(row?.value);
    return Number.isInteger(found) && found > 0 ? found : null;
  } catch {
    return null;
  }
}

/** Creates a file readable only by its owner, unless something already exists at the path. */
/** Whether something is at `path`, a link to nothing included. */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
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

/**
 * Creates an empty store file readable only by its owner: exclusively, and never through a
 * symbolic link (O_CREAT | O_EXCL | O_NOFOLLOW, mode 0600), so a link planted where the store goes is
 * never followed to a file elsewhere. Something already at the path is left for checkStoreFiles.
 */
function createStoreFile(path: string): void {
  // O_NOFOLLOW is not defined on Windows, where O_EXCL alone refuses an existing path.
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags, 0o600);
  } catch (err) {
    // There already (checked next), or a directory it can't be made in (opening the database reports it).
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' || (err as NodeJS.ErrnoException).code === 'EACCES' || (err as NodeJS.ErrnoException).code === 'EROFS') return;
    throw err;
  }
  closeSync(fd);
}

/**
 * Why the directory a store is in can't hold one, or null: a store is kept only in a real directory
 * of this user's that no other user can write to, neither its group nor every user, never through a
 * link to one elsewhere, nor in a directory someone else keeps that every user can change. Whoever
 * can write there can put a link where the store's files go after each is checked, before SQLite
 * opens it, and node:sqlite can't open a file without following one; whoever can write in the
 * directory above it can put another directory in its place.
 */
export function storeDirProblem(dir: string): string | null {
  let st;
  try {
    st = lstatSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (st.isSymbolicLink()) return `${dir} is a symbolic link: a store is kept only in a directory of its own, never through a link to one elsewhere. Point --db at a store in the directory itself, or remove the link`;
  if (!st.isDirectory()) return `${dir} is not a directory: point --db at a store's file`;
  // Windows keeps neither owners as numbers nor these bits: who may write there is its access control's to say.
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return null;
  // The directory it is in: one every user can change that isn't sticky (in a shared /tmp only an
  // entry's owner can rename it), and that someone else keeps, lets any user put another directory
  // in its place. One of this user's, or root's, is theirs to keep so: a CI job's checkout, made
  // with every permission under a umask of 0, is one.
  const parent = dirname(dir);
  if (parent !== dir) {
    const above = statSync(parent);
    if (above.mode & 0o002 && !(above.mode & 0o1000) && above.uid !== process.getuid() && above.uid !== 0) return `${parent}, the directory ${dir} is in, belongs to another user (uid ${above.uid}) and every user can change it: whoever can write there can put another directory in its place. Point --db at a store in a directory of your own`;
  }
  const why = "since whoever can write there can put a link where the store's files go";
  if (st.uid !== process.getuid()) return `${dir} belongs to another user (uid ${st.uid}): a store is kept only in a directory of yours, ${why}. Point --db at a store in a directory of your own`;
  if (st.mode & 0o002) return `${dir} can be written by every user: a store is kept only in a directory that not everyone can write to, ${why}. Take that away (chmod o-w), or point --db at a store in a directory of your own`;
  if (st.mode & 0o020) return `${dir} can be written by its group: a store is kept only in a directory no one else can write to, ${why}. Take that away (chmod g-w), or point --db at a store in a directory of your own`;
  return null;
}

/**
 * Why a store, or its WAL or shared-memory file, can't be opened as it stands; null when its
 * directory can hold a store (storeDirProblem) and each that exists is a regular file of this user's.
 */
export function storeFileProblem(path: string): string | null {
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    let st;
    try {
      st = lstatSync(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (st.isSymbolicLink()) return `${file} is a symbolic link: a store is opened only as a file of its own, never through a link to another file. Point --db at the file itself, or remove the link`;
    if (!st.isFile()) return `${file} is not a file: point --db at a store's file`;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return `${file} belongs to another user (uid ${st.uid}): a store is opened only when it is yours, since it holds what your agents sent and got. Point --db at a store of your own`;
  }
  return storeDirProblem(dirname(path));
}

/** A table's columns, by name. */
function columnsOf(db: SqliteDatabase, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => String(r.name));
}

/**
 * v6, what the dashboard's pages keep, in one step. The SCHEMA above creates its tables and triggers
 * (dismissals, fix_checks, the 'tests' counter); a store from before gains its columns here: the pull
 * request a CI test session ran for and what its comment carried, and a migration's applied state.
 * A fix kept before (`found` is the version the store was at) has its check as the first of its checks.
 */
function addVersion6(db: SqliteDatabase, found: number | null): void {
  const sessionColumns = columnsOf(db, 'test_sessions');
  if (!sessionColumns.includes('pull_request')) db.exec(`ALTER TABLE test_sessions ADD COLUMN pull_request TEXT`);
  if (!sessionColumns.includes('comment')) db.exec(`ALTER TABLE test_sessions ADD COLUMN comment TEXT`);
  if (!columnsOf(db, 'decision_sessions').includes('applied')) db.exec(`ALTER TABLE decision_sessions ADD COLUMN applied TEXT`);
  if (found === null || found >= 6) return;
  // Its first check's author is the fix's (data.openedBy), when its data says one: data that doesn't
  // read as JSON is never handed to json_type, which would refuse it and the store with it.
  db.exec(
    `INSERT INTO fix_checks (fix_id, position, at, check_key, check_expect, check_oracle, check_text, actor)
     SELECT fix_id, 0, opened_at, check_key, check_expect, check_oracle, check_text,
       CASE WHEN json_valid(data) THEN CASE WHEN json_type(data, '$.openedBy') = 'text' THEN json_extract(data, '$.openedBy') END END
     FROM fixes WHERE NOT EXISTS (SELECT 1 FROM fix_checks c WHERE c.fix_id = fixes.fix_id)`,
  );
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

/** The connection Store.open makes: the file ready for it, WAL, and the schema brought up to this version. */
export function openDatabase(path: string): SqliteDatabase {
  if (path !== ':memory:') {
    const dir = dirname(path);
    // Recordings hold prompts and tool I/O: a new directory is the owner's alone. One already there
    // (or a link where it goes) holds a store only when it is a directory of this user's that not
    // every user can write to (storeDirProblem); nothing is written into it before that.
    if (!lexists(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const unfit = storeDirProblem(dir);
    if (unfit) throw new Error(unfit);
    // Keep the directory out of git without touching the project's .gitignore. `wx` never follows
    // a symbolic link a checkout could have planted there.
    createOnce(join(dir, '.gitignore'), '*\n');
    // An empty file is a valid new SQLite database; SQLite gives its WAL and shared-memory files
    // the database file's permissions. Made exclusively and never through a link; one already there
    // (and its WAL and shared-memory files) is opened only when it is a regular file of this user's.
    createStoreFile(path);
    const problem = storeFileProblem(path);
    if (problem) throw new Error(problem);
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
      if (/no such module: fts5/i.test(messageOf(err))) throw new Error(noFullTextSearch(), { cause: err });
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
    addVersion6(db, found);
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (err) {
    rollBack(db);
    throw err;
  }
  return db;
}

/** The connection Store.openReadOnly makes: to a store that is a regular file of this user's, as Store.open opens one. */
export function openDatabaseReadOnly(path: string): SqliteDatabase {
  const problem = path === ':memory:' ? null : storeFileProblem(path);
  if (problem) throw new Error(problem);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 10000');
    const found = storedSchemaVersion(db);
    if (found !== null && found > SCHEMA_VERSION) {
      throw new Error(`${path} was written by a newer Shadowlap (store schema v${found}; this build understands v${SCHEMA_VERSION}). Upgrade Shadowlap, or point --db at another store.`);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
