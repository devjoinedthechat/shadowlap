import { attemptVerdict, classifyRun, keptAttemptVerdict, type AttemptKind, type RunRecord } from '@shadowlap/engine';

/**
 * The runs bundled under a run: a `replay --repeat`'s attempts, blame's probes, verify's attempts,
 * a test's runs, and theirs in turn (`withAttempts`, as a delete counts them). They are one result,
 * not runs of their own, so the runs list folds them under the run they belong to with how many
 * passed, kind by kind, as the dashboard's Runs and Fixes count them.
 */
export interface AttemptTally {
  kind: AttemptKind | null;
  count: number;
  passed: number;
  /** Stopped before it finished: counted apart, neither passed nor failed. */
  interrupted: number;
}

export type AttemptResult = 'passed' | 'failed' | 'inconclusive' | 'interrupted' | 'running';

/**
 * How an attempt came out, by the engine's rule (attemptVerdict), as the dashboard counts it: one
 * stopped before it ended is interrupted; else the verdict blame or verify kept on it, an
 * inconclusive or an unavailable provider being no failure; else what its checks say, and with none
 * its exit.
 */
export function attemptResult(r: RunRecord): AttemptResult {
  if (r.status === 'running') return 'running';
  const own = r.meta?.probe ?? r.meta?.verify;
  const kept = own && typeof own.passed === 'boolean' ? keptAttemptVerdict(own) : undefined;
  return attemptVerdict({ status: r.status, checks: r.meta?.checks ?? [] }, kept).verdict;
}

/** The attempts tallied kind by kind, the commonest first. */
export function attemptTallies(runs: readonly RunRecord[]): AttemptTally[] {
  const byKind = new Map<AttemptKind | null, AttemptTally>();
  for (const r of runs) {
    const kind = classifyRun(r).attemptKind;
    const t = byKind.get(kind) ?? { kind, count: 0, passed: 0, interrupted: 0 };
    const result = attemptResult(r);
    t.count++;
    if (result === 'passed') t.passed++;
    if (result === 'interrupted') t.interrupted++;
    byKind.set(kind, t);
  }
  return [...byKind.values()].sort((a, b) => b.count - a.count);
}

const NOUN: Record<AttemptKind, [string, string]> = {
  repeat: ['attempt', 'attempts'],
  probe: ['probe', 'probes'],
  verify: ['verify attempt', 'verify attempts'],
  test: ['test run', 'test runs'],
  chaos: ['error-path run', 'error-path runs'],
};

/** `5 attempts, 4 passed`, `12 probes, 3 passed · 6 verify attempts, 6 passed, 1 interrupted`. */
export function attemptsText(tallies: readonly AttemptTally[]): string {
  return tallies
    .map((t) => {
      const [one, many] = t.kind ? NOUN[t.kind] : ['attempt', 'attempts'];
      return `${t.count} ${t.count === 1 ? one : many}, ${t.passed} passed${t.interrupted ? `, ${t.interrupted} interrupted` : ''}`;
    })
    .join(' · ');
}

/** Whether every attempt passed: the colour the tally is drawn in. */
export const allPassed = (tallies: readonly AttemptTally[]) => tallies.every((t) => t.passed === t.count);
