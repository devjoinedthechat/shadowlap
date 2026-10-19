import type { GateHistory, Tally } from './stats.js';
import type { Store, TestResult } from './store.js';

/**
 * A golden's baseline for a gate against its history: the attempts of its last sessions in the
 * store's test history, pooled. Only results that say something about the agent as it is tested now
 * count: the same recording (one re-recorded by `test --update` starts a new baseline), the same
 * checks, the same mode, and a replay that ran at all.
 */

export interface HistoryFilter {
  /** How many of the golden's sessions, newest first. */
  window: number;
  /** The recording the golden replays now; results of another recording of it are left out. */
  goldenRunId?: string | null;
  /** The checks it is judged by now, as their labels; results judged by others are left out. */
  checks?: readonly string[] | null;
  /** `fork` for a golden that may fork; results of the golden in the other mode are left out. */
  mode?: 'replay' | 'fork';
  /** The session deciding now, whose own result is no baseline. */
  excludeSession?: string | null;
  /** Only results kept before this time. */
  before?: number;
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

/** The baseline a gate against history compares with: the golden's last `window` sessions that qualify, pooled. */
export function gateHistory(store: Store, golden: string, f: HistoryFilter): PooledHistory {
  const pooled: HistorySession[] = [];
  for (const r of store.listTestResults({ golden, limit: READ_LIMIT })) {
    if (pooled.length >= f.window) break;
    if (r.sessionId === f.excludeSession) continue;
    if (f.before !== undefined && r.at >= f.before) continue;
    if (f.goldenRunId && r.goldenRunId && r.goldenRunId !== f.goldenRunId) continue;
    if (f.mode && r.data?.mode && r.data.mode !== f.mode) continue;
    if (f.checks && !judgedUnder(r, f.checks)) continue;
    const t = attemptsOf(r);
    if (!t) continue;
    pooled.push({ sessionId: r.sessionId, at: r.at, revision: r.revision, ...t });
  }
  return { passes: pooled.reduce((n, s) => n + s.passes, 0), attempts: pooled.reduce((n, s) => n + s.attempts, 0), sessions: pooled.length, pooled };
}
