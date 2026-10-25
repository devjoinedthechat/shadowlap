import { basename } from 'node:path';
import { CHECK_STATUSES, classifyRun, filedTestAttempt, hasRecordedCommand, isFailedOutcome, kindLabel, runOutcome, type AttemptKind, type CheckStatus, type ClassifiableRun, type RunAsk, type RunKind, type RunMode, type RunOutcome, type RunStatus, type Store } from '@shadowlap/engine';

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
  /** The last blame of the run: `unsettled` when it placed the failure on no call only because its first probe couldn't tell. */
  blame: { at: number; outcome: string; callNo: number | null; rescuedRunId: string | null; unsettled: boolean } | null;
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
}

export interface RunIndex {
  /** Newest first, as `shadowlap ls` lists them. */
  runs: IndexedRun[];
  byId: Map<string, IndexedRun>;
  /** The attempts bundled under each run, oldest first. */
  attempts: Map<string, IndexedRun[]>;
  /** Runs that are not bundled attempts, and attempts that are. */
  counts: { runs: number; attempts: number };
}

const INDEX_SQL = `
SELECT r.run_id AS id, r.parent_run_id AS parent, r.mode AS mode, r.status AS status, r.command AS command,
       r.code_version AS code, r.started_at AS started, r.ended_at AS ended,
       r.divergence ->> '$.callNo' AS div_call, r.divergence ->> '$.type' AS div_type,
       r.meta -> '$.labels' AS labels, r.meta -> '$.imported' AS imported, r.meta -> '$.covers' AS covers,
       r.meta -> '$.repeat' AS rep, r.meta -> '$.probe' AS probe, r.meta -> '$.verify' AS verify,
       r.meta -> '$.test' AS test, r.meta -> '$.checks' AS checks, r.meta -> '$.blame' AS blame, r.meta -> '$.chaos' AS chaos,
       r.meta -> '$.interventions' AS interventions, r.meta -> '$.injection' AS injection, r.meta -> '$.task' AS task,
       r.meta ->> '$.author' AS author, r.meta ->> '$.ci' AS ci,
       (SELECT COUNT(*) FROM call_events c WHERE c.run_id = r.run_id AND c.phase = 'start') AS calls,
       -- Through the store's index of judge calls alone (call_events_judge, whose condition this
       -- repeats word for word, json_extract and all), so leaving them out reads no call's metadata.
       (SELECT COUNT(*) FROM call_events c WHERE c.run_id = r.run_id AND c.phase = 'start' AND json_extract(c.meta, '$.scope') = 'shadowlap:judge') AS judge_calls,
       CASE WHEN r.status = 'failed' THEN EXISTS (
         SELECT 1 FROM call_events x WHERE x.run_id = r.run_id AND x.phase = 'end' AND x.outcome = 'error' AND x.meta ->> '$.injected' = 1
       ) ELSE 0 END AS injected,
       CASE WHEN r.divergence IS NOT NULL AND r.meta -> '$.test' IS NOT NULL THEN EXISTS (
         SELECT 1 FROM call_events x WHERE x.run_id = r.run_id AND x.phase = 'end' AND x.outcome = 'error'
           AND (x.meta ->> '$.offline' = 1 OR x.meta ->> '$.error.name' = 'ShadowlapOffline')
       ) ELSE 0 END AS offline,
       (SELECT f.check_text FROM fix_links l JOIN fixes f ON f.fix_id = l.fix_id
         WHERE l.ref = r.run_id AND l.kind = 'failing'
         ORDER BY f.status = 'applied', f.opened_at DESC LIMIT 1) AS fix_check
FROM runs r
ORDER BY r.started_at DESC, r.run_id DESC`;

/** The store's change counters for what the index reads (`Store.changeCounts`), in one statement. */
const VERSION_SQL = `SELECT (SELECT n FROM change_counts WHERE name = 'runs') AS runs, (SELECT n FROM change_counts WHERE name = 'fixes') AS fixes,
       (SELECT COALESCE(MAX(rowid), 0) FROM call_events) AS calls`;

/** What each finished recording's user asked first, kept since the row given (`run_asks`, in the order kept). */
const ASKS_SQL = `SELECT rowid AS at, run_id AS id, key, ask FROM run_asks WHERE rowid > ? ORDER BY rowid`;

/** What the asks kept for a run were worked out from: a finished run's never change. */
const ASK_FORMAT = 'a1';
export const askKeyOf = (r: Pick<IndexedRun, 'status' | 'endedAt' | 'calls'>): string => `${ASK_FORMAT}|${r.status}|${String(r.endedAt)}|${r.calls}`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A JSON value read with `->`: always JSON text, or null when the key is absent. */
function json(v: unknown): unknown {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v) as unknown;
  } catch {
    return null;
  }
}

