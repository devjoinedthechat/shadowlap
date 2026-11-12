import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { Spending } from '../../engine/src/estimates/spending.js';
import type { DecisionEstimates, FixEstimates, RunEstimates, TestsEstimates } from '../src/estimates.js';
import type { ModelChoicesView } from '../src/model-listing.js';
import type { PreviewEstimates } from '../src/preview-estimate.js';
import type { Request } from './settings-api.js';

export type { DecisionEstimates, FixEstimates, GoldenEstimates, RunEstimates, TestsEstimates } from '../src/estimates.js';
export type { ModelChoicesView } from '../src/model-listing.js';
export type { PreviewEstimates } from '../src/preview-estimate.js';

/** A new preview as its dialogs name it: its targets (every golden, or runs by id) and its change, or none for each way's card. */
export interface PreviewQuery {
  goldens?: 'all';
  runs?: readonly string[];
  model?: string | null;
  /** Each field to set and its value as typed: sent as JSON where it parses, as the job takes it. */
  set?: ReadonlyArray<readonly [string, string]>;
  from?: readonly string[];
  scope?: string | null;
  samples?: number | null;
  fromCode?: boolean;
}

/** Run more attempts' raised limits: a failing run's attempts (the gate's max) and a good run's pairs. */
export interface MoreLimits {
  max?: number | null;
  keptMax?: number | null;
}

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
  /** What a kept preview's Verify bills: on every run it could not clear, or on those `runIds` name (the runs no verify took yet); at Run more attempts' limits where given. */
  decisionEstimates(sessionId: string, runIds?: readonly string[], limits?: MoreLimits): Promise<DecisionEstimates>;
  /** What a new preview asks and bills (`GET /api/decisions/estimates`); each way's card while it names no change. */
  previewEstimates(p: PreviewQuery): Promise<PreviewEstimates>;
  /** The models a preview's field offers beside the runs' own (`GET /api/model-choices`). It asks providers, so it can take a second. */
  modelChoices(): Promise<ModelChoicesView>;
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
    decisionEstimates: (sessionId, runIds, limits) => {
      const parts = [...(runIds ?? []).map((id) => `runId=${q(id)}`), ...(limits?.max ? [`max=${limits.max}`] : []), ...(limits?.keptMax ? [`keptMax=${limits.keptMax}`] : [])];
      return request(`decisions/${q(sessionId)}/estimates${parts.length ? `?${parts.join('&')}` : ''}`);
    },
    previewEstimates: (p) => request(`decisions/estimates?${previewQuery(p)}`),
    modelChoices: () => request('model-choices'),
    bisectEstimate: (b) => request<{ estimate: Estimate }>(`estimates/bisect${query({ runId: b.runId, golden: b.golden, good: b.good, bad: b.bad })}`).then((r) => r.estimate),
  };
}

/** A new preview's query string, as `GET /api/decisions/estimates` reads it. */
export function previewQuery(p: PreviewQuery): string {
  const q = encodeURIComponent;
  return [
    ...(p.goldens === 'all' ? ['goldens=all'] : []),
    ...(p.runs ?? []).map((id) => `runId=${q(id)}`),
    ...(p.model ? [`model=${q(p.model)}`] : []),
    ...(p.set ?? []).map(([field, value]) => `set=${q(`${field}=${value}`)}`),
    ...(p.from ?? []).map((m) => `from=${q(m)}`),
    ...(p.scope ? [`scope=${q(p.scope)}`] : []),
    ...(typeof p.samples === 'number' ? [`samples=${p.samples}`] : []),
    ...(p.fromCode ? ['fromCode=1'] : []),
  ].join('&');
}

/** An exported copy runs no job, so it prices none and keeps no Spending: every call says so. */
export function noEstimates(refuse: () => Promise<never>): EstimatesApi {
  return { spending: refuse, setSpending: refuse, runEstimates: refuse, fixEstimates: refuse, testsEstimates: refuse, decisionEstimates: refuse, previewEstimates: refuse, modelChoices: refuse, bisectEstimate: refuse };
}
