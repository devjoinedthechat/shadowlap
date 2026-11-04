import { createHash } from 'node:crypto';
import {
  captureVerdict,
  checkCallAt,
  checkStatus,
  checksVerdict,
  familyGoldens,
  familySpecs,
  judgeByFamily,
  keptCaptureVerdict,
  messageOf,
  parseTests,
  rulesOnCalls,
  storedCalls,
  type CallRecord,
  type CheckStatus,
  type ParentOf,
  type Price,
  type RulesOnCalls,
  type RunRecord,
  type Store,
  type StoredCheck,
  type TestEntry,
} from '@shadowlap/engine';
import { lookupRun, noSuchRun } from './api.js';
import { answer, failed, type ReadTable } from './read-registry.js';
import { runCalls } from './run-calls.js';
import { loadRunIndex, type IndexedRun, type RunIndex } from './run-index.js';

/**
 * A run's outcome by checks, as its status says it everywhere (A13, E26): the run payload and every
 * list row carry it, so Runs, the sidebar, the Overview's Recent runs and the run's own page say the
 * same. It is, the first that holds:
 *
 * - the run's own checks, as it was made (`shadowlap test`, `--expect`, an attempt's oracle);
 * - a capture's verdict by the project's rules on calls, kept as it was imported, or judged again
 *   from its calls once the rules changed (family-checks.ts);
 * - for a finished run that kept no verdict of its own, its family's checks: those of the goldens
 *   packed from its recording or from a replay or a fork of it, as shadowlap.config.json gives them
 *   now, judged from its recording as `shadowlap check` judges one, a judge without a recorded verdict
 *   inconclusive. A run recorded before them says so (`today`).
 *
 * Each result carries its status, detail and the call it names. Judging reads a run's calls, so it is
 * a pooled read, beside the server: what is judged is kept per thread and per config version (and
 * the goldens, and the run's calls), and a list judges what it hasn't yet within a budget of calls,
 * as its totals are. Its own kind of job, `outcome`, answers one run whole.
 */

/** What the server reads of the project to judge runs by checks they were not given, put in a job as plain data. */
export interface OutcomeWork {
  /** The config file's version (its bytes' SHA-256, or `absent`): what judged runs are kept per. */
  version: string;
  /** shadowlap.config.json's `tests`, as written: read on the thread (parseTests). */
  tests: unknown;
  /** The project's folder: the tests entries' and the goldens' folders are relative to it. */
  dir: string;
  /** When the config file was last written (ms), or null without one. */
  changedAt: number | null;
  /** The project's goldens: each pack's folder, the run it holds, and when it was packed. */
  goldens: Array<{ path: string; runId: string | null; packedAt: number | null }>;
  prices?: Record<string, Price>;
}

/** A check as it came out on a run: its status, what it found, the call it turned on, and for a family's, its golden. */
export interface JudgedCheck {
  label: string;
  status: CheckStatus;
  detail: string | null;
  callNo: number | null;
  golden?: string;
}

/** A run's outcome by checks. */
export interface RunJudged {
  /** What judged it: its own checks, its import's (a capture, by the rules on calls), or its family's goldens' checks, from its recording. */
  by: 'own' | 'import' | 'family';
  verdict: CheckStatus;
  counts: { passed: number; failed: number; inconclusive: number; notApplicable: number };
  /** The call it turned on: the first failed check's. */
  callNo: number | null;
  /** The first check that failed, else the first that could not be decided: what the status names. */
  first: { label: string; detail: string | null } | null;
  /** Judged now against checks it was not made under: its family's, added after it was recorded, or rules on calls changed since its import. */
  today: boolean;
  /** The goldens whose checks judged it (`family`), nearest first. */
  goldens: string[];
  /** Why no check applied, where a verdict says (a capture none of whose rules had a call to read). */
  why: string | null;
  /** Each check: on the run's page; the lists leave them out. */
  checks?: JudgedCheck[];
}

