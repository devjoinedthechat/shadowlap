import { useEffect, useState } from 'react';
import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { GoldenEstimates, TestsEstimates } from './estimates-api.js';
import { useApp, type AppState } from './state.js';

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

/** One golden's price for a job, as the hook holds them: undefined while it is read, null where there is none. */
export function goldenPrice(e: TestsEstimates | null | undefined, golden: string, job: keyof GoldenEstimates): Estimate | null | undefined {
  return e === undefined ? undefined : (e?.goldens[golden]?.[job] ?? null);
}

/** An estimate as the hook holds it: undefined while it is read, null for none. */
export type Price = Estimate | null | undefined;
