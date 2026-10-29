/**
 * How a run stands, as the dashboard and the terminal UI both say it: why a run failed, first reason
 * first, and how one of a gate's attempts came out. Plain functions of what a run kept, with no store:
 * the dashboard's browser code imports them too.
 */

/** A check as a run keeps it: whether it passed and, for one that didn't, whether it could be decided at all. */
interface KeptCheck {
  ok: boolean;
  status?: string | undefined;
}

/** A check that failed: not passed, and not one that could not be decided, which is no failure of the agent's. */
export const checkFailed = (c: KeptCheck): boolean => !c.ok && c.status !== 'inconclusive';

/** Why a run failed: its own failed check, the agent's exit, the check its outcome names, an interruption, or blame's confirmation. */
export type FailureReason<C> = { kind: 'check'; check: C } | { kind: 'exit' } | { kind: 'fix-check'; check: string } | { kind: 'interrupted' } | { kind: 'blame' };

/** The words of the reasons that carry none of their own. */
export const FAILURE_WORDS = { exit: 'the agent exited with an error', interrupted: 'the run was interrupted', blame: 'blame confirmed it fails' } as const;

/**
 * Why a run failed, the first reason that holds; null when it didn't. Its own failed check first,
 * then the agent's exit, then the check its outcome names (a fix's, for a run the fix lists as
 * failing), then an interruption, then blame's confirmation that it fails.
 */
export function failureReason<C extends KeptCheck>(run: { status: string; checks: readonly C[]; outcome?: { kind: string; check?: string | null } | null | undefined; blame?: unknown }): FailureReason<C> | null {
  const failed = run.checks.find(checkFailed);
  if (failed) return { kind: 'check', check: failed };
  if (run.status === 'failed') return { kind: 'exit' };
  const o = run.outcome;
  if (o?.kind === 'check-failed' && o.check) return { kind: 'fix-check', check: o.check };
  if (run.status === 'crashed') return { kind: 'interrupted' };
  return run.blame ? { kind: 'blame' } : null;
}

export type AttemptVerdict = 'passed' | 'failed' | 'inconclusive';

/**
 * An attempt's verdict as blame or verify kept it, or, for one kept before attempts had one, by
 * whether it passed. One its provider was unavailable for neither passed nor failed.
 */
export function keptAttemptVerdict(a: { passed: boolean; verdict?: string | null | undefined }): AttemptVerdict {
  return a.verdict === 'inconclusive' || a.verdict === 'unavailable' ? 'inconclusive' : a.passed ? 'passed' : 'failed';
}

/**
 * How one of a gate's attempts came out. Interrupted when it stopped before it ended, failing nothing
 * else: it neither passed nor failed. Then the verdict blame or verify kept on it (keptAttemptVerdict);
 * else, as a `--repeat`'s attempt is counted, what its checks say (one failed, or one could not be
 * decided), and with none its exit. `unsure` is the check that could not be decided, for an attempt
 * that is inconclusive.
 */
export function attemptVerdict<C extends KeptCheck>(run: { status: string; checks: readonly C[]; interrupted?: boolean | undefined }, kept?: AttemptVerdict): { verdict: AttemptVerdict | 'interrupted'; unsure: C | null } {
  if (run.interrupted || (run.status === 'crashed' && !run.checks.length)) return { verdict: 'interrupted', unsure: null };
  const unsure = run.checks.find((c) => c.status === 'inconclusive') ?? null;
  const verdict = kept ?? (run.checks.some(checkFailed) || (!run.checks.length && run.status === 'failed') ? 'failed' : unsure ? 'inconclusive' : 'passed');
  return { verdict, unsure: verdict === 'inconclusive' ? unsure : null };
}
