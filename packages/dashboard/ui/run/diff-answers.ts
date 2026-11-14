import type { Client } from '../api.js';
import type { RequestDiff } from '../../src/request-diff.js';

/**
 * Show diff's answers (`GET /api/runs/:id/diff[?call=<n>]`), each finished run's kept for the page's
 * life once asked, by the call asked for (none: where the run left its recording): its calls never
 * change, so a panel closed and opened again draws at once, with the server out of reach too. A run
 * still running is asked again each time its panel opens. Asked as the pointer or the focus reaches
 * Show diff (InspectorPanel.tsx `warmDiff`), so the panel often opens on what came; a failed ask is
 * forgotten, so the panel's Retry asks again. Loaded with the panel's part (RequestDiff.tsx), never
 * with the run page.
 */

const asked = new Map<string, Promise<RequestDiff | null>>();

/** A run's answer at call `callNo`, else where it left its recording: the one kept or on its way, else asked now; `live`, a run still running, is always asked anew. */
export function askDiff(client: Pick<Client, 'requestDiff'>, runId: string, live: boolean, callNo: number | null = null): Promise<RequestDiff | null> {
  const key = callNo === null ? runId : `${runId} #${callNo}`;
  const known = live ? undefined : asked.get(key);
  if (known) return known;
  const ask = (callNo === null ? client.requestDiff(runId) : client.requestDiff(runId, callNo)).catch((err: unknown) => {
    if (asked.get(key) === ask) asked.delete(key);
    throw err;
  });
  if (!live) asked.set(key, ask);
  return ask;
}
