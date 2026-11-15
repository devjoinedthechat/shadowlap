import { basename } from 'node:path';
import { CHECK_STATUSES, classifyRun, filedTestAttempt, hasRecordedCommand, isFailedOutcome, isObject, keptCaptureVerdict, kindLabel, leftFixLinkSql, lostRange, runOutcome, type AttemptKind, type CaptureVerdict, type CheckStatus, type ClassifiableRun, type RunAsk, type RunKind, type RunMode, type RunOutcome, type RunStatus, type StoreOf } from '@shadowlap/engine';
import { num, str } from './fields.js';

/**
 * Every run in the store, classified, from one light query: the run columns, the few fields of
 * `meta` that classification and the run list read, and each run's call count. No call is loaded.
 * The Runs table, its calendar and chips, the Overview, the sidebar and the status bar's counts
 * start here. The index is kept per store until a run, a call or a fix changes, as the store's change
 * counters say: keeping what was worked out about runs (their totals, what their user asked) changes
 * none of those, so it never makes the next request read and classify every run again. What each
 * finished recording's user asked first (`run_asks`), which its about line quotes, comes with the
 * index, and what was kept since is read into it a few rows at a time.
 */

export interface IndexedRun {
  runId: string;
  parentRunId: string | null;
  mode: RunMode;
  status: RunStatus;
  divergence: { callNo: number; type: string } | null;
  argv: string[];
  codeVersion: string | null;
  startedAt: number;
  endedAt: number | null;
  calls: number;
  /** The agent's calls: every call but a judge check's, which classification leaves out. */
  agentCalls: number;
  /**
   * Its call events: each call's start and end, and each try again. They are only ever added, and
   * go only with the run, so the count moves with every call the run starts or ends and with nothing
   * else: where its page stands (run-version.ts).
   */
  callEvents: number;
  meta: IndexedMeta;
  /** A run that exited with an error answered one of its calls with an injected failure (`--fail-at`). */
  injected: boolean;
  /** A test run that diverged had a call refused because it ran offline: the replay needed the network. */
  offline: boolean;
  kind: RunKind;
  /** For an attempt (`--repeat`, a blame probe, a verify attempt, an error-path preset's attempt): the run it came from. */
  attemptOf: string | null;
  attemptKind: AttemptKind | null;
  /**
   * An attempt bundled under a run in the store: left out of lists and counts. An attempt whose run
   * is gone has nowhere else to show, so it is listed like any run.
   */
  bundled: boolean;
  /** For the fork blame rescued a run with: the run it rescued. Blame made it as a probe; it shows as a fork. */
  rescues: string | null;
  outcome: RunOutcome;
  failed: boolean;
  /**
   * The check of the fix that lists the run among its failing runs (verify's target, a blamed run),
   * in words: a run that kept no outcome of its own failed that check (`fixedOutcome`).
   */
  fixCheck: string | null;
  /** The kind as the run list's line under the id says it: recording, capture, fork @n, clean replay, replay, test. */
  label: string;
  /** For a run with no command (built from a capture): the file it came from. */
  source: string | null;
  /**
   * For a finished recording: what its user asked first, as `run_asks` keeps it, which its about line
   * quotes; null when it asked nothing; undefined while it is not worked out (run-stats.ts `asksOf`).
   */
  ask: RunAsk | null | undefined;
}

export interface IndexedMeta {
  labels: string[];
  imported: { at: number; from: string } | null;
  covers: string[] | null;
  repeat: { group: string; attempt: number; of: number } | null;
  probe: { of: string; callNo: number; passed: boolean } | null;
  verify: { role: string; passed: boolean } | null;
  /**
   * Set by `shadowlap test`: the golden and session, and when the run says so, whether the golden may
   * fork and how many of the session's attempts must pass. A golden replayed more than once in the
   * session numbers its attempts (`attempt`), and each names the attempt it is filed under (`of`).
   */
  test: { golden: string; session: string; fork: boolean | null; passes: number | null; attempt: number | null; of: string | null } | null;
  /** Each check as stored, with its `status` when it has one (a result kept before checks had one reads as `ok` says). */
  checks: Array<{ ok: boolean; label: string; detail: string | null; status?: CheckStatus }> | null;
  /**
   * The last blame of the run: `unsettled` when it placed the failure on no call only because its first
   * probe couldn't tell; `range`, the two calls it was lost around or between, when no one call is pinned.
   */
  blame: { at: number; outcome: string; callNo: number | null; rescuedRunId: string | null; unsettled: boolean; range: { from: number; to: number; gradual?: true } | null } | null;
  /** Set on an attempt of an error-path preset (`test --chaos`, `replay --chaos`): bundled under the recording it forked. */
  chaos: { preset: string; callNo: number | null; session: string; attempt: number | null; golden: string | null } | null;
  /**
   * What the about line reads of a replay, as kept (loosely: a pack can carry anything): the flags it
   * ran with (`meta.interventions`), what an injection test made of it (`meta.injection`), and the
   * golden a model took over (`meta.task`).
   */
  interventions: unknown[] | null;
  injection: Record<string, unknown> | null;
  task: Record<string, unknown> | null;
  author: string | null;
  /** For a run made in CI (`author` is `ci`): the provider, such as `github`. */
  ci: string | null;
  /**
   * A capture's verdict by the rules on calls, as it kept it when it was imported (`meta.judged`,
   * engine `keptCaptureVerdict`): what the lists count it failed by, with no call read.
   */
  judged: CaptureVerdict['verdict'] | null;
}

