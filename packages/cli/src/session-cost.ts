import { estimateCost, footprintOf, messageOf, type CallRecord, type Price, type StoreOf, type TestFailure } from '@shadowlap/engine';
import type { PackResult } from './test-report.js';
import { palette as p } from './ui.js';

/**
 * What a run of the session's goldens costs, kept with the session for the pull request comment: each
 * golden's recording, and this session's replay of it, priced as each would run live (footprintOf,
 * the measure verify's per-run line uses), whatever their calls' origin. A replay that only replays
 * costs what its recording does.
 */

/** Why a golden failed where its replay still ran to its end: a check, its gate or its injection gate decided it, not the run stopping. */
const RAN_WHOLE: ReadonlyArray<TestFailure | null> = [null, 'check', 'inconclusive', 'injection'];

/**
 * The mean over the goldens whose replay ran whole, as recorded (`before`) and in this session
 * (`after`), in USD; null when no golden's replay ran whole with a price on both sides.
 */
export function sessionCostPerRun(store: StoreOf<'recording'>, results: readonly PackResult[], prices?: Record<string, Price>): { before: number; after: number } | null {
  const costOf = (c: CallRecord) => estimateCost(c.end?.meta.model ?? c.meta.model, c.end?.meta.usage, prices);
  let before = 0;
  let after = 0;
  let goldens = 0;
  for (const r of results) {
    if (!r.runId || !r.goldenRunId || !RAN_WHOLE.includes(r.failure)) continue;
    const recorded = footprintOf(store.getCalls(r.goldenRunId), costOf).cost;
    const replayed = footprintOf(store.getCalls(r.runId), costOf).cost;
    if (recorded === null || replayed === null) continue;
    before += recorded;
    after += replayed;
    goldens++;
  }
  return goldens ? { before: before / goldens, after: after / goldens } : null;
}

/**
 * Works out the session's cost per run and keeps it with the session as its comment's part, before the
 * store closes; returns it for the JSON report. What can't be worked out or kept is said, and is none.
 */
export function keepCostPerRun(store: StoreOf<'recording' | 'tests'>, sessionId: string, results: readonly PackResult[], prices?: Record<string, Price>): { before: number; after: number } | null {
  try {
    const cost = sessionCostPerRun(store, results, prices);
    if (cost) store.setTestSessionComment(sessionId, { costPerRun: cost });
    return cost;
  } catch (err) {
    process.stderr.write(p.yellow(`[shadowlap] the session's cost per run was not kept: ${messageOf(err)}\n`));
    return null;
  }
}