/** What a job judges by, read once per thread and config version: the tests entries (or why they can't be read), the rules on calls, and a key for them all. */
interface ParsedWork {
  work: OutcomeWork;
  key: string;
  entries: TestEntry[];
  rules: RulesOnCalls;
  /** Why the config's tests can't be read: then only runs' own verdicts and kept ones say anything. */
  error: string | null;
}

/** A key for what the work judges by: the config's version and folder, when it changed, the goldens and the prices. */
export function outcomeKey(work: OutcomeWork | null): string {
  if (!work) return 'none';
  return createHash('sha1').update(JSON.stringify([work.version, work.dir, work.changedAt, work.goldens, work.prices ?? null])).digest('base64url');
}

const parsed = new Map<string, ParsedWork>();

function parse(work: OutcomeWork): ParsedWork {
  const key = outcomeKey(work);
  const known = parsed.get(key);
  if (known) return known;
  let entries: TestEntry[] = [];
  let error: string | null = null;
  try {
    entries = parseTests(work.tests);
  } catch (err) {
    error = messageOf(err);
  }
  const out: ParsedWork = { work, key, entries, rules: rulesOnCalls(entries), error };
  // A config edited many times keeps only its newest few readings.
  if (parsed.size >= 8) parsed.delete(parsed.keys().next().value!);
  parsed.set(key, out);
  return out;
}

/** What a run judged by its family or again by its rules is kept as, per thread: by the work it was judged by and where its calls stand. */
const judged = new Map<string, RunJudged | null>();
/** The most kept, the oldest going first: most are a run no golden of its family judges, kept as null. */
const KEEP = 5_000;

const keyOf = (w: ParsedWork, r: IndexedRun, kept: string | null) => `${w.key}|${r.runId}|${r.callEvents}|${r.status}|${String(r.endedAt)}|${kept ?? ''}`;

function keep(key: string, value: RunJudged | null): RunJudged | null {
  if (judged.size >= KEEP) judged.delete(judged.keys().next().value!);
  judged.set(key, value);
  return value;
}

const count = (checks: readonly Pick<StoredCheck, 'ok' | 'status'>[]) => {
  const statuses = checks.map((c) => checkStatus(c));
  const n = (s: CheckStatus) => statuses.filter((x) => x === s).length;
  return { passed: n('passed'), failed: n('failed'), inconclusive: n('inconclusive'), notApplicable: n('not-applicable') };
};

/** The check the status names: the first that failed, else the first that could not be decided. */
function firstOf(checks: ReadonlyArray<Pick<StoredCheck, 'ok' | 'status' | 'label' | 'detail'>>): { label: string; detail: string | null } | null {
  const c = checks.find((x) => checkStatus(x) === 'failed') ?? checks.find((x) => checkStatus(x) === 'inconclusive');
  return c ? { label: c.label, detail: c.detail } : null;
}

/** Each check with the call it turned on (a failed one's), and its golden. */
function judgedChecks(checks: ReadonlyArray<StoredCheck & { golden?: string; callNo?: number | null }>, callAt: (c: StoredCheck) => number | null): JudgedCheck[] {
  return checks.map((c) => {
    const status = checkStatus(c);
    return { label: c.label, status, detail: c.detail, callNo: c.callNo !== undefined ? c.callNo : status === 'failed' ? callAt(c) : null, ...(c.golden ? { golden: c.golden } : {}) };
  });
}

/** How to read a run's calls for judging it: once, when it is first needed. */
type Calls = () => CallRecord[];

/** The call a failed check turned on: from its detail alone, without the calls; with them, the first call past what a count allows too. */
function callAtWith(store: Store, calls: Calls | null): (c: Pick<StoredCheck, 'label' | 'detail'>) => number | null {
  if (!calls) return (c) => checkCallAt(c, null);
  const args = storedCalls(store).argsOf;
  return (c) => checkCallAt(c, calls(), args);
}