export interface RunIndex {
  /** Newest first, as `shadowlap ls` lists them. */
  runs: IndexedRun[];
  byId: Map<string, IndexedRun>;
  /** The attempts bundled under each run, oldest first. */
  attempts: Map<string, IndexedRun[]>;
  /** Runs that are not bundled attempts, and attempts that are. */
  counts: { runs: number; attempts: number };
  /**
   * The newest call event counted into it. It moves as calls are added, which the index counts in
   * place, so what is worked out per look at the store (a recording's totals) is per this as well.
   */
  events: number;
  /** Moves when runs come, go or are filed again in place: what goes through `runs` in order starts again. */
  revision: number;
}

/**
 * A run's row in the index: its columns, the few fields of `meta` read, its call counts and the check
 * of the fix that lists it among its failing runs. `bounded`: the counts take the call events up to
 * the one numbered by the statement's parameter for each (`?`), as a patch counts them.
 */
function runColumns(bounded: boolean): string {
  const upTo = (t: string) => (bounded ? ` AND ${t}.rowid <= ?` : '');
  return `r.run_id AS id, r.parent_run_id AS parent, r.mode AS mode, r.status AS status, r.command AS command,
       r.code_version AS code, r.started_at AS started, r.ended_at AS ended,
       r.divergence ->> '$.callNo' AS div_call, r.divergence ->> '$.type' AS div_type,
       r.meta -> '$.labels' AS labels, r.meta -> '$.imported' AS imported, r.meta -> '$.covers' AS covers,
       r.meta -> '$.repeat' AS rep, r.meta -> '$.probe' AS probe, r.meta -> '$.verify' AS verify,
       r.meta -> '$.test' AS test, r.meta -> '$.checks' AS checks, r.meta -> '$.blame' AS blame, r.meta -> '$.chaos' AS chaos,
       r.meta -> '$.interventions' AS interventions, r.meta -> '$.injection' AS injection, r.meta -> '$.task' AS task,
       r.meta ->> '$.author' AS author, r.meta ->> '$.ci' AS ci, r.meta -> '$.judged' AS judged,
       -- The calls it started and all its call events, in one pass over its entries in the primary
       -- key's index: a pass of their own for the events took a whole read of 10,000 runs 25% longer.
       (SELECT json_array(COUNT(*) FILTER (WHERE c.phase = 'start'), COUNT(*)) FROM call_events c WHERE c.run_id = r.run_id${upTo('c')}) AS counts,
       -- Through the store's index of judge calls alone (call_events_judge, whose condition this
       -- repeats word for word, json_extract and all), so leaving them out reads no call's metadata.
       (SELECT COUNT(*) FROM call_events c WHERE c.run_id = r.run_id AND c.phase = 'start' AND json_extract(c.meta, '$.scope') = 'shadowlap:judge'${upTo('c')}) AS judge_calls,
       CASE WHEN r.status = 'failed' THEN EXISTS (
         SELECT 1 FROM call_events x WHERE x.run_id = r.run_id AND x.phase = 'end' AND x.outcome = 'error' AND x.meta ->> '$.injected' = 1${upTo('x')}
       ) ELSE 0 END AS injected,
       CASE WHEN r.divergence IS NOT NULL AND r.meta -> '$.test' IS NOT NULL THEN EXISTS (
         SELECT 1 FROM call_events x WHERE x.run_id = r.run_id AND x.phase = 'end' AND x.outcome = 'error'
           AND (x.meta ->> '$.offline' = 1 OR x.meta ->> '$.error.name' = 'ShadowlapOffline')${upTo('x')}
       ) ELSE 0 END AS offline,
       (SELECT f.check_text FROM fix_links l JOIN fixes f ON f.fix_id = l.fix_id
         WHERE l.ref = r.run_id AND l.kind = 'failing' AND NOT ${leftFixLinkSql('l')}
         ORDER BY f.status = 'applied', f.opened_at DESC LIMIT 1) AS fix_check`;
}

