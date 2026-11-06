import { useEffect, useState } from 'react';
import type { Estimate } from '../../../engine/src/estimates/estimate.js';
import type { BisectQuery } from '../estimates-api.js';
import { useApp, type AppState } from '../state.js';

/** How long a commit's field rests before its search is priced, as Switch model's does. */
const COMMIT_WAIT = 250;

/** Each search priced on this page, by what it searches: the dialog opened from a card that asked says it at once. */
const held = new Map<string, Estimate | null>();

/**
 * What Find breaking commit bills from the commit a card or a dialog names (`GET /api/estimates/bisect`),
 * as the job would search: asked once the commit has rested 250 ms, and undefined until that commit's
 * answer comes, so the line is always the field's and an answer for a commit since changed is
 * dropped; null after a read that failed, so it asks. With no commit, or where nothing can start (an
 * exported copy, a read-only dashboard, a stand-in with no client), it asks nothing.
 */
export function useBisectEstimate(q: BisectQuery): Estimate | null | undefined {
  const app = useApp() as Partial<AppState>;
  const api = app.client?.estimates;
  const good = q.good?.trim() ?? '';
  const key = JSON.stringify([q.runId ?? null, q.golden ?? null, good, q.bad ?? null]);
  const off = !api || !!app.exported || !!app.actionsOff || !good;
  const [got, setGot] = useState<string | null>(null);
  useEffect(() => {
    if (off || held.has(key)) return;
    let live = true;
    const [runId, golden, from, bad] = JSON.parse(key) as Array<string | null>;
    const asked: BisectQuery = { ...(runId ? { runId } : {}), ...(golden ? { golden } : {}), good: from ?? '', ...(bad ? { bad } : {}) };
    const wait = setTimeout(() => {
      const keep = (e: Estimate | null) => {
        held.set(key, e);
        if (live) setGot(key);
      };
      api.bisectEstimate(asked).then(keep, () => {
        // A failure isn't kept: the next card or dialog asks again.
        if (live) setGot(key);
      });
    }, COMMIT_WAIT);
    return () => {
      live = false;
      clearTimeout(wait);
    };
  }, [api, off, key]);
  if (off) return undefined;
  if (held.has(key)) return held.get(key) ?? null;
  return got === key ? null : undefined;
}

/** For tests: forget what this page has priced. */
export function forgetBisectEstimates(): void {
  held.clear();
}

/** What a run's Find breaking commit searches, from its offer: the commit it last passed at, or the one picked, up to its own. */
export function bisectQuery(runId: string, b: { good?: string | null; bad?: string | null } | null | undefined, good = b?.good ?? ''): BisectQuery {
  return { runId, good, ...(b?.bad ? { bad: b.bad } : {}) };
}
