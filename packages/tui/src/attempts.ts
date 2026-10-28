import { checksOf, classifyRun, failedChecks, type AttemptKind, type RunRecord } from '@shadowlap/engine';

/**
 * The runs bundled under a run: a `replay --repeat`'s attempts, blame's probes, verify's attempts,
 * a test's runs. They are one result, not runs of their own, so the runs list folds them under the
 * run they belong to with how many passed, as the dashboard's Runs does.
 */
export interface Attempts {
  kind: AttemptKind | null;
  count: number;
  passed: number;
}

/** An attempt passed when no check failed or went undecided; with no checks, when it completed. */
export function attemptPassed(r: RunRecord): boolean {
  const n = checksOf(r);
  if (n) return failedChecks(n) === 0 && !n.inconclusive;
  return r.status === 'completed';
}

export function attemptsOf(runs: readonly RunRecord[]): Attempts | null {
  if (!runs.length) return null;
  const kind = classifyRun(runs[0]!).attemptKind;
  return { kind, count: runs.length, passed: runs.filter(attemptPassed).length };
}

const NOUN: Record<AttemptKind, [string, string]> = {
  repeat: ['attempt', 'attempts'],
  probe: ['probe', 'probes'],
  verify: ['verify attempt', 'verify attempts'],
  test: ['test run', 'test runs'],
  chaos: ['error-path run', 'error-path runs'],
};

/** `5 attempts, 4 passed`, `12 probes, 3 passed`. */
export function attemptsText(a: Attempts): string {
  const [one, many] = a.kind ? NOUN[a.kind] : ['attempt', 'attempts'];
  return `${a.count} ${a.count === 1 ? one : many}, ${a.passed} passed`;
}
