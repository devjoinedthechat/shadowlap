import { useEffect, useState } from 'react';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { GoldenEstimates, TestsEstimates } from './estimates-api.js';
import { useApp, type AppState } from './state.js';

/**
 * What Tests' jobs would bill (`GET /api/tests/estimates`): Run tests' and each golden's, read again
 * whenever `key` moves (the page's view as it loads again), so a golden added since is held to a fresh
 * figure; the last answer stays while the next is read. Undefined until the server answers, and where
 * nothing can start (an exported copy, a read-only dashboard, a stand-in with no client), so a card has
 * no line; null after a read that failed, so each billed job asks. A `key` of null asks nothing.
 */
export function useTestsEstimates(key: unknown): TestsEstimates | null | undefined {
  const app = useApp() as Partial<AppState>;
  const api = app.client?.estimates;
  const off = !api || !!app.exported || !!app.actionsOff;
  const [got, setGot] = useState<{ e: TestsEstimates | null } | null>(null);
  useEffect(() => {
    if (off || key === null || key === undefined) return;
    let live = true;
    api.testsEstimates().then(
      (e) => live && setGot({ e }),
      () => live && setGot({ e: null }),
    );
    return () => {
      live = false;
    };
  }, [api, off, key]);
  return off || !got ? undefined : got.e;
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

/**
 * Update golden's for the goldens it updates: one golden's from its own. Several are not priced here
 * yet (none of the server's answers adds them up), so the card has no line until they are; the dialog
 * asks either way, since it replaces goldens.
 */
export function updatesPrice(e: TestsEstimates | null | undefined, paths: readonly string[]): Price {
  return paths.length === 1 ? goldenPrice(e, paths[0]!, 'update') : undefined;
}
