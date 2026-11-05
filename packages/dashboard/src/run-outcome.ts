import { createHash } from 'node:crypto';
import {
  callNeedsCalls,
  captureVerdict,
  checkCallAt,
  checkStatus,
  checksVerdict,
  countStatuses,
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
import type { JudgeRun } from './runs-filter.js';

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
 *   and a check on what the agent printed inconclusive. A run recorded before them says so (`today`).
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
  /**
   * The project's goldens: each pack's folder, the run it holds, when it was packed, and when its
   * checks under `tests` last changed as far as the server could tell (outcome-work.ts): what a run
   * recorded before reads as judged by today's checks.
   */
  goldens: Array<{ path: string; runId: string | null; packedAt: number | null; checksAt?: number | null }>;
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
  /** For a family's: whether its checks came with the newest of its goldens (`packed`) or changed since it was packed (`changed`); null when that can't be told. */
  since?: 'packed' | 'changed' | null;
  /** The goldens whose checks judged it (`family`), nearest first. */
  goldens: string[];
  /**
   * Why no check applied, where a verdict says (a capture none of whose rules had a call to read);
   * or why its recording can't settle its family's checks besides a check that says so, as
   * `shadowlap check` says it (a judge of what the agent printed).
   */
  why: string | null;
  /** Each check: on the run's page and Runs' rows, for the outcome's hover; the sidebar's rows leave them out. */
  checks?: JudgedCheck[];
}

/** What a job judges by, read once per job (and kept per thread and config version): the tests entries (or why they can't be read), the rules on calls, and a key for them all. */
export interface ParsedWork {
  work: OutcomeWork;
  key: string;
  entries: TestEntry[];
  rules: RulesOnCalls;
  /** Why the config's tests can't be read: then only runs' own verdicts and kept ones say anything. */
  error: string | null;
}

/** Each work's key, worked out once for the object: the server keeps one work while nothing it was read from changes. */
const keys = new WeakMap<OutcomeWork, string>();

/** A key for what the work judges by: the config's version and folder, the goldens (and when their checks changed) and the prices. */
export function outcomeKey(work: OutcomeWork | null): string {
  if (!work) return 'none';
  const known = keys.get(work);
  if (known) return known;
  const key = createHash('sha1').update(JSON.stringify([work.version, work.dir, work.goldens, work.prices ?? null])).digest('base64url');
  keys.set(work, key);
  return key;
}

const parsed = new Map<string, ParsedWork>();