/** A run judged by its own checks, as it was made. */
function ownJudged(store: Store, r: IndexedRun, calls: Calls | null, each: boolean): RunJudged | null {
  const own = r.meta.checks;
  if (!own?.length) return null;
  const callAt = callAtWith(store, calls);
  const first = firstOf(own);
  const failedFirst = own.find((c) => checkStatus(c) === 'failed');
  return {
    by: 'own',
    verdict: checksVerdict(own),
    counts: count(own),
    callNo: failedFirst ? callAt(failedFirst) : null,
    first,
    today: false,
    goldens: [],
    why: null,
    ...(each ? { checks: judgedChecks(own, callAt) } : {}),
  };
}

/** A capture's verdict by the rules on calls: as kept when it was imported, or judged again since they changed. */
function importJudged(store: Store, record: RunRecord, w: ParsedWork | null, calls: Calls): RunJudged | null {
  const v = w && !w.error ? captureVerdict(store, record, w.rules, calls) : keptCaptureVerdict(record);
  if (!v) return null;
  const again = 'again' in v && v.again === true;
  const callAt = callAtWith(store, again ? calls : null);
  const failedFirst = v.checks.find((c) => checkStatus(c) === 'failed');
  return {
    by: 'import',
    verdict: v.verdict,
    counts: count(v.checks),
    callNo: failedFirst ? callAt(failedFirst) : null,
    first: firstOf(v.checks),
    today: again,
    goldens: [],
    why: v.why,
    checks: judgedChecks(v.checks, callAt),
  };
}

/**
 * Whether a run is one its family's checks judge: a finished run that kept no verdict of its own,
 * no attempt (whose verdict is the oracle's it ran under) and no injection test's replay (whose
 * verdict is the test's).
 */
function judgedByFamily(r: IndexedRun): boolean {
  if (r.status !== 'completed' || r.attemptKind || r.meta.injection || r.kind === 'capture') return false;
  return r.outcome.kind === 'none' || r.outcome.kind === 'clean';
}

/** When the checks that judged a run came to be: the newest of its goldens' packing and the config's last write; null when neither is known. */
function checksSince(w: ParsedWork, goldens: readonly string[]): number | null {
  const times = [w.work.changedAt, ...w.work.goldens.filter((g) => goldens.includes(g.path)).map((g) => g.packedAt)].filter((t): t is number => typeof t === 'number');
  return times.length ? Math.max(...times) : null;
}

/** The checks of a run's family's goldens, found without a call read: none for a run with no golden of its family under `tests`. */
function familyOf(store: Store, index: RunIndex, record: RunRecord, w: ParsedWork): ReturnType<typeof familySpecs> {
  const parentOf: ParentOf = (id) => {
    const x = index.byId.get(id);
    return x ? x.parentRunId : undefined;
  };
  return familySpecs(w.entries, familyGoldens(store, record, w.work.goldens, w.work.dir, parentOf), w.work.dir);
}

function familyJudged(store: Store, record: RunRecord, r: IndexedRun, w: ParsedWork, specs: ReturnType<typeof familySpecs>, calls: Calls): RunJudged | null {
  const fam = judgeByFamily(store, record, calls(), specs, w.work.prices);
  if (!fam) return null;
  const since = checksSince(w, fam.goldens);
  return {
    by: 'family',
    verdict: fam.verdict,
    counts: count(fam.checks),
    callNo: fam.callNo,
    first: firstOf(fam.checks),
    // Recorded before the checks that judge it came, or when that can't be told: judged by today's checks.
    today: since === null || r.startedAt < since,
    goldens: fam.goldens,
    why: null,
    checks: judgedChecks(fam.checks, () => null),
  };
}

export interface JudgeOptions {
  /** How to read the run's calls (the run's page has them read); default the store's. */
  calls?: Calls;
  /** Each check too: what the run's page shows on the outcome's hover. */
  checks?: boolean;
  /** Only what needs no call read, or what this thread judged before: a list's row, a long run's first answer. */
  quick?: boolean;
}