/** The newest entry of the store's log of runs written (`run_changes`), or NULL for a store that keeps none. */
const seqOf = (log: boolean) => (log ? '(SELECT COALESCE(MAX(seq), 0) FROM run_changes)' : 'NULL');

/** Every run, newest first, and where the store stood as they were read: one statement reads one state of the store. */
const indexSql = (log: boolean) => `
SELECT ${runColumns(false)},
       (SELECT n FROM change_counts WHERE name = 'runs') AS v_runs, (SELECT n FROM change_counts WHERE name = 'fixes') AS v_fixes,
       (SELECT COALESCE(MAX(rowid), 0) FROM call_events) AS v_calls, ${seqOf(log)} AS v_seq
FROM runs r
ORDER BY r.started_at DESC, r.run_id DESC`;

/** The store's change counters for what the index reads (`Store.changeCounts`), and the newest run written, in one statement. */
const versionSql = (log: boolean) => `SELECT (SELECT n FROM change_counts WHERE name = 'runs') AS runs, (SELECT n FROM change_counts WHERE name = 'fixes') AS fixes,
       (SELECT COALESCE(MAX(rowid), 0) FROM call_events) AS calls, ${seqOf(log)} AS seq`;

/** The rows of the runs named (a JSON array), their calls counted up to the event numbered by each `?` before it. */
const PATCH_SQL = `SELECT ${runColumns(true)} FROM runs r WHERE r.run_id IN (SELECT value FROM json_each(?))`;

/** The runs written after the log entry numbered `?`, up to the one numbered `?`, in the order written. */
const CHANGES_SQL = `SELECT seq, run_id AS id FROM run_changes WHERE seq > ? AND seq <= ? ORDER BY seq`;

/** The check of each fix that lists a run among its failing runs, but one it left: INDEX_SQL's `fix_check`, for every run at once. */
const FIX_CHECKS_SQL = `SELECT l.ref AS id, f.check_text AS check_text, f.status = 'applied' AS applied, f.opened_at AS opened
FROM fix_links l JOIN fixes f ON f.fix_id = l.fix_id WHERE l.kind = 'failing' AND NOT ${leftFixLinkSql('l')}`;

/** More runs written than this since the index last looked: reading them all is as quick. */
const PATCH_MAX = 512;

/**
 * The call events written after the one numbered `?` up to the one numbered `?`, each with what it
 * adds to INDEX_SQL's counts of its run, under INDEX_SQL's conditions word for word: a call started,
 * a judge check's, an injected failure, a call refused offline. Events are numbered as they are
 * written, and those up to the newest one seen were all written then, so each is counted once.
 * NOT INDEXED keeps SQLite on the events' numbers, so the cost is what was written since: left to
 * choose, it reads every event of every run through the primary key's index (0.4 s at 10,000 runs).
 */
const GROWN_SQL = `
SELECT e.run_id AS id, e.phase = 'start' AS start,
       e.phase = 'start' AND json_extract(e.meta, '$.scope') = 'shadowlap:judge' AS judge,
       r.status = 'failed' AND e.phase = 'end' AND e.outcome = 'error' AND e.meta ->> '$.injected' = 1 AS injected,
       r.divergence IS NOT NULL AND r.meta -> '$.test' IS NOT NULL AND e.phase = 'end' AND e.outcome = 'error'
         AND (e.meta ->> '$.offline' = 1 OR e.meta ->> '$.error.name' = 'ShadowlapOffline') AS offline
FROM call_events e NOT INDEXED JOIN runs r ON r.run_id = e.run_id
WHERE e.rowid > ? AND e.rowid <= ?`;

/** What each finished recording's user asked first, kept since the row given (`run_asks`, in the order kept). */
const ASKS_SQL = `SELECT rowid AS at, run_id AS id, key, ask FROM run_asks WHERE rowid > ? ORDER BY rowid`;

