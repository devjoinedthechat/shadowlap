import { checkStatus, isObject, joinableFix, type RunRecord, type StoreOf, type StoredCheckLike } from '@shadowlap/engine';
import { fixRef, type FixForRun } from './fix-for-run.js';
import { goldenExpect } from './run-offers.js';

/**
 * A failed test replay's fix by its check, where no fix holds the replay itself: the open fix
 * `shadowlap blame` would join it to (the engine's joinableFix, by check), with the golden's checks as
 * the config has them. So the replay's page, Tests and its report lead to the same Open fix as a run
 * of that fix would. Only for a check that failed: a crash or a divergence is no check's failure.
 *
 * It reads every open fix and each one's failing runs, so only the pooled reads of a run's next step
 * and Tests' steps ask it (next-step.ts `stepReads`, `byCheck`), never a list, never the server's thread.
 */
export function withFixByCheck(store: StoreOf<'recording' | 'fixes'>, run: RunRecord, tests: unknown, found: FixForRun | null): FixForRun | null {
  if (found?.fix) return found;
  const golden = run.meta?.test?.golden;
  const checks: unknown[] = Array.isArray(run.meta?.checks) ? run.meta.checks : [];
  if (typeof golden !== 'string' || !checks.some((c) => isObject(c) && typeof c.label === 'string' && checkStatus(c as StoredCheckLike) === 'failed')) return found;
  const expect = goldenExpect(tests, golden);
  const fix = expect === undefined ? null : joinableFix(store, run, expect, { byCheck: true });
  // A test replay takes no part in Fixes of its own (fix-shared.ts `isUnblamedFailure`): it joins as a failure never blamed would.
  return fix ? { ...(found ?? { role: 'unblamed', blame: null, probe: null, verify: null }), fix: fixRef(store, fix) } : found;
}