/** An outcome with its checks, or without them for a list. */
function withChecks(v: RunJudged | null, checks: boolean): RunJudged | null {
  if (!v || checks || !v.checks) return v;
  const { checks: _each, ...rest } = v;
  return rest;
}

/**
 * A run's outcome by checks, or null when no check judges it (a run still recording, one no check
 * applies to); undefined when `quick` and judging it would read its calls. What reads calls is kept
 * whole, each check with it, for the run's page and the lists alike.
 */
export function runJudged(store: Store, index: RunIndex, runId: string, work: OutcomeWork | null, o: JudgeOptions = {}): RunJudged | null | undefined {
  const r = index.byId.get(runId);
  if (!r || r.status === 'running') return null;
  const w = work ? parse(work) : null;
  let read: CallRecord[] | null = null;
  const calls: Calls = () => (read ??= o.calls ? o.calls() : store.getCalls(runId));
  if (r.meta.checks?.length) return ownJudged(store, r, o.quick ? null : calls, o.checks === true);
  // With no golden, or no tests entry, no family's checks judge a run: nothing read for it.
  if (r.kind !== 'capture' && (!w || w.error || !w.entries.length || !w.work.goldens.length || !judgedByFamily(r))) return null;
  const record = store.getRun(runId);
  if (!record) return null;
  const kept = r.kind === 'capture' ? keptCaptureVerdict(record) : null;
  // A capture judged under today's rules, or kept with no project to judge it by: no call read.
  if (r.kind === 'capture' && (!w || w.error || kept?.rules === w.rules.key)) return withChecks(importJudged(store, record, w, calls), o.checks === true);
  const key = keyOf(w!, r, kept?.rules ?? null);
  if (judged.has(key)) return withChecks(judged.get(key)!, o.checks === true);
  const specs = r.kind === 'capture' ? null : familyOf(store, index, record, w!);
  if (specs && !specs.length) return keep(key, null);
  if (o.quick) return undefined;
  const out = specs ? familyJudged(store, record, r, w!, specs, calls) : importJudged(store, record, w, calls);
  return withChecks(keep(key, out), o.checks === true);
}

/**
 * Each row's outcome by checks, for a list (Runs, the sidebar): what needs no call read, what this
 * thread judged before, and the rest while their calls fit `budget` in all, newest first. A row past
 * it keeps the outcome the run index gives it and no `judged`, as a row whose totals are on their way
 * does, and is judged once its run's page has judged it on that thread, or a later list's budget reaches it.
 */
export function judgedRows<R extends { runId: string; judged?: RunJudged | null }>(store: Store, rows: readonly R[], work: OutcomeWork | null, budget: number): R[] {
  const index = loadRunIndex(store);
  const w = work ? parse(work) : null;
  let left = budget;
  return rows.map((row) => {
    let j = runJudged(store, index, row.runId, work, { quick: true });
    if (j === undefined) {
      const r = index.byId.get(row.runId)!;
      if (r.calls > left || !w) return row;
      left -= r.calls;
      j = runJudged(store, index, row.runId, work);
    }
    return j === undefined ? row : { ...row, judged: j };
  });
}

/** The job this module's table answers: one run's outcome by checks, whole, each check with it. */
export type OutcomeJob = { kind: 'outcome'; runId: string; work: OutcomeWork | null };

export const OUTCOME_READS: ReadTable<OutcomeJob> = {
  outcome: (store, job) => {
    const run = lookupRun(store, job.runId);
    if (!run) {
      const no = noSuchRun(store, job.runId);
      return failed(no.status, no.message);
    }
    const index = loadRunIndex(store);
    return answer({ runId: run.runId, judged: runJudged(store, index, run.runId, job.work, { calls: () => [...runCalls(store, run.runId)], checks: true }) ?? null }, { tagged: true });
  },
};
