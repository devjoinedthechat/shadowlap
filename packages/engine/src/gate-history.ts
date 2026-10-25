import type { GateHistory, Tally } from './stats.js';
import type { Store, TestResult } from './store.js';

/**
 * A golden's baseline for a gate against its history: the attempts of its last sessions in the
 * store's test history, pooled. Only results that say something about the agent as it is tested now
 * count: the same recording (one re-recorded by `test --update` starts a new baseline), the same
 * checks, the same mode, and a replay that ran at all.
 *
 * And only results that are a standard to keep: the golden passed, in a session on the baseline
 * branch (the default branch, unless the config names another) that ran for no pull request, on a
 * committed revision. A session that failed, a branch's and a pull request's never join it, so a
 * regression is judged against the agent as it was before it, on every run until it is fixed,
 * instead of becoming the baseline it is judged by. A result kept before sessions recorded their
 * branch can't show it was the baseline branch's, and doesn't count.
 *
 * Of each session, a gate against history pools its first `min` attempts (`first`), the ones every
 * session runs whatever they show. Its gate stops as soon as it is sure, so a session that ran on had
 * a bad start, and the ones that went red, which are left out, are long: pooled whole, the passing
 * sessions overstated the agent (0.8175 for one at 0.80, in 20 goldens), and every gate judged by
 * them failed it more often than its share allowed.
 */

export interface HistoryFilter {
  /** How many of the golden's sessions, newest first. */
  window: number;
  /**
   * The branch baselines come from. Absent: each result's own (`data.baselineBranch`, as the session
   * that kept it saw it). Null: none is known, and no result is part of a baseline.
   */
  branch?: string | null;
  /** The recording the golden replays now; results of another recording of it are left out. */
  goldenRunId?: string | null;
  /** The checks it is judged by now, as their labels; results judged by others are left out. */
  checks?: readonly string[] | null;
  /** `fork` for a golden that may fork; results of the golden in the other mode are left out. */
  mode?: 'replay' | 'fork';
  /** The session deciding now, whose own result is no baseline; with `test --continue`, the sessions it carries attempts over from too. */
  excludeSession?: string | readonly string[] | null;
  /** Only results kept before this time. */
  before?: number;
  /**
   * Of each session, only its first this many attempts, in the order they ran: a gate against
   * history's `min`. A result kept before results kept their order counts whole. Absent: every attempt.
   */
  first?: number;
}

/** One session's part of a baseline. */
export interface HistorySession extends Tally {
  sessionId: string;
  at: number;
  revision: string | null;
}

export interface PooledHistory extends GateHistory {
  /** The sessions pooled, newest first. */
  pooled: HistorySession[];
}

/**
 * How a golden came out in a result: passed, failed, or inconclusive (its gate ran out of attempts
 * between its bounds, a check could not be decided, or its injection test showed too little to say).
 * The verdict the result kept; for one kept before verdicts were, what its `ok` and failure say.
 */
export function testResultVerdict(r: Pick<TestResult, 'ok' | 'failure' | 'data'>): 'passed' | 'failed' | 'inconclusive' {
  return r.data?.verdict ?? (r.ok ? 'passed' : r.failure === 'inconclusive' ? 'inconclusive' : 'failed');
}

/**
 * A result's attempts: the passes and attempts it kept, or, for a result kept before attempts were,
 * one attempt that passed when the golden did. An attempt a check couldn't judge is no evidence
 * either way and isn't counted. Null for a golden that couldn't be replayed at all.
 */
export function attemptsOf(r: Pick<TestResult, 'ok' | 'failure' | 'data'>): Tally | null {
  if (r.failure === 'error') return null;
  const a = r.data?.attempts;
  if (a && Number.isInteger(a.total) && Number.isInteger(a.passed)) {
    const attempts = a.total - (a.inconclusive ?? 0);
    return attempts > 0 && a.passed <= attempts ? { passes: a.passed, attempts } : null;
  }
  return { passes: r.ok ? 1 : 0, attempts: 1 };
}

/**
 * Whether a result may be part of a baseline taken from `branch` (absent: the branch the result's
 * session took baselines from): its golden passed, in a session on that branch that ran for no pull
 * request, on a committed revision (none with `+dirty`). Null when it may, else why not.
 */