/** Metadata as Shadowlap writes it; anything else (a run from a pack can carry anything) is dropped. */
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
    blame: isObject(blame) ? { at: num(blame.at) ?? 0, outcome: str(blame.outcome) ?? '', callNo: num(blame.callNo), rescuedRunId: str(blame.rescuedRunId), unsettled: blame.unsettled === true } : null,
    chaos: isObject(chaos) ? { preset: str(chaos.preset) ?? '', callNo: num(chaos.callNo), session: str(chaos.session) ?? '', attempt: num(chaos.attempt), golden: str(chaos.golden) } : null,
    interventions: Array.isArray(interventions) ? interventions.filter(isObject) : null,
    injection: isObject(injection) ? injection : null,
    task: isObject(task) ? task : null,
    author: str(row.author),
    ci: str(row.ci),
  };
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

interface KeptIndex {
  version: string;
  index: RunIndex;
  /** The newest `run_asks` row read into the index. */
  asksAt: number;
}

const kept = new WeakMap<Store, KeptIndex>();

/**
 * Where what the index reads stands: the runs (any run added, changed or deleted), the fixes and
 * their links, and the newest call event. Each moves with every write to what it counts, by this
 * connection or any other; a write the index doesn't read (run totals, the search index) moves none.
 */
function versionOf(store: Store): string {
  const v = store.query(VERSION_SQL)[0];
  return `${String(v?.runs)}|${String(v?.fixes)}|${String(v?.calls)}`;
}

/** Reads into the index what recordings' users asked that was kept since it last looked. */
function readAsks(store: Store, entry: KeptIndex): void {
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

/** Reads and classifies every run in the store, or returns the index read before when no run, call or fix changed since. */
export function loadRunIndex(store: Store): RunIndex {
  const version = versionOf(store);
  let entry = kept.get(store);
  if (!entry || entry.version !== version) {
    entry = { version, index: readRunIndex(store), asksAt: 0 };
    kept.set(store, entry);
  }
  readAsks(store, entry);
  return entry.index;
}

/**
 * Runs `write`, which changes nothing the index reads (the run totals kept in `run_stats`, what users
 * asked, the search index), so the index read before stays current. Another connection's write
 * meanwhile moves the counters as any write does.
 */
export function keepingIndex<T>(_store: Store, write: () => T): T {
  return write();
}

function readRunIndex(store: Store): RunIndex {
  const rows = store.query(INDEX_SQL);
  const base = rows.map((row) => {
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
      calls: Number(row.calls),
      agentCalls: Number(row.calls) - Number(row.judge_calls),
      meta: readMeta(row),
      injected: Number(row.injected) === 1,
      offline: Number(row.offline) === 1,
      fixCheck: str(row.fix_check),
    };
  });
  const baseById = new Map(base.map((r) => [r.runId, r]));
  // The fork each blame rescued its run with: a probe that shows as a fork of its own.
  const rescued = new Map<string, string>();
  for (const r of base) if (r.meta.blame?.rescuedRunId) rescued.set(r.meta.blame.rescuedRunId, r.runId);

  const runs: IndexedRun[] = base.map((r) => {
    const c = classifiable(r);
    const p = r.parentRunId ? baseById.get(r.parentRunId) : undefined;
    // Classified by the agent's calls: a judge check's are none of what a replay reproduced or made.
    const parent = p ? { calls: p.agentCalls, status: p.status } : null;
    const rescues = r.meta.probe ? (rescued.get(r.runId) ?? null) : null;
    const cls = classifyRun(c, { calls: r.agentCalls, parent, rescued: rescues !== null });
    const outcome = fixedOutcome(runOutcome(c, { kind: cls.kind, calls: r.agentCalls, parent, injected: r.injected, offline: r.offline }), r.fixCheck);
    return {
      ...r,
      kind: cls.kind,
      attemptOf: cls.attemptOf,
      attemptKind: cls.attemptKind,
      bundled: false,
      rescues,
      outcome,
      failed: isFailedOutcome(outcome),
      label: kindLabel(cls.kind, r.divergence),
      source: captureSource({ command: { argv: r.argv }, meta: { imported: r.meta.imported } }),
      ask: undefined,
    };
  });
  const byId = new Map(runs.map((r) => [r.runId, r]));
  const attempts = new Map<string, IndexedRun[]>();
  let bundled = 0;
  // Oldest first, so each run's attempts come in the order they were made.
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i]!;
    if (!r.attemptKind || !r.attemptOf || !byId.has(r.attemptOf)) continue;
    // A test's attempt is filed only under a test run of the same golden and session that replayed
    // the same recording and is no attempt itself: one naming any other run (a pack can carry
    // anything) must not hide under it, or be deleted with it, and is listed as a run of its own.
    // The engine's rule, as `shadowlap rm` bundles attempts.
    if (r.attemptKind === 'test' && !filedTestAttempt(classifiable(r), classifiable(byId.get(r.attemptOf)!))) {
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
  return { runs, byId, attempts, counts: { runs: runs.length - bundled, attempts: bundled } };
}

/** How many ancestors a run has in the store (0 for a recording, 1 for its fork, …). */
export function depthOf(index: RunIndex, run: IndexedRun): number {
  let depth = 0;
  for (let p = run.parentRunId; p && depth < 1000; depth++) p = index.byId.get(p)?.parentRunId ?? null;
  return depth;
}