/** What the asks kept for a run were worked out from: a finished run's never change. */
const ASK_FORMAT = 'a1';
export const askKeyOf = (r: Pick<IndexedRun, 'status' | 'endedAt' | 'calls'>): string => `${ASK_FORMAT}|${r.status}|${String(r.endedAt)}|${r.calls}`;

/** A JSON value read with `->`: always JSON text, or null when the key is absent. */
function json(v: unknown): unknown {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}

/** Metadata as shadowlap writes it; anything else (a run from a pack can carry anything) is dropped. */
function readMeta(row: Record<string, unknown>): IndexedMeta {
  const labels = json(row.labels);
  const imported = json(row.imported);
  const covers = json(row.covers);
  const repeat = json(row.rep);
  const probe = json(row.probe);
  const verify = json(row.verify);
  const test = json(row.test);
  const checks = json(row.checks);
  const blame = json(row.blame);
  const chaos = json(row.chaos);
  const interventions = json(row.interventions);
  const injection = json(row.injection);
  const task = json(row.task);
  return {
    labels: Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : [],
    imported: isObject(imported) ? { at: num(imported.at) ?? 0, from: str(imported.from) ?? '' } : null,
    covers: Array.isArray(covers) && covers.length ? covers.filter((c): c is string => typeof c === 'string') : null,
    repeat: isObject(repeat) ? { group: str(repeat.group) ?? '', attempt: num(repeat.attempt) ?? 0, of: num(repeat.of) ?? 0 } : null,
    probe: isObject(probe) ? { of: str(probe.of) ?? '', callNo: num(probe.callNo) ?? 0, passed: probe.passed === true } : null,
    verify: isObject(verify) ? { role: str(verify.role) ?? '', passed: verify.passed === true } : null,
    test: isObject(test) ? { golden: str(test.golden) ?? '', session: str(test.session) ?? '', fork: typeof test.fork === 'boolean' ? test.fork : null, passes: num(test.passes), attempt: num(test.attempt), of: str(test.of) } : null,
    checks: Array.isArray(checks) ? checks.filter(isObject).map((c) => ({ ok: c.ok === true, label: str(c.label) ?? '', detail: str(c.detail), ...(typeof c.status === 'string' && (CHECK_STATUSES as readonly string[]).includes(c.status) ? { status: c.status as CheckStatus } : {}) })) : null,
    blame: isObject(blame) ? { at: num(blame.at) ?? 0, outcome: str(blame.outcome) ?? '', callNo: num(blame.callNo), rescuedRunId: str(blame.rescuedRunId), unsettled: blame.unsettled === true, range: lostRange(blame.range) } : null,
    chaos: isObject(chaos) ? { preset: str(chaos.preset) ?? '', callNo: num(chaos.callNo), session: str(chaos.session) ?? '', attempt: num(chaos.attempt), golden: str(chaos.golden) } : null,
    interventions: Array.isArray(interventions) ? interventions.filter(isObject) : null,
    injection: isObject(injection) ? injection : null,
    task: isObject(task) ? task : null,
    author: str(row.author),
    ci: str(row.ci),
    judged: importVerdict(json(row.judged)),
  };
}

/** A capture's verdict as its import kept it, read field by field as the engine reads it: a run can come from someone else's pack. */
function importVerdict(judged: unknown): IndexedMeta['judged'] {
  const meta: Record<string, unknown> = { judged };
  return keptCaptureVerdict({ meta })?.verdict ?? null;
}

/** What a run with no command came from, shown where its command would be: the capture's file name. */
export function captureSource(run: { command: { argv: readonly string[] }; meta?: { imported?: { from: string } | null } }): string | null {
  return hasRecordedCommand(run) ? null : basename(run.meta?.imported?.from ?? '') || 'a capture';
}

/**
 * How a run came out (the engine's `runOutcome`), with what Fixes knows on top: a run a fix lists
 * among its failing runs (verify was told it fails, or blame reproduced it) that kept no outcome of
 * its own failed that fix's check. The Runs table, the Overview, the calendar and the run's own page
 * all read this, so a run says the same everywhere.
 */
export function fixedOutcome(outcome: RunOutcome, fixCheck: string | null): RunOutcome {
  return outcome.kind === 'none' && fixCheck ? { kind: 'check-failed', check: fixCheck } : outcome;
}