/** The work as a job judges by it: parsed once per thread and key, the newest few kept. */
export function parseWork(work: OutcomeWork | null): ParsedWork | null {
  if (!work) return null;
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

/** What a run judged with its calls read is kept as, per thread: by what judged it and where its calls stand. */
const judged = new Map<string, RunJudged | null>();
/** The most kept, the oldest going first: most are a run no golden of its family judges, kept as null. */
const KEEP = 5_000;

/** What judged a run (its own checks, or the work and a capture's kept rules) and where the run stands. */
const keyOf = (by: string, r: IndexedRun) => `${by}|${r.runId}|${r.callEvents}|${r.status}|${String(r.endedAt)}`;

function keep(key: string, value: RunJudged | null): RunJudged | null {
  if (judged.size >= KEEP) judged.delete(judged.keys().next().value!);
  judged.set(key, value);
  return value;
}

const count = (checks: ReadonlyArray<Pick<StoredCheck, 'ok' | 'status'>>): RunJudged['counts'] => {
  const n = countStatuses(checks);
  return { passed: n.passed, failed: n.failed, inconclusive: n.inconclusive, notApplicable: n['not-applicable'] };
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

/** A run judged by its own checks, as it was made: each failed check's call from its detail, or with `calls`, from them too. */
function ownJudged(store: Store, own: NonNullable<IndexedRun['meta']['checks']>, calls: Calls | null): RunJudged {
  const callAt = callAtWith(store, calls);
  const failedFirst = own.find((c) => checkStatus(c) === 'failed');
  return { by: 'own', verdict: checksVerdict(own), counts: count(own), callNo: failedFirst ? callAt(failedFirst) : null, first: firstOf(own), today: false, goldens: [], why: null, checks: judgedChecks(own, callAt) };
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

/**
 * When the checks that judged a run came to be: the newest of its goldens' packing (a golden's checks
 * come with it) and of a change to their checks since, as the server saw it; null when none is known.
 */
function checksSince(w: ParsedWork, goldens: readonly string[]): { at: number; changed: boolean } | null {
  let out: { at: number; changed: boolean } | null = null;
  for (const g of w.work.goldens) {
    if (!goldens.includes(g.path)) continue;
    if (typeof g.packedAt === 'number' && (!out || g.packedAt > out.at)) out = { at: g.packedAt, changed: false };
    if (typeof g.checksAt === 'number' && (!out || g.checksAt > out.at)) out = { at: g.checksAt, changed: true };
  }
  return out;
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
    today: since === null || r.startedAt < since.at,
    since: since ? (since.changed ? 'changed' : 'packed') : null,
    goldens: fam.goldens,
    why: fam.unsettled[0] ?? null,
    checks: judgedChecks(fam.checks, () => null),
  };
}

export interface JudgeOptions {
  /** How to read the run's calls (the run's page has them read); default the store's. */
  calls?: Calls;
  /** Each check too: what the run's page and Runs show on the outcome's hover. */
  checks?: boolean;
  /** Only what needs no call read, or what this thread judged before: a list's row, a long run's first answer. */
  quick?: boolean;
}

/** An outcome with its checks, or without them for a list that shows no hover. */
function withChecks(v: RunJudged | null, checks: boolean): RunJudged | null {
  if (!v || checks || !v.checks) return v;
  const { checks: _each, ...rest } = v;
  return rest;
}

/** A run with its own checks: what needs no call read, else what the run's calls tell, kept (a count's call is the first past what it allows). */
function ownOutcome(store: Store, r: IndexedRun, own: NonNullable<IndexedRun['meta']['checks']>, calls: Calls, o: JudgeOptions): RunJudged | null | undefined {
  const key = keyOf('own', r);
  if (judged.has(key)) return judged.get(key)!;
  if (!o.quick) return keep(key, ownJudged(store, own, calls));
  // Each failed check names its call, or there is none to name: no call read, and nothing kept, as the page's is.
  if (!own.some((c) => checkStatus(c) === 'failed' && callNeedsCalls(c))) return ownJudged(store, own, null);
  return undefined;
}

/** A run judged by what it was not given: a capture's rules on calls, else its family's checks. */
function judgedBy(store: Store, index: RunIndex, r: IndexedRun, w: ParsedWork | null, calls: Calls, o: JudgeOptions): RunJudged | null | undefined {
  const capture = r.kind === 'capture';
  // With no golden, or no tests entry, no family's checks judge a run: nothing read for it.
  if (!capture && (!w || w.error || !w.entries.length || !w.work.goldens.length || !judgedByFamily(r))) return null;
  const record = store.getRun(r.runId);
  if (!record) return null;
  const kept = capture ? keptCaptureVerdict(record) : null;
  // A capture judged under today's rules, kept with no project to judge it by, or with no rule left to judge it: no call read.
  if (capture && (!w || w.error || !w.rules.rules.length || kept?.rules === w.rules.key)) return importJudged(store, record, w, calls);
  const key = keyOf(`${w!.key}|${kept?.rules ?? ''}`, r);
  if (judged.has(key)) return judged.get(key)!;
  const specs = capture ? null : familyOf(store, index, record, w!);
  if (specs && !specs.length) return keep(key, null);
  if (o.quick) return undefined;
  return keep(key, specs ? familyJudged(store, record, r, w!, specs, calls) : importJudged(store, record, w, calls));
}

/**
 * A run's outcome by checks (`w`, the work parsed once for the job: parseWork), or null when no check
 * judges it (a run still recording, one no check applies to); undefined when `quick` and judging it
 * would read its calls. What reads calls is kept whole, each check with it, for the run's page and
 * the lists alike.
 */
export function judgeRun(store: Store, index: RunIndex, runId: string, w: ParsedWork | null, o: JudgeOptions = {}): RunJudged | null | undefined {
  const r = index.byId.get(runId);
  if (!r || r.status === 'running') return null;
  let read: CallRecord[] | null = null;
  const calls: Calls = () => (read ??= o.calls ? o.calls() : store.getCalls(runId));
  const own = r.meta.checks;
  const out = own?.length ? ownOutcome(store, r, own, calls, o) : judgedBy(store, index, r, w, calls, o);
  return out === undefined ? undefined : withChecks(out, o.checks === true);
}

/** A run's outcome by checks, for a job that judges one run: `judgeRun` with the work parsed. */
export function runJudged(store: Store, index: RunIndex, runId: string, work: OutcomeWork | null, o: JudgeOptions = {}): RunJudged | null | undefined {
  return judgeRun(store, index, runId, parseWork(work), o);
}

/**
 * Each row's outcome by checks, for a list (Runs, the sidebar): what needs no call read, what this
 * thread judged before, and the rest while their calls fit `budget` in all, newest first. A row past
 * it keeps the outcome the run index gives it and no `judged`, as a row whose totals are on their way
 * does, and is judged once its run's page has judged it on that thread, or a later list's budget
 * reaches it. `checks`: each row with each check, for a list that shows them on hover (Runs).
 */
export function judgedRows<R extends { runId: string; judged?: RunJudged | null }>(store: Store, rows: readonly R[], work: OutcomeWork | null, budget: number, o: { checks?: boolean } = {}): R[] {
  const index = loadRunIndex(store);
  const w = parseWork(work);
  const each = o.checks === true;
  let left = budget;
  return rows.map((row) => {
    let j = judgeRun(store, index, row.runId, w, { quick: true, checks: each });
    if (j === undefined) {
      const r = index.byId.get(row.runId)!;
      if (r.calls > left) return row;
      left -= r.calls;
      j = judgeRun(store, index, row.runId, w, { checks: each });
    }
    return j === undefined ? row : { ...row, judged: j };
  });
}

/** What the run lists' `status:` judges a run by (runs-filter.ts `JudgeRun`): `judgeRun` with the work parsed once, `quick` reading no call. */
export function judgeFor(store: Store, work: OutcomeWork | null): JudgeRun {
  const index = loadRunIndex(store);
  const w = parseWork(work);
  return (runId, quick) => judgeRun(store, index, runId, w, { quick });
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
