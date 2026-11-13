import type { TestsEstimates } from './estimates-api.js';
import { goldenPrice, type Price } from './tests-estimates.js';
import type { TestsView } from './types.js';

/**
 * What Tests prices from its estimates (pages/Tests.tsx, and the job footers' Update goldens), kept
 * off the run page, which reads one golden's price alone (tests-estimates.ts): the key the estimates
 * are read by, Run tests' price and Update golden's.
 */

/**
 * What Tests' estimates are worked out from, as the page's view shows it: each golden, its recording,
 * how its tests entry runs it, its checks and its newest result. The view loads again whenever runs or
 * calls move; this changes only when one of these does.
 */
export function estimatesKey(view: Pick<TestsView, 'rows'>): string {
  return view.rows.map((r) => [r.path, r.source.kind === 'run' ? r.source.runId : r.source.packedAt, r.mode, r.injection, r.checks.join(','), r.runId, r.last.at].join(' ')).join('\n');
}

/** Run tests': what each golden it runs live spent the last time, Free where every golden replays offline. */
export function runPrice(e: TestsEstimates | null | undefined): Price {
  return e === undefined ? undefined : (e?.run ?? null);
}

/** Update golden's for the goldens it updates: one golden's own, or several's together as the read named them. It asks either way, since it replaces goldens. */
export function updatesPrice(e: TestsEstimates | null | undefined, paths: readonly string[]): Price {
  if (paths.length === 1) return goldenPrice(e, paths[0]!, 'update');
  return e === undefined ? undefined : (e?.update ?? null);
}
