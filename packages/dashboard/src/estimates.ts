import {
  actionContext,
  bisectEstimate,
  buildActions,
  forkArgs,
  forkEstimate,
  goldenTestEstimate,
  injectionAgainEstimate,
  moreEstimate,
  noEstimate,
  plantEstimate,
  REPEAT_TIMES,
  repeatEstimate,
  runBisectEstimate,
  testsEstimate,
  updateEstimate,
  type CallRecord,
  type Estimate,
  type ForkEstimateChange,
  type PlantReport,
  type Price,
  type RunRecord,
  type Store,
  type TestResult,
} from '@shadowlap/engine';
import { lookupRun, noSuchRun } from './api.js';
import { attemptSpends, blamePrice, goldenBisectEstimate, judgeOnly, updatePrice } from './next-step.js';
import { estimateOf, pricingOf, type Pricing } from './pricing.js';
import { answer, failed, type ReadAnswer, type ReadTable } from './read-registry.js';
import { loadRunIndex, type RunIndex } from './run-index.js';
import { sessionLiveGoldens } from './tests-live.js';
import { gateResultView, normalizeAndTestJob, runTestsJob, unreadable, type GoldenSource } from './tests.js';

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

/**
 * Tests' estimates (`GET /api/tests/estimates`): Run tests', and each golden's on disk by its path, as
 * the Tests screen offers them. `goldens` are the packs on disk and `folder` their folder, as the
 * server lists them.
 */
export type TestsEstimatesJob = { kind: 'tests-estimates'; goldens: GoldenSource[]; folder: string; prices?: Record<string, Price> };

/**
 * Find breaking commit's (`GET /api/estimates/bisect`), `commits` apart as git counted them on the
 * server's thread: on a golden, or on a run, which replays live at each commit with `fork`.
 */
export type BisectEstimateJob = { kind: 'bisect-estimate'; commits: number; target: { golden: GoldenSource } | { runId: string; fork: boolean }; prices?: Record<string, Price> };

export type EstimateJob = RunEstimatesJob | TestsEstimatesJob | BisectEstimateJob;

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

/** A golden's: Run test (`rerun`), Update golden, and where they apply, Run more attempts and Add normalizer and re-run. */
export interface GoldenEstimates {
  rerun: Estimate | null;
  update: Estimate | null;
  more?: Estimate;
  normalize?: Estimate;
}

/** Tests' answer: Run tests', and each golden's by its path. */
export interface TestsEstimates {
  run: Estimate | null;
  goldens: Record<string, GoldenEstimates>;
}

/** A golden's newest finished plant: what its injection gate spent the last time it ran, as its report says. */
function newestGate(store: Store, golden: string): Partial<PlantReport> | null {
  const r = store.listInjectionResults({ golden, limit: 50 }).find((x) => x.mode === 'plant' && x.endedAt !== null);
  return r ? r.data : null;
}

/**
 * Run test on one golden, as its session runs it: Free only where nothing of it runs live
 * (tests-live.ts `liveReasons`). One marked fork runs live from where it parts; an injection gate
 * runs live from each read, at what it spent the last time; both, at what the two spent.
 */
function rerunEstimate(source: GoldenSource, r: TestResult | null, gate: Partial<PlantReport> | null): Estimate {
  const fork = source.mode === 'fork';
  if (!source.injection) return goldenTestEstimate(fork, r);
  if (!fork) return gate?.cost ? injectionAgainEstimate(gate as PlantReport) : noEstimate('injection', 'no estimate until its injection test has run once', ['live from each read, writes stubbed']);
  return testsEstimate(1, r && gate?.cost ? { results: [r], injection: [gate.cost] } : null);
}

async function goldenEstimates(store: Store, index: RunIndex, source: GoldenSource, pricing: Pricing, job: TestsEstimatesJob): Promise<GoldenEstimates> {
  const r = store.listTestResults({ golden: source.path, limit: 1 })[0] ?? null;
  const rerun = await estimateOf(() => rerunEstimate(source, r, source.injection ? newestGate(store, source.path) : null), pricing);
  // A verdict the pack lacks is one call of its judge; anything else, the golden recorded again.
  const only = judgeOnly(source, r);
  const update = await estimateOf(only ? () => updateEstimate([{ calls: [], judge: only.judge }]) : updatePrice(source).price!, pricing);
  const figure = r ? gateResultView(r, source.path)?.more : null;
  const more = r && figure ? await estimateOf((p) => moreEstimate(figure, attemptSpends(store, index, r.data?.attempts?.runs ?? [], p.prices)), pricing) : null;
  // Add normalizer and re-run tests the golden again, or updates it where the rules alone can't make it match.
  const normalizing = normalizeAndTestJob(store, job.goldens, { golden: source.path });
  const normalize = 'steps' in normalizing ? (normalizing.steps.some((step) => step.includes('--update')) ? update : rerun) : null;
  return { rerun, update, ...(more ? { more } : {}), ...(normalize ? { normalize } : {}) };
}

/**
 * Run tests: what the newest session with results spent live, with each live golden's injection gate
 * at what it spent the last time it ran; Free when every golden replays offline.
 */
function runTestsEstimate(store: Store, job: TestsEstimatesJob): Estimate {
  const live = sessionLiveGoldens(job.goldens, runTestsJob(job.goldens, {}, { folder: job.folder }));
  const session = store.listTestSessions({ limit: 1, withResults: true })[0];
  const gates = live.filter((g) => g.why.some((w) => w.kind === 'injection')).flatMap((g) => newestGate(store, g.path)?.cost ?? []);
  return testsEstimate(live.length, session ? { results: store.listTestResults({ sessionId: session.sessionId, limit: 100_000 }), injection: gates } : null);
}

async function testsEstimates(store: Store, job: TestsEstimatesJob): Promise<ReadAnswer> {
  const pricing = pricingOf(store, job.prices);
  const index = loadRunIndex(store);
  const goldens: Record<string, GoldenEstimates> = {};
  // A pack that can't be read, or named as an option, can't be tested: it has none.
  for (const source of job.goldens) if (!unreadable(source)) goldens[source.path] = await goldenEstimates(store, index, source, pricing, job);
  const body: TestsEstimates = { run: await estimateOf(() => runTestsEstimate(store, job), pricing), goldens };
  return answer(body, { tagged: true });
}

/** Find breaking commit, `commits` apart: on a golden as it replays (next-step.ts); on a run, live at each commit with `--fork`, else offline and Free. */
async function bisectEstimates(store: Store, job: BisectEstimateJob): Promise<ReadAnswer> {
  const t = job.target;
  const price =
    'golden' in t
      ? () => goldenBisectEstimate(store, loadRunIndex(store), t.golden, store.listTestResults({ golden: t.golden.path, limit: 1 })[0] ?? null, job.commits, job.prices)
      : t.fork
        ? (p: Pricing) => runBisectEstimate(p.calls(t.runId), job.commits)
        : () => bisectEstimate(job.commits, { fork: false, attempts: 0, each: null });
  return answer({ estimate: await estimateOf(price, pricingOf(store, job.prices)) }, { tagged: true });
}

export const ESTIMATE_READS: ReadTable<EstimateJob> = {
  'run-estimates': (store, job) => runEstimates(store, job),
  'tests-estimates': (store, job) => testsEstimates(store, job),
  'bisect-estimate': (store, job) => bisectEstimates(store, job),
};