/** The shape classification reads, from an indexed run. */
export function classifiable(r: Pick<IndexedRun, 'runId' | 'parentRunId' | 'mode' | 'status' | 'divergence' | 'meta'>): ClassifiableRun {
  const m = r.meta;
  return {
    runId: r.runId,
    parentRunId: r.parentRunId,
    mode: r.mode,
    status: r.status,
    divergence: r.divergence,
    meta: {
      ...(m.imported ? { imported: m.imported } : {}),
      ...(m.covers ? { covers: m.covers } : {}),
      ...(m.repeat ? { repeat: m.repeat } : {}),
      ...(m.probe ? { probe: m.probe } : {}),
      ...(m.verify ? { verify: m.verify } : {}),
      ...(m.test ? { test: m.test } : {}),
      ...(m.checks ? { checks: m.checks } : {}),
      ...(m.blame ? { blame: m.blame } : {}),
      ...(m.chaos ? { chaos: m.chaos } : {}),
    },
  };
}

/** A run's filing as an attempt as classification gives it, before the rule that sets some apart (`filedTestAttempt`). */
type Filing = Pick<IndexedRun, 'attemptOf' | 'attemptKind'>;

interface KeptIndex {
  /** The runs and fixes counters as the index last stood. */
  runs: string;
  fixes: string;
  /** The newest entry of the store's log of runs written that the index has read; null for a store that keeps none. */
  seq: number | null;
  /** The newest call event the index has counted. */
  callsAt: number;
  index: RunIndex;
  /** The newest `run_asks` row read into the index. */
  asksAt: number;
  /** Each run's filing as classification gave it: a patch files the runs again from it. */
  filing: Map<string, Filing>;
}

const kept = new WeakMap<object, KeptIndex>();

