import { CONTROL_MIN_SAMPLES, defaultFrom, modelFamily, modelUse, noEstimate, otherFamilyWords, PREVIEW_SAMPLES, previewAsks, previewEstimate, retiredFields, retirementTable, type Estimate, type Price, type PricedCall, type Store } from '@shadowlap/engine';
import { fieldModels, startModel, type ModelFamily, type ModelOption } from './model-order.js';
import { estimateOf, pricingOf } from './pricing.js';
import { answer, type ReadAnswer } from './read-registry.js';

/**
 * A new preview's estimate (`GET /api/decisions/estimates`), for New preview's cards and its dialogs
 * as they change: what the change asks of the runs' recorded calls and what that costs (the engine's
 * `previewEstimate`), the models the runs use, what their answers show of `max_tokens`, a field the
 * model refuses, and the targets as the job takes them, so the dialog's command is the job's
 * (decisions-argv.ts). Read beside the server, by the runs' calls.
 */

export type PreviewEstimateJob = {
  kind: 'preview-estimate';
  /** The runs whose calls the preview asks: those named, and each golden's own. */
  runIds: string[];
  /** Goldens among the targets whose run the store lacks: their calls can't be priced, so the change has no estimate. */
  unrecorded: number;
  /** The targets as the job runs them: run ids and golden paths. */
  targets: string[];
  model: string | null;
  /** Each field to set, its value as `--set` gives it. */
  set: Array<[string, string]>;
  from: string[];
  scope: string | null;
  samples: number | null;
  fromCode: boolean;
  /** The models the providers list (model-listing.ts), for the switch's card while no change is named. */
  listed?: ModelOption[];
  prices?: Record<string, Price>;
};

/** What the preview a dialog names would ask, and cost. */
export interface PreviewEstimates {
  /** The change named, priced; null while none is named. */
  preview: Estimate | null;
  /** What it asks: the calls made with the models it switches from (all of them for fields alone), its samples' control, over how many runs; and, where a switch asks none for their family, the engine's words. */
  asks: { calls: number; from: string[]; control: boolean; runs: number; otherFamily: string | null };
  /** The models the runs' calls were made with, most used first. */
  recorded: Array<{ id: string; family: ModelFamily; calls: number }>;
  /** The longest answer the calls it asks recorded, in output tokens, and how many the `max_tokens` it sets would cut off. */
  answers: { most: number | null; cut: number | null };
  /** A field it sets that the model refuses, in the provider's page's words (the engine's table), with the page. */
  refused: { field: string; model: string; says: string; source: string } | null;
  targets: string[];
  /** While no change is named: each way's card at its default, the switch at the model its field starts on, the field `max_tokens` at 512. */
  ways: { model: string | null; modelSwitch: Estimate | null; fieldChange: Estimate | null } | null;
}

/** The value `--set` reads from `text`: JSON where it parses, else the text itself. */
function setValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** What the max_tokens a change sets shows of the recorded answers. */
function answersOf(asked: readonly PricedCall[], set: ReadonlyArray<readonly [string, string]>): PreviewEstimates['answers'] {
  const outs = asked.flatMap((c) => (c.usage ? [c.usage.outputTokens] : []));
  const limit = set.find(([f]) => f === 'max_tokens');
  const n = limit ? setValue(limit[1]) : null;
  return { most: outs.length ? Math.max(...outs) : null, cut: typeof n === 'number' && n > 0 ? outs.filter((o) => o > n).length : null };
}

export async function previewEstimates(store: Store, job: PreviewEstimateJob): Promise<ReadAnswer> {
  const pricing = pricingOf(store, job.prices);
  const raw = job.runIds.map((id) => pricing.raw(id));
  const use = modelUse(raw, job.scope);
  const priced = job.runIds.map((id) => pricing.calls(id));
  const fromOf = (model: string | null) => (job.from.length ? job.from : model ? (defaultFrom(use, 'decisions', model, Date.now())?.models ?? []) : []);
  const samples = job.samples ?? PREVIEW_SAMPLES;
  const priceOf = (model: string | null, n: number) =>
    job.unrecorded
      ? Promise.resolve(noEstimate('preview', 'a golden’s recording isn’t in this store, so its calls can’t be priced'))
      : estimateOf(() => previewEstimate(priced, { model, from: fromOf(model), ...(job.fromCode ? { fromCode: true } : {}) }, { samples: n, scope: job.scope, ...(job.prices ? { prices: job.prices } : {}) }), pricing);
  const named = job.model !== null || job.set.length > 0 || job.fromCode;
  const from = fromOf(job.model);
  const { asked, otherFamily } = previewAsks(priced, { model: job.model, from }, job.scope);
  const fields = Object.fromEntries(job.set.map(([f, text]) => [f, setValue(text)]));
  const refusal = job.set.length ? use.filter((u) => !from.length || from.includes(u.model)).flatMap((u) => retiredFields(u.provider, job.model ?? u.model, fields).map((f) => ({ f, model: job.model ?? u.model })))[0] : undefined;
  const recorded = use.map((u) => ({ id: u.model, family: modelFamily(u.model), calls: u.calls }));
  let ways: PreviewEstimates['ways'] = null;
  if (!named) {
    const model = startModel(fieldModels(recorded, job.listed ?? []), use[0]?.model ?? null);
    ways = { model, modelSwitch: model ? await priceOf(model, PREVIEW_SAMPLES) : null, fieldChange: await priceOf(null, 1) };
  }
  const body: PreviewEstimates = {
    preview: named ? await priceOf(job.model, samples) : null,
    asks: { calls: asked.length, from, control: samples >= CONTROL_MIN_SAMPLES, runs: job.targets.length, otherFamily: job.model && !asked.length && otherFamily ? otherFamilyWords(job.model) : null },
    recorded,
    answers: answersOf(asked, job.set),
    refused: refusal ? { field: refusal.f.field, model: refusal.model, says: `${refusal.model} is among ${refusal.f.rule.appliesTo}, where ${refusal.f.rule.says} (${retirementTable().platforms[refusal.f.rule.platform].owner})`, source: refusal.f.rule.source } : null,
    targets: job.targets,
    ways,
  };
  return answer(body, { tagged: true });
}
