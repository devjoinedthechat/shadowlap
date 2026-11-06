import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { Spending } from '../../engine/src/estimates/spending.js';
import type { FixEstimates, RunEstimates, TestsEstimates } from '../src/estimates.js';
import type { Request } from './settings-api.js';

export type { FixEstimates, GoldenEstimates, RunEstimates, TestsEstimates } from '../src/estimates.js';

/** Spending as the server says it: the threshold (0, Always ask; null, Never ask), whether it was set, and what in its file was ignored. */
export interface SpendingView {
  askAbove: Spending;
  set: boolean;
  problems: string[];
}

/** Where Find breaking commit searches: a run or a golden, from `good` up to `bad` (HEAD when left out). */
export interface BisectQuery {
  runId?: string;
  golden?: string;
  good?: string;
  bad?: string;
}

/**
 * What billed jobs would cost, each worked out beside the server as the job would run (`GET
 * /api/runs/:id/estimates`, `/api/fixes/:id/estimates`, `/api/tests/estimates`, `/api/estimates/bisect`),
 * and Spending, the person's own threshold for when one asks first (`/api/user/spending`).
 */
export interface EstimatesApi {
  spending(): Promise<SpendingView>;
  /** Keeps a threshold, and answers what it was (`was`), for an Undo to put back. */
  setSpending(v: Spending): Promise<SpendingView & { was: Spending }>;
  /** Run blame's and each fork menu row's at call `at`, Switch model's at `model`. */
  runEstimates(runId: string, at?: number | null, model?: string | null): Promise<RunEstimates>;
  /** Run repair's, Run blame again's and stronger's at `model`, and each Verify step's. */
  fixEstimates(fixId: string, model?: string | null): Promise<FixEstimates>;
  /** Run tests' and each golden's, with Update goldens…' for `update` together where it names goldens. */
  testsEstimates(update?: readonly string[]): Promise<TestsEstimates>;
  bisectEstimate(q: BisectQuery): Promise<Estimate>;
}

export function estimatesApi(request: Request): EstimatesApi {
  const q = encodeURIComponent;
  const query = (o: Record<string, string | number | null | undefined>) => {
    const parts = Object.entries(o).flatMap(([k, v]) => (v === undefined || v === null || v === '' ? [] : [`${k}=${q(String(v))}`]));
    return parts.length ? `?${parts.join('&')}` : '';
  };
  return {
    spending: () => request('user/spending'),
    setSpending: (v) => request('user/spending', { method: 'PUT', body: JSON.stringify({ askAbove: v }) }),
    runEstimates: (runId, at, model) => request(`runs/${q(runId)}/estimates${query({ at, model })}`),
    fixEstimates: (fixId, model) => request(`fixes/${q(fixId)}/estimates${query({ model })}`),
    testsEstimates: (update) => request(`tests/estimates${update?.length ? `?${update.map((p) => `update=${q(p)}`).join('&')}` : ''}`),
    bisectEstimate: (b) => request<{ estimate: Estimate }>(`estimates/bisect${query({ runId: b.runId, golden: b.golden, good: b.good, bad: b.bad })}`).then((r) => r.estimate),
  };
}

/** An exported copy runs no job, so it prices none and keeps no Spending: every call says so. */
export function noEstimates(refuse: () => Promise<never>): EstimatesApi {
  return { spending: refuse, setSpending: refuse, runEstimates: refuse, fixEstimates: refuse, testsEstimates: refuse, bisectEstimate: refuse };
}
