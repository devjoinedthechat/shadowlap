import type { Estimate } from '../../engine/src/estimates/estimate.js';
import type { Spending } from '../../engine/src/estimates/spending.js';
import type { DecisionEstimates, FixEstimates, RunEstimates, TestsEstimates } from '../src/estimates.js';
import type { MigrateEstimateView } from '../src/migrate-estimate.js';
import type { ModelChoicesView } from '../src/model-listing.js';
import type { PreviewEstimates } from '../src/preview-estimate.js';
import { typedValue } from '../src/decisions-argv.js';
import type { Request } from './settings-api.js';

export type { DecisionEstimates, FixEstimates, GoldenEstimates, RunEstimates, TestsEstimates } from '../src/estimates.js';
export type { MigrateEstimateView } from '../src/migrate-estimate.js';
export type { ModelChoicesView } from '../src/model-listing.js';
export type { PreviewEstimates } from '../src/preview-estimate.js';

/** A new preview as its dialogs name it: its targets (every golden, or runs by id) and its change, or none for each way's card. */
export interface PreviewQuery {
  /** Every golden, or those named by their pack folder. */
  goldens?: 'all' | readonly string[];
  runs?: readonly string[];
  model?: string | null;
  /** Each field to set and its value as typed: sent as JSON where it parses, as the job takes it. */
  set?: ReadonlyArray<readonly [string, string]>;
  from?: readonly string[];
  scope?: string | null;
  samples?: number | null;
  fromCode?: boolean;
  /** With `fromCode`: each run's calls the working tree changes, by its id, as the dialog's read of it named them; priced once named. */
  changed?: Readonly<Record<string, readonly number[]>>;
  /** Stop at $: what the preview is held to. */
  budget?: number | null;
  /** It then verifies the runs it can't clear: no estimate until it has asked. */
  thenVerify?: boolean;
}

/** What else a migration keeps to: the scope of the calls it switches, and its Stop at $. */
export interface MigrateNarrow {
  scope?: string | null;
  budget?: number | null;
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
  /** Run tests' and each golden's, with Update goldens…' for `update` together where it names goldens, and Run tests on…' for `run` (`picked`). */
  testsEstimates(update?: readonly string[], run?: readonly string[]): Promise<TestsEstimates>;
  /** What a kept preview's Verify bills: on every run it could not clear, or on those `runIds` name (the runs no verify took yet); at Run more attempts' limits where given. */
  decisionEstimates(sessionId: string, runIds?: readonly string[], limits?: MoreLimits): Promise<DecisionEstimates>;
  /** What a new preview asks and bills (`POST /api/decisions/estimates`, which changes nothing); each way's card while it names no change. */
  previewEstimates(p: PreviewQuery): Promise<PreviewEstimates>;
  /** The models a preview's field offers beside the runs' own (`GET /api/model-choices`). It asks providers, so it can take a second. */
  modelChoices(): Promise<ModelChoicesView>;
  bisectEstimate(q: BisectQuery): Promise<Estimate>;
  /** What Migrate to `to` bills on the goldens and runs named, as its job asks them (every golden for none), switching from `from` in the scope it keeps to, held to its Stop at $, and the newest preview of that switch. */
  migrateEstimate(to: string, from: readonly string[], goldens: readonly string[], runs?: readonly string[], narrow?: MigrateNarrow): Promise<MigrateEstimateView>;
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
    testsEstimates: (update, run) => {
      const parts = [...(update ?? []).map((p) => `update=${q(p)}`), ...(run ?? []).map((p) => `run=${q(p)}`)];
      return request(`tests/estimates${parts.length ? `?${parts.join('&')}` : ''}`);
    },
    decisionEstimates: (sessionId, runIds, limits) => {
      const parts = [...(runIds ?? []).map((id) => `runId=${q(id)}`), ...(limits?.max ? [`max=${limits.max}`] : []), ...(limits?.keptMax ? [`keptMax=${limits.keptMax}`] : [])];
      return request(`decisions/${q(sessionId)}/estimates${parts.length ? `?${parts.join('&')}` : ''}`);
    },
    previewEstimates: (p) => request('decisions/estimates', { method: 'POST', body: JSON.stringify(previewBody(p)) }),
    migrateEstimate: (to, from, goldens, runs = [], narrow = {}) =>
      request(`migrate/estimate?${[`to=${q(to)}`, ...from.map((m) => `from=${q(m)}`), ...goldens.map((g) => `golden=${q(g)}`), ...runs.map((id) => `run=${q(id)}`), ...(narrow.scope ? [`scope=${q(narrow.scope)}`] : []), ...(narrow.budget ? [`budget=${narrow.budget}`] : [])].join('&')}`),
    modelChoices: () => request('model-choices'),
    bisectEstimate: (b) => request<{ estimate: Estimate }>(`estimates/bisect${query({ runId: b.runId, golden: b.golden, good: b.good, bad: b.bad })}`).then((r) => r.estimate),
  };
}

/**
 * A new preview's request, as `POST /api/decisions/estimates` reads it: the job's own fields, each
 * typed value as JSON where it parses (decisions-argv.ts), and in a body, so the 500 runs one
 * preview takes fit where a query's header would not.
 */
export function previewBody(p: PreviewQuery): Record<string, unknown> {
  return {
    ...(p.goldens === 'all' ? { goldens: 'all' } : p.goldens ? { goldens: [...p.goldens] } : {}),
    ...(p.runs ? { runs: [...p.runs] } : {}),
    ...(p.model ? { model: p.model } : {}),
    ...(p.set?.length ? { set: Object.fromEntries(p.set.map(([field, value]) => [field, typedValue(value)])) } : {}),
    ...(p.from?.length ? { from: [...p.from] } : {}),
    ...(p.scope ? { scope: p.scope } : {}),
    ...(typeof p.samples === 'number' ? { samples: p.samples } : {}),
    ...(p.fromCode ? { fromCode: true } : {}),
    ...(p.fromCode && p.changed ? { changed: p.changed } : {}),
    ...(p.budget ? { budget: p.budget } : {}),
    ...(p.thenVerify ? { thenVerify: true } : {}),
  };
}

/** An exported copy runs no job, so it prices none and keeps no Spending: every call says so. */
export function noEstimates(refuse: () => Promise<never>): EstimatesApi {
  return { spending: refuse, setSpending: refuse, runEstimates: refuse, fixEstimates: refuse, testsEstimates: refuse, decisionEstimates: refuse, previewEstimates: refuse, modelChoices: refuse, bisectEstimate: refuse, migrateEstimate: refuse };
}
