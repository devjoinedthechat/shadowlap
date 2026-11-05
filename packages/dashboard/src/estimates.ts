import { actionContext, buildActions, forkArgs, forkEstimate, plantEstimate, REPEAT_TIMES, repeatEstimate, type CallRecord, type Estimate, type ForkEstimateChange, type Price, type RunRecord, type Store } from '@shadowlap/engine';
import { lookupRun, noSuchRun } from './api.js';
import { blamePrice } from './next-step.js';
import { estimateOf, pricingOf, type Pricing } from './pricing.js';
import { answer, failed, type ReadAnswer, type ReadTable } from './read-registry.js';

/**
 * What a billed job would cost, for the cards and asks of the controls that start one: worked out
 * beside the server, as each reads a recording's calls (read-registry.ts), and asked when the page or
 * the menu opens, apart from the page's own answer, so the page stays quick. Each figure is the
 * engine's estimate for the job as it runs (packages/engine/src/estimates), so the card, the ask,
 * Spending and the drawer say the same. One that can't be worked out is left out, never the answer:
 * what it reads can come from someone else's pack.
 */

/**
 * A run's estimates (`GET /api/runs/:id/estimates`): its Run blame, and each fork menu row's at call
 * `at`, by the row's key, as the menu has it there (engine run-actions.ts `buildActions`); without
 * `at`, the whole run's rows alone. `model` is Switch model's, as typed; without it, the recorded
 * model's price.
 */
export type RunEstimatesJob = { kind: 'run-estimates'; runId: string; at: number | null; model: string | null; prices?: Record<string, Price> };

export type EstimateJob = RunEstimatesJob;

/** A run's answer: Run blame's estimate, and each row's by its key. */
export interface RunEstimates {
  blame: Estimate | null;
  actions: Record<string, Estimate>;
}

/** How a fork menu row at call `call` changes the run, as its estimate reads it, by the row's key; null for one that bills by another rule, or nothing. */
function forkChange(key: string, call: CallRecord, model: string | null): Omit<ForkEstimateChange, 'at' | 'prices'> | null {
  if (key === 'a' || key === 'g' || key === 'i' || key === 'o' || key === 'u' || key === 't') return {};
  if (key === 'l') return { write: call.effect === 'write' };
  if (key === 'm') return { model };
  if (key === 'f') return { answered: true };
  return null;
}

/** What a row bills, by its key: a fork from the call, a planted instruction, or the whole run again; null for one that bills nothing (Replay, a normalizer, Pack). */
function rowPrice(key: string, run: RunRecord, call: CallRecord | undefined, job: RunEstimatesJob): ((p: Pricing) => Estimate) | null {
  const o = { prices: job.prices };
  // Repeat, and Replay with writes stubbed on a replay Shadowlap made: each attempt made again from the parent, live from where it forks.
  if (key === 'e') return (p) => repeatEstimate(run, p.raw(run.runId), REPEAT_TIMES, o);
  if (key === 's') return forkArgs(run) === null ? null : (p) => repeatEstimate(run, p.raw(run.runId), 1, o);
  if (!call) return null;
  if (key === 'x') return (p) => plantEstimate(p.calls(run.runId), call.callNo);
  const change = forkChange(key, call, job.model);
  return change ? (p) => forkEstimate(p.calls(run.runId), { at: call.callNo, ...change, ...o }) : null;
}

async function runEstimates(store: Store, job: RunEstimatesJob): Promise<ReadAnswer> {
  const run = lookupRun(store, job.runId);
  if (!run) {
    const no = noSuchRun(store, job.runId);
    return failed(no.status, no.message);
  }
  const call = job.at === null ? undefined : store.getCalls(run.runId, { only: [job.at] })[0];
  if (job.at !== null && !call) return failed(404, `no call #${job.at} in run ${run.runId}`);
  const pricing = pricingOf(store, job.prices);
  const actions: Record<string, Estimate> = {};
  // A row turned off runs nothing, so it bills nothing.
  for (const a of buildActions(run, call, actionContext(store, call))) {
    const price = a.disabled ? null : rowPrice(a.key, run, call, job);
    const e = price ? await estimateOf(price, pricing) : null;
    if (e) actions[a.key] = e;
  }
  const body: RunEstimates = { blame: await estimateOf(blamePrice(run.runId).price!, pricing), actions };
  return answer(body, { tagged: true });
}

export const ESTIMATE_READS: ReadTable<EstimateJob> = {
  'run-estimates': (store, job) => runEstimates(store, job),
};