export function notBaseline(r: Pick<TestResult, 'ok' | 'failure' | 'data' | 'revision'>, branch?: string | null): string | null {
  if (testResultVerdict(r) !== 'passed') return 'its golden did not pass';
  const d = r.data;
  if (!d || typeof d.branch !== 'string' || !d.branch) return 'its session recorded no branch';
  if (d.pullRequest !== false) return d.pullRequest === true ? 'its session ran for a pull request' : 'its session recorded no pull request either way';
  const from = branch === undefined ? (d.baselineBranch ?? null) : branch;
  if (!from) return 'no baseline branch is known';
  if (d.branch !== from) return `its session ran on ${d.branch}, not ${from}`;
  if (/\+dirty$/.test(r.revision ?? d.revision ?? '')) return 'its session tested uncommitted changes';
  return null;
}

/**
 * What a golden's last results show of it, whatever branch they ran on, for a forecast: the attempts
 * of its last `window` results under the same recording and checks, pooled, and what an attempt cost
 * on average (USD, null with none priced). Null when it has no such result.
 */
export function recentAttempts(store: Store, golden: string, f: { window: number; goldenRunId?: string | null; checks?: readonly string[] | null }): (Tally & { costPerAttempt: number | null }) | null {
  let passes = 0;
  let attempts = 0;
  let spent = 0;
  let paid = 0;
  let seen = 0;
  for (const r of store.listTestResults({ golden, limit: READ_LIMIT })) {
    if (seen >= f.window) break;
    if (f.goldenRunId && r.goldenRunId && r.goldenRunId !== f.goldenRunId) continue;
    if (f.checks && !judgedUnder(r, f.checks)) continue;
    const t = attemptsOf(r);
    if (!t) continue;
    seen++;
    passes += t.passes;
    attempts += t.attempts;
    // Every attempt run was paid for, those the provider was unavailable for included.
    const ran = (r.data?.attempts?.runs?.length ?? 0) || t.attempts;
    if (typeof r.data?.spent === 'number' && ran > 0) {
      spent += r.data.spent;
      paid += ran;
    }
  }
  return attempts ? { passes, attempts, costPerAttempt: paid ? spent / paid : null } : null;
}

/** The checks a result was judged by, as their labels in order. */
const labelsOf = (r: Pick<TestResult, 'data'>): string[] => (r.data?.checks ?? []).map((c) => c.label).sort();

/** Whether a result was judged by the checks a golden has now (as the CLI labels them). */
export function judgedUnder(r: Pick<TestResult, 'data'>, checks: readonly string[]): boolean {
  const had = labelsOf(r);
  const want = [...checks].sort();
  return had.length === want.length && had.every((label, i) => label === want[i]);
}

/** How many of a golden's results are read to find `window` that qualify. */
const READ_LIMIT = 5000;

/**
 * A session's attempts as a baseline takes them: with `first`, the first that many it ran itself, in
 * order (a gate's outcomes, after any it carried over from a session it continued), else all it kept
 * (`attemptsOf`), as for a result kept before its gate kept its outcomes, or one with no gate.
 */
export function sessionAttempts(r: Pick<TestResult, 'ok' | 'failure' | 'data'>, first?: number): Tally | null {
  const all = attemptsOf(r);
  if (!all || first === undefined) return all;
  const g = r.data?.gate;
  const outcomes = Array.isArray(g?.outcomes) ? g.outcomes : null;
  if (!outcomes) return all;
  const carried = typeof g?.carried === 'number' && g.carried > 0 ? g.carried : 0;
  const own = outcomes.slice(carried, carried + first);
  return own.length ? { passes: own.filter(Boolean).length, attempts: own.length } : null;
}

/** The baseline a gate against history compares with: the golden's last `window` sessions that qualify, pooled. */
export function gateHistory(store: Store, golden: string, f: HistoryFilter): PooledHistory {
  const pooled: HistorySession[] = [];
  const excluded = new Set(typeof f.excludeSession === 'string' ? [f.excludeSession] : (f.excludeSession ?? []));
  for (const r of store.listTestResults({ golden, limit: READ_LIMIT })) {
    if (pooled.length >= f.window) break;
    if (excluded.has(r.sessionId)) continue;
    if (f.before !== undefined && r.at >= f.before) continue;
    if (f.goldenRunId && r.goldenRunId && r.goldenRunId !== f.goldenRunId) continue;
    if (f.mode && r.data?.mode && r.data.mode !== f.mode) continue;
    if (f.checks && !judgedUnder(r, f.checks)) continue;
    if (notBaseline(r, f.branch) !== null) continue;
    const t = sessionAttempts(r, f.first);
    if (!t) continue;
    pooled.push({ sessionId: r.sessionId, at: r.at, revision: r.revision, ...t });
  }
  return { passes: pooled.reduce((n, s) => n + s.passes, 0), attempts: pooled.reduce((n, s) => n + s.attempts, 0), sessions: pooled.length, pooled };
}
