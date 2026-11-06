import { useEffect, useState } from 'react';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { GoldenEstimates, TestsEstimates } from './estimates-api.js';
import { useApp, type AppState } from './state.js';
import type { TestsView } from './types.js';

/**
 * What Tests' jobs would bill (`GET /api/tests/estimates`): Run tests' and each golden's, read again
 * whenever `key` changes (`estimatesKey`, or the one golden or job a control prices), so a golden
 * added since is held to a fresh figure; the last answer stays while the next is read. It is a pooled
 * read of every golden's recording and last attempts, so a page that loads again as runs move reads
 * it again only when what it is worked out from does. Undefined until the server answers, and where
 * nothing can start (an exported copy, a read-only dashboard, a stand-in with no client), so a card has
 * no line; null after a read that failed, so each billed job asks. A `key` of null asks nothing.
 * `update`: the goldens Update goldens… re-records, priced together, read again only as they change.
 */
export function useTestsEstimates(key: string | null | undefined, update?: readonly string[]): TestsEstimates | null | undefined {
  const app = useApp() as Partial<AppState>;
  const api = app.client?.estimates;
  const off = !api || !!app.exported || !!app.actionsOff;
  const [got, setGot] = useState<{ e: TestsEstimates | null } | null>(null);
  const names = update?.join('\n') ?? '';
  useEffect(() => {
    if (off || key === null || key === undefined) return;
    let live = true;
    api.testsEstimates(names ? names.split('\n') : undefined).then(
      (e) => live && setGot({ e }),
      () => live && setGot({ e: null }),
    );
    return () => {
      live = false;
    };
  }, [api, off, key, names]);
  return off || !got ? undefined : got.e;
}

/**
 * What Tests' estimates are worked out from, as the page's view shows it: each golden, its recording,
 * how its tests entry runs it, its checks and its newest result. The view loads again whenever runs or
 * calls move; this changes only when one of these does.
 */
export function estimatesKey(view: Pick<TestsView, 'rows'>): string {
  return view.rows.map((r) => [r.path, r.source.kind === 'run' ? r.source.runId : r.source.packedAt, r.mode, r.injection, r.checks.join(','), r.runId, r.last.at].join(' ')).join('\n');
}

/** One golden's price for a job, as the hook holds them: undefined while it is read, null where there is none. */
export function goldenPrice(e: TestsEstimates | null | undefined, golden: string, job: keyof GoldenEstimates): Estimate | null | undefined {
  return e === undefined ? undefined : (e?.goldens[golden]?.[job] ?? null);
}

/** An estimate as the hook holds it: undefined while it is read, null for none. */
export type Price = Estimate | null | undefined;

/** Run tests': what each golden it runs live spent the last time, Free where every golden replays offline. */
export function runPrice(e: TestsEstimates | null | undefined): Price {
  return e === undefined ? undefined : (e?.run ?? null);
}

/** Update golden's for the goldens it updates: one golden's own, or several's together as the read named them. It asks either way, since it replaces goldens. */
export function updatesPrice(e: TestsEstimates | null | undefined, paths: readonly string[]): Price {
  if (paths.length === 1) return goldenPrice(e, paths[0]!, 'update');
  return e === undefined ? undefined : (e?.update ?? null);
}