/** Stores known to keep the log of runs written: one opened by a build from before it keeps none until a newer one opens it to write. */
const logged = new WeakSet();
function keepsLog(store: StoreOf<'readModels'>): boolean {
  if (logged.has(store)) return true;
  if (!store.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'run_changes'`).length) return false;
  logged.add(store);
  return true;
}

interface Version {
  runs: string;
  fixes: string;
  calls: number;
  seq: number | null;
}

/**
 * Where what the index reads stands: the runs (any run added, changed or deleted, and the newest of
 * them written), the fixes and their links, and the newest call event. Each moves with every write to
 * what it counts, by this connection or any other; a write the index doesn't read (run totals, the
 * search index) moves none.
 */
function versionOf(store: StoreOf<'readModels'>): Version {
  const log = keepsLog(store);
  const v = store.query(versionSql(log))[0];
  return { runs: String(v?.runs), fixes: String(v?.fixes), calls: Number(v?.calls ?? 0), seq: log && v?.seq !== null && v?.seq !== undefined ? Number(v.seq) : null };
}

/** Reads into the index what recordings' users asked that was kept since it last looked. */
function readAsks(store: StoreOf<'readModels'>, entry: KeptIndex): void {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = store.query(ASKS_SQL, entry.asksAt);
  } catch {
    // a store without the table: no asks kept yet
    return;
  }
  for (const row of rows) {
    entry.asksAt = Math.max(entry.asksAt, Number(row.at));
    const run = entry.index.byId.get(String(row.id));
    if (!run || run.status === 'running' || row.key !== askKeyOf(run)) continue;
    run.ask = parseAsk(row.ask);
  }
}

/** A kept ask as `runAsk` gives it, or null (it asked nothing, or what was kept can't be read). */
export function parseAsk(v: unknown): RunAsk | null {
  if (typeof v !== 'string') return null;
  const a = json(v);
  return isObject(a) && typeof a.text === 'string' ? { text: a.text, agent: a.agent === true, batch: a.batch === true } : null;
}

/**
 * Reads and classifies every run in the store, or returns the index read before when nothing it
 * reads changed since. What changed is taken into it in place: calls added (a run recording, a replay
 * making its calls) are counted into the runs they belong to; runs written (one started, ended,
 * labelled, deleted) are read again, as the store's log of runs written names them, and a change to
 * the fixes reads again which check lists each run failing. The runs read again are classified anew
 * with their children, whose kind reads their parent's count, and the rest of the index stands: a
 * status bar polling while a run records, or while a session writes a run a second, costs a read of
 * what was written since, where every run was read and classified again (137 ms a poll at 10,000
 * runs). A store with no log, or one written further than the log keeps, is read whole.
 */
/**
 * What a request about a run tells the read-model threads (read-pool.ts): the run, which the thread
 * that read it last answers for, and how many calls it has, as the index counts them: whether
 * another thread may take the request meanwhile, reading the run again.
 */
export function runAffinity(store: StoreOf<'readModels'>, runId: string): { affinity: string; calls?: number } {
  const r = loadRunIndex(store).byId.get(runId);
  return r ? { affinity: runId, calls: r.calls } : { affinity: runId };
}

export function loadRunIndex(store: StoreOf<'readModels'>): RunIndex {
  const v = versionOf(store);
  let entry = kept.get(store);
  if (!entry || !patch(store, entry, v)) {
    entry = { ...readRunIndex(store), asksAt: 0 };
    kept.set(store, entry);
  }
  readAsks(store, entry);
  return entry.index;
}

/**
 * Takes into the index what was written since it last stood as `entry` says, up to `v`: false when
 * it can't (the store keeps no log of runs written, or one gone past what the log keeps, or too many
 * runs written to be worth it, or an event of a run it doesn't know), and the index is read whole.
 */
function patch(store: StoreOf<'readModels'>, entry: KeptIndex, v: Version): boolean {
  const runsMoved = v.runs !== entry.runs;
  const fixesMoved = v.fixes !== entry.fixes;
  let written: string[] = [];
  if (runsMoved) {
    if (v.seq === null || entry.seq === null || v.seq <= entry.seq) return false;
    const rows = store.query(CHANGES_SQL, entry.seq, v.seq);
    // The log keeps the last few thousand writes: one gone since the index looked, and it is read whole.
    if (!rows.length || Number(rows[0]!.seq) !== entry.seq + 1) return false;
    written = [...new Set(rows.map((r) => String(r.id)))];
    if (written.length > PATCH_MAX) return false;
  }
  // Fewer events than were counted: a run's deletion took some out, and a call written since may have
  // taken the number of one of them. Read whole.
  const calls = v.calls;
  if (calls < entry.callsAt) return false;
  const index = entry.index;
  // Read again: the runs written, and the children of each, whose kind reads their parent's count.
  const again = new Set(written);
  if (again.size) for (const r of index.runs) if (r.parentRunId !== null && again.has(r.parentRunId)) again.add(r.runId);
  const fresh = new Map<string, ReturnType<typeof baseOf>>();
  if (again.size) for (const row of store.query(PATCH_SQL, calls, calls, calls, calls, JSON.stringify([...again]))) fresh.set(String(row.id), baseOf(row));
  // A run deleted: its calls' numbers may be taken by calls written since, which counting from the
  // newest counted would miss. Read whole, as a delete is rare beside a run started or ended.
  for (const id of again) if (!fresh.has(id) && index.byId.has(id)) return false;
  // The other runs count the events written since; a run read again has its own counted to `calls`.
  const grown = calls > entry.callsAt ? store.query(GROWN_SQL, entry.callsAt, calls).filter((row) => !again.has(String(row.id))) : [];
  if (grown.some((row) => !index.byId.has(String(row.id)))) return false;
  // From here on the index changes: nothing below gives up.
  const changed = new Set<string>();
  for (const row of grown) {
    const r = index.byId.get(String(row.id))!;
    r.callEvents++;
    if (Number(row.start) === 1) {
      r.calls++;
      if (Number(row.judge) !== 1) r.agentCalls++;
    }
    if (Number(row.injected) === 1) r.injected = true;
    if (Number(row.offline) === 1) r.offline = true;
    changed.add(r.runId);
  }
  for (const id of again) {
    const b = fresh.get(id);
    const old = index.byId.get(id);
    // Written and deleted between two looks: never in the index.
    if (!b) continue;
    if (old) {
      // What the user asked is kept while what it was worked out from stands.
      const ask = askKeyOf(old) === askKeyOf(b) ? old.ask : undefined;
      Object.assign(old, b, { ask, source: captureSource({ command: { argv: b.argv }, meta: { imported: b.meta.imported } }) });
    } else {
      index.byId.set(id, { ...b, kind: 'recording', attemptOf: null, attemptKind: null, bundled: false, rescues: null, outcome: { kind: 'none' }, failed: false, label: '', source: captureSource({ command: { argv: b.argv }, meta: { imported: b.meta.imported } }), ask: undefined });
    }
    changed.add(id);
  }
  // The fixes changed: which check lists each run failing, read again for every run.
  if (fixesMoved) {
    const best = new Map<string, { check: string | null; applied: boolean; opened: number }>();
    for (const row of store.query(FIX_CHECKS_SQL)) {
      const id = String(row.id);
      const cand = { check: str(row.check_text), applied: Number(row.applied) === 1, opened: Number(row.opened) };
      const had = best.get(id);
      // As INDEX_SQL orders them: a fix not applied first, then the newest opened.
      if (!had || (had.applied && !cand.applied) || (had.applied === cand.applied && cand.opened > had.opened)) best.set(id, cand);
    }
    for (const r of index.byId.values()) {
      const check = best.get(r.runId)?.check ?? null;
      if (check === r.fixCheck) continue;
      r.fixCheck = check;
      changed.add(r.runId);
    }
  }
  if (changed.size) settle(entry, changed, again.size > 0);
  entry.runs = v.runs;
  entry.fixes = v.fixes;
  if (v.seq !== null) entry.seq = v.seq;
  entry.callsAt = calls;
  index.events = calls;
  return true;
}

/**
 * Classifies again the runs `changed` touched, with their children and the probe each rescued fork
 * names, and files every run as an attempt again; `listed`: runs came, went or were read again, so
 * the list is put back in order. Classification and filing are what a whole read does for each.
 */
function settle(entry: KeptIndex, changed: Set<string>, listed: boolean): void {
  const index = entry.index;
  if (listed) {
    index.runs = [...index.byId.values()].sort((a, b) => b.startedAt - a.startedAt || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
    index.revision++;
  }
  // The fork each blame rescued its run with, which shows as a fork of its own.
  const rescued = new Map<string, string>();
  for (const r of index.runs) if (r.meta.blame?.rescuedRunId) rescued.set(r.meta.blame.rescuedRunId, r.runId);
  for (const r of index.runs) {
    const rescues = r.meta.probe ? (rescued.get(r.runId) ?? null) : null;
    if (rescues === r.rescues) continue;
    r.rescues = rescues;
    changed.add(r.runId);
  }
  let refile = listed;
  for (const r of index.runs) {
    if (!changed.has(r.runId) && !(r.parentRunId !== null && changed.has(r.parentRunId))) continue;
    const c = classified(r, r.parentRunId ? index.byId.get(r.parentRunId) : undefined, r.rescues);
    Object.assign(r, { kind: c.kind, outcome: c.outcome, failed: c.failed, label: c.label });
    const was = entry.filing.get(r.runId);
    if (was?.attemptOf !== c.attemptOf || was.attemptKind !== c.attemptKind) refile = true;
    entry.filing.set(r.runId, { attemptOf: c.attemptOf, attemptKind: c.attemptKind });
  }
  // Calls counted in change no run's filing: a recording's poll files nothing again.
  if (refile) {
    file(index, entry.filing);
    index.revision++;
  }
}

/**
 * Files each run under the run it is an attempt of, as classification has it (`filing`), oldest
 * first so each run's attempts come in the order they were made, and counts the runs and attempts.
 */
function file(index: RunIndex, filing: Map<string, Filing>): void {
  const attempts = new Map<string, IndexedRun[]>();
  let bundled = 0;
  for (let i = index.runs.length - 1; i >= 0; i--) {
    const r = index.runs[i]!;
    const f = filing.get(r.runId);
    r.attemptOf = f?.attemptOf ?? null;
    r.attemptKind = f?.attemptKind ?? null;
    r.bundled = false;
    if (!r.attemptKind || !r.attemptOf || !index.byId.has(r.attemptOf)) continue;
    // A test's attempt is filed only under a test run of the same golden and session that replayed
    // the same recording and is no attempt itself: one naming any other run (a pack can carry
    // anything) must not hide under it, or be deleted with it, and is listed as a run of its own.
    // The engine's rule, as `shadowlap rm` bundles attempts.
    if (r.attemptKind === 'test' && !filedTestAttempt(classifiable(r), classifiable(index.byId.get(r.attemptOf)!))) {
      r.attemptOf = null;
      r.attemptKind = null;
      continue;
    }
    r.bundled = true;
    bundled++;
    const list = attempts.get(r.attemptOf);
    if (list) list.push(r);
    else attempts.set(r.attemptOf, [r]);
  }
  index.attempts = attempts;
  index.counts = { runs: index.runs.length - bundled, attempts: bundled };
}

/** A run's call counts as INDEX_SQL reads them. */
function countsOf(row: Record<string, unknown>): Pick<IndexedRun, 'calls' | 'agentCalls' | 'callEvents' | 'injected' | 'offline'> {
  const [calls, callEvents] = JSON.parse(String(row.counts)) as [number, number];
  return { calls, agentCalls: calls - Number(row.judge_calls), callEvents, injected: Number(row.injected) === 1, offline: Number(row.offline) === 1 };
}

/** A run's row as INDEX_SQL and PATCH_SQL read it: its columns, its counts and its metadata. */
function baseOf(row: Record<string, unknown>) {
  const command = json(row.command);
  const argv = isObject(command) && Array.isArray(command.argv) ? command.argv.filter((a): a is string => typeof a === 'string') : [];
  const divCall = num(row.div_call);
  return {
    runId: String(row.id),
    parentRunId: str(row.parent),
    mode: row.mode as RunMode,
    status: row.status as RunStatus,
    divergence: divCall !== null ? { callNo: divCall, type: str(row.div_type) ?? '' } : null,
    argv,
    codeVersion: str(row.code),
    startedAt: Number(row.started),
    endedAt: num(row.ended),
    ...countsOf(row),
    meta: readMeta(row),
    fixCheck: str(row.fix_check),
  };
}

type BaseRun = Pick<IndexedRun, 'runId' | 'parentRunId' | 'mode' | 'status' | 'divergence' | 'meta' | 'agentCalls' | 'injected' | 'offline' | 'fixCheck'>;

/** A run's kind, outcome and filing as an attempt, from its own fields and its parent's. */
function classified(r: BaseRun, p: Pick<IndexedRun, 'agentCalls' | 'status'> | undefined, rescues: string | null) {
  const c = classifiable(r);
  // Classified by the agent's calls: a judge check's are none of what a replay reproduced or made.
  const parent = p ? { calls: p.agentCalls, status: p.status } : null;
  const cls = classifyRun(c, { calls: r.agentCalls, parent, rescued: rescues !== null });
  const outcome = fixedOutcome(runOutcome(c, { kind: cls.kind, calls: r.agentCalls, parent, injected: r.injected, offline: r.offline }), r.fixCheck);
  return { kind: cls.kind, attemptOf: cls.attemptOf, attemptKind: cls.attemptKind, outcome, failed: isFailedOutcome(outcome), label: kindLabel(cls.kind, r.divergence) };
}

/**
 * Runs `write`, which changes nothing the index reads (the run totals kept in `run_stats`, what users
 * asked, the search index), so the index read before stays current. Another connection's write
 * meanwhile moves the counters as any write does.
 */
export function keepingIndex<T>(_store: StoreOf<never>, write: () => T): T {
  return write();
}

/** Every run read and classified, and where the store stood as they were read: its counters, its newest run written and its newest call event. */
function readRunIndex(store: StoreOf<'readModels'>): Omit<KeptIndex, 'asksAt'> {
  const log = keepsLog(store);
  const rows = store.query(indexSql(log));
  // No runs, no version read with them: the counters as they are now (no run, so no call event to count).
  const at: Version = rows[0] ? { runs: String(rows[0].v_runs), fixes: String(rows[0].v_fixes), calls: Number(rows[0].v_calls), seq: log && rows[0].v_seq !== null ? Number(rows[0].v_seq) : null } : versionOf(store);
  const base = rows.map(baseOf);
  const baseById = new Map(base.map((r) => [r.runId, r]));
  // The fork each blame rescued its run with: a probe that shows as a fork of its own.
  const rescued = new Map<string, string>();
  for (const r of base) if (r.meta.blame?.rescuedRunId) rescued.set(r.meta.blame.rescuedRunId, r.runId);

  const filing = new Map<string, Filing>();
  const runs: IndexedRun[] = base.map((r) => {
    const rescues = r.meta.probe ? (rescued.get(r.runId) ?? null) : null;
    const c = classified(r, r.parentRunId ? baseById.get(r.parentRunId) : undefined, rescues);
    filing.set(r.runId, { attemptOf: c.attemptOf, attemptKind: c.attemptKind });
    return {
      ...r,
      ...c,
      bundled: false,
      rescues,
      source: captureSource({ command: { argv: r.argv }, meta: { imported: r.meta.imported } }),
      ask: undefined,
    };
  });
  const index: RunIndex = { runs, byId: new Map(runs.map((r) => [r.runId, r])), attempts: new Map(), counts: { runs: runs.length, attempts: 0 }, events: at.calls, revision: 0 };
  file(index, filing);
  return { index, runs: at.runs, fixes: at.fixes, seq: at.seq, callsAt: at.calls, filing };
}

/** How many ancestors a run has in the store (0 for a recording, 1 for its fork, …). */
export function depthOf(index: RunIndex, run: IndexedRun): number {
  let depth = 0;
  for (let p = run.parentRunId; p && depth < 1000; depth++) p = index.byId.get(p)?.parentRunId ?? null;
  return depth;
}
