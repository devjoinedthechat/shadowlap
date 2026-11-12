import {
  actionContext,
  bisectEstimate,
  blameEstimate,
  buildActions,
  decisionRunCost,
  DEFAULT_REPAIRER,
  fixRecords,
  fixRunArgs,
  forkArgs,
  forkEstimate,
  moreEstimate,
  noFixReason,
  plantEstimate,
  recordedChecks,
  recordedRole,
  REPEAT_TIMES,
  repairEstimate,
  repairerProblem,
  repeatEstimate,
  resolveFix,
  reusedBlame,
  runBisectEstimate,
  selectedRuns,
  shownBlame,
  STRONGER_MODEL,
  testsEstimate,
  unsettledFirst,
  updateEstimate,
  verifyEstimate,
  verifyMoreEstimate,
  verifyRunCosts,
  wholeRun,
  type CallRecord,
  type Estimate,
  type FixRecords,
  type ForkEstimateChange,
  type Price,
  type RunRecord,
  type Store,
  type StoredBlame,
  type InjectionPlan,
  packRecording,
  type ToolTrust,
} from '@shadowlap/engine';
import { lookupRun, noSuchRun } from './api.js';
import { decisionSession, runsToVerify, sessionReport } from './decisions.js';
import { nextBlameRule } from './fix-blame-step.js';
import { acceptedVerdict, sprtGate } from './fix-shared.js';
import { verdictRule, verifyLeftExpected } from './fix-verify-step.js';
import { fixDetail } from './fixes.js';
import { causePrice, gatePrice, injectionPrice } from './injection-plan.js';
import { CANT_READ_RECORDING } from './injection-security.js';
import { attemptSpends, blamePrice, goldenBisectEstimate, goldenRerunPrice, judgeOnly, newestGate } from './next-step.js';
import { estimateOf, pricingOf, type Priced, type Pricing } from './pricing.js';
import { answer, failed, type ReadAnswer, type ReadTable } from './read-registry.js';
import { loadRunIndex, type RunIndex } from './run-index.js';
import { parseWork, type OutcomeWork } from './run-outcome.js';
import { sessionLiveGoldens, type LiveReason } from './tests-live.js';
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
export type RunEstimatesJob = { kind: 'run-estimates'; runId: string; at: number | null; model: string | null; prices?: Record<string, Price>; tools?: ToolTrust };

/**
 * Tests' estimates (`GET /api/tests/estimates`): Run tests', and each golden's on disk by its path, as
 * the Tests screen offers them. `goldens` are the packs on disk and `folder` their folder, as the
 * server lists them; `update`, the goldens Update goldens… would re-record together, by path.
 */
export type TestsEstimatesJob = { kind: 'tests-estimates'; goldens: GoldenSource[]; folder: string; update?: string[]; prices?: Record<string, Price> };

/**
 * Find breaking commit's (`GET /api/estimates/bisect`), `commits` apart as git counted them on the
 * server's thread: on a golden, or on a run, which replays live at each commit with `fork`.
 */
export type BisectEstimateJob = { kind: 'bisect-estimate'; commits: number; target: { golden: GoldenSource } | { runId: string; fork: boolean }; prices?: Record<string, Price> };

/** The config's `verify`, as a repair's candidates and Run more attempts are verified: the most pairs a good run takes, and what it is kept against. */
export interface ConfigVerifyRule {
  keptMax: number | null;
  baseline: 'paired' | 'history';
}

/**
 * A fix's estimates (`GET /api/fixes/:id/estimates`), for what its page offers: Run repair, Run blame
 * again, Run blame with stronger model at `model` (as typed; without it, the model its field offers
 * first), and each Verify step's Run more attempts or Verify again. The repairer
 * shadowlap.config.json names, and its `verify` (`rule`), are read on the server's thread.
 */
export type FixEstimatesJob = { kind: 'fix-estimates'; fixId: string; repairer: string | null; rule: ConfigVerifyRule; model: string | null; prices?: Record<string, Price>; inTree?: Array<[string, boolean | null]> };

/**
 * A kept preview's Verify (`GET /api/decisions/:id/estimates`): the runs it could not clear, or the
 * one `runId` names, as `decisions --verify` takes them. `work` is the config's tests, as the
 * outcome's reads take it, which give each run's checks; `rule` the config's `verify`.
 */
export type DecisionEstimatesJob = { kind: 'decision-estimates'; sessionId: string; runIds: string[]; work: OutcomeWork | null; rule: ConfigVerifyRule; prices?: Record<string, Price> };

/**
 * A dialog's price. Run injection test…'s and Pack with injection gate…'s: the plan picked, priced as
 * a test (or, `gate`, as each session's gate), on a run of the store, or on the recording a golden's
 * pack holds where the store doesn't (`pack`, the golden's folder). Find cause…'s: one read made
 * neutral (`clean`), as the dialog picks it.
 */
export type InjectionEstimateJob = { kind: 'injection-estimate'; runId: string; pack?: string; clean?: number; plan: InjectionPlan; gate: boolean; prices?: Record<string, Price>; tools?: ToolTrust };

export type EstimateJob = RunEstimatesJob | FixEstimatesJob | TestsEstimatesJob | BisectEstimateJob | DecisionEstimatesJob | InjectionEstimateJob;

/** A run's answer: Run blame's estimate, and each row's by its key. */
export interface RunEstimates {
  blame: Estimate | null;
  actions: Record<string, Estimate>;
  /** Run injection test… at the plan nobody picked, as its openers' cards and its dialog's first cost line say it: in the whole run's answer (no `at`) alone. */
  injection?: Estimate | null;
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
  return change ? (p) => forkEstimate(p.calls(run.runId), { at: key === 'l' ? firstCallOf(p.raw(run.runId), call) : call.callNo, ...change, ...o }) : null;
}

/** Force <tool> live runs the tool for real from its first call (`--live-tool`), wherever the menu opened on it. */
function firstCallOf(calls: readonly CallRecord[], call: CallRecord): number {
  return calls.find((c) => c.kind === 'tool' && c.name === call.name)?.callNo ?? call.callNo;
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
  const body: RunEstimates = {
    blame: await estimateOf(blamePrice(run.runId).price!, pricing),
    actions,
    // The whole run's alone: a menu opened at each call asks its rows again, never this.
    ...(job.at === null ? { injection: await estimateOf(injectionPrice(run.runId, job.tools), pricing) } : {}),
  };
  return answer(body, { tagged: true });
}

/** A dialog's plan's answer: `{ estimate }`, null where it can't be worked out (the line is then left out). */
async function injectionPlanEstimate(store: Store, job: InjectionEstimateJob): Promise<ReadAnswer> {
  if (job.pack !== undefined) return packPlanEstimate(job.pack, job);
  const run = lookupRun(store, job.runId);
  if (!run) {
    const no = noSuchRun(store, job.runId);
    return failed(no.status, no.message);
  }
  return answer({ estimate: await estimateOf(dialogPrice(run.runId, job), pricingOf(store, job.prices)) }, { tagged: true });
}

const dialogPrice = (runId: string, job: InjectionEstimateJob) => (job.clean !== undefined ? causePrice(runId, job.tools, job.clean) : job.gate ? gatePrice(runId, job.tools, job.plan) : injectionPrice(runId, job.tools, job.plan));

/** A plan on a golden whose recording only its pack holds, priced from the pack, read into a store of its own, then closed. */
async function packPlanEstimate(folder: string, job: InjectionEstimateJob): Promise<ReadAnswer> {
  let pack: ReturnType<typeof packRecording>;
  try {
    pack = packRecording(folder);
  } catch {
    return failed(404, CANT_READ_RECORDING);
  }
  try {
    return answer({ estimate: await estimateOf(dialogPrice(pack.run.runId, job), pricingOf(pack.store, job.prices)) }, { tagged: true });
  } finally {
    pack.store.close();
  }
}

/** A fix's answer: each of its page's billed buttons, and each Verify step's by its verdict's id. */
export interface FixEstimates {
  repair: Estimate | null;
  blameAgain: Estimate | null;
  blameStronger: Estimate | null;
  verify: Record<string, Estimate>;
  /** Verify this run, on a verified fix's failing runs no accepted verdict checked (`actions.verifyLeft`); null where it isn't offered. */
  verifyLeft: Estimate | null;
}


/**
 * Run repair as its command selects the runs (engine fix-jobs.ts `repairArgv`): each failing run with
 * the blame the repair would reuse on it under the fix's check and its blame's scope, so a blame is
 * priced only where it runs one; the good runs each candidate must keep passing; and Free where it
 * ends "No fix to try" before it runs anything.
 */
function repairPrice(store: Store, rec: FixRecords, job: FixEstimatesJob, p: Pricing): Estimate {
  const runs = fixRunArgs(store, rec);
  const scope = shownBlame(rec)?.scope ?? null;
  const oracle = rec.fix.check.oracle;
  const failing = selectedRuns(store, ['--fixes', ...(runs?.fixes ?? [])]).map((r) => {
    const reused = reusedBlame(store, r.runId, { oracle, fields: {}, scope });
    return { runId: r.runId, startedAt: r.startedAt, calls: p.calls(r.runId), blame: reused ? { outcome: reused.stored.outcome } : null };
  });
  const good = selectedRuns(store, ['--keeps', ...(runs?.keeps ?? [])]).map((r) => ({ calls: p.calls(r.runId) }));
  const noFix = noFixReason(store, rec, scope)?.kind ?? null;
  return repairEstimate({ failing, good, scope, rule: job.rule, repairer: job.repairer ?? DEFAULT_REPAIRER, noFix, last: rec.verdicts.at(-1)?.report ?? null, ...(p.prices ? { prices: p.prices } : {}) });
}

/**
 * Run blame again (`again`), or with a stronger model at `model`, as its command runs: the shown
 * blame's run under its scope, by the gate or count the command carries; again, at the model the
 * blame asked, a search under a check the fix has changed since starting over (`fresh`).
 */
function blameNextPrice(rec: FixRecords, b: StoredBlame, o: { again: boolean; model: string | null }, p: Pricing): Estimate | null {
  const rule = nextBlameRule(b, o.again && unsettledFirst(b.report));
  if (!rule) return null;
  const asked = b.report.rescue.fields.model;
  const model = o.again ? (typeof asked === 'string' ? asked : null) : o.model;
  const fresh = o.again && JSON.stringify(b.report.oracle) !== JSON.stringify(rec.fix.check.oracle);
  return blameEstimate(p.calls(b.runId), { ...rule, scope: b.scope, model, last: b.report, fresh, ...(p.prices ? { prices: p.prices } : {}) });
}

/**
 * Verify this run, as its command runs (`actions.verifyLeft`): each run left priced from its
 * recording, every attempt at most live from its first model call, by the accepted verdict's gate or
 * count; what it is expected to take as the Verify step's more attempts work theirs.
 */
function verifyLeftPrice(rec: FixRecords, runs: readonly string[], job: FixEstimatesJob, p: Pricing): Estimate | null {
  const v = acceptedVerdict(rec);
  if (!v) return null;
  const { gate, attempts } = verdictRule(v);
  const rule = { ...job.rule, ...(gate ? { gate } : { attempts }) };
  return verifyEstimate(
    runs.map((id) => wholeRun('target', p.calls(id))),
    { rule, expected: verifyLeftExpected(v, runs.length) },
  );
}

/** The `--budget` a step's command runs with, before any command of the agent's own after `--`; null for none. */
function budgetOf(argv: readonly string[]): number | null {
  const end = argv.indexOf('--');
  const i = (end < 0 ? argv : argv.slice(0, end)).indexOf('--budget');
  const usd = i < 0 ? Number.NaN : Number(argv[i + 1]);
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

async function fixEstimates(store: Store, job: FixEstimatesJob): Promise<ReadAnswer> {
  const inTree = job.inTree ? new Map(job.inTree) : null;
  const d = fixDetail(store, job.fixId, { repairer: job.repairer, checkRepairer: repairerProblem, ...(inTree ? { patchInTree: (patch: string) => inTree.get(patch) ?? null } : {}) });
  const fix = d ? resolveFix(store, job.fixId) : null;
  if (!d || !fix) return failed(404, `no fix ${job.fixId.slice(0, 40)}`);
  const rec = fixRecords(store, fix);
  const pricing = pricingOf(store, job.prices);
  const b = shownBlame(rec);
  const next = (again: boolean) => (b ? estimateOf((p) => blameNextPrice(rec, b, { again, model: job.model ?? STRONGER_MODEL }, p), pricing) : null);
  const left = d.actions.verifyLeft;
  const verify: Record<string, Estimate> = {};
  for (const step of d.verify) {
    const more = step.more;
    const v = more ? rec.verdicts.find((x) => x.verifyId === step.verifyId) : undefined;
    if (!more || !v) continue;
    // Each run verified again from its first attempt, up to the step's limit, by the verdict's gate or
    // count; Verify again with the budget it ran with, which Run more attempts leaves out.
    const g = sprtGate(v.report.gate);
    const rule = { ...job.rule, ...(g ? { gate: { ...g, max: more.max } } : { attempts: more.max }) };
    const e = await estimateOf(() => (more.kind === 'more' ? verifyMoreEstimate(verifyRunCosts(v.report), { expected: more.expected, cost: more.cost }, { rule, last: v.report }) : verifyEstimate(verifyRunCosts(v.report), { rule, last: v.report, budget: budgetOf(more.argv) })), pricing);
    if (e) verify[step.verifyId] = e;
  }
  const body: FixEstimates = {
    repair: d.actions.repair ? await estimateOf((p) => repairPrice(store, rec, job, p), pricing) : null,
    blameAgain: d.actions.blameAgain ? await next(true) : null,
    blameStronger: d.actions.blameStronger ? await next(false) : null,
    verify,
    verifyLeft: left ? await estimateOf((p) => verifyLeftPrice(rec, left.runs, job, p), pricing) : null,
  };
  return answer(body, { tagged: true });
}

/** A golden's: Run test (`rerun`), Update golden, and where they apply, Run more attempts and Add normalizer and re-run. */
export interface GoldenEstimates {
  rerun: Estimate | null;
  update: Estimate | null;
  more?: Estimate;
  normalize?: Estimate;
}

/** Tests' answer: Run tests', each golden's by its path, and Update goldens…' for the goldens the read named. */
export interface TestsEstimates {
  run: Estimate | null;
  goldens: Record<string, GoldenEstimates>;
  update?: Estimate | null;
}

/** Update golden(s) for these goldens, one update: each recorded again, or a golden that only lacks a judge's verdict asking that judge once. */
function updateOf(store: Store, sources: readonly GoldenSource[]): NonNullable<Priced['price']> {
  const each = sources.map((source) => ({ source, only: judgeOnly(source, store.listTestResults({ golden: source.path, limit: 1 })[0] ?? null) }));
  return (p) => updateEstimate(each.map(({ source, only }) => (only ? { calls: [], judge: only.judge } : { calls: source.runId ? p.calls(source.runId) : [] })));
}

async function goldenEstimates(store: Store, index: RunIndex, source: GoldenSource, pricing: Pricing, job: TestsEstimatesJob): Promise<GoldenEstimates> {
  const r = store.listTestResults({ golden: source.path, limit: 1 })[0] ?? null;
  const rerun = await estimateOf(() => goldenRerunPrice(store, source, r), pricing);
  // A verdict the pack lacks is one call of its judge; anything else, the golden recorded again.
  const update = await estimateOf(updateOf(store, [source]), pricing);
  const figure = r ? gateResultView(r, source.path)?.more : null;
  const more = r && figure ? await estimateOf((p) => moreEstimate(figure, attemptSpends(store, index, r.data?.attempts?.runs ?? [], p.prices)), pricing) : null;
  // Add normalizer and re-run tests the golden again, or updates it where the rules alone can't make it match.
  const normalizing = normalizeAndTestJob(store, job.goldens, { golden: source.path });
  const normalize = 'steps' in normalizing ? (normalizing.steps.some((step) => step.includes('--update')) ? update : rerun) : null;
  return { rerun, update, ...(more ? { more } : {}), ...(normalize ? { normalize } : {}) };
}

/**
 * Run tests: what each golden it runs live spent the last time it ran, as the mock adds them up (a
 * session that re-ran one golden says nothing of the others): the newest test of each that forks,
 * and each injection gate's newest; none until each has run once, and Free when every golden replays
 * offline.
 */
function runTestsEstimate(store: Store, job: TestsEstimatesJob): Estimate {
  const live = sessionLiveGoldens(job.goldens, runTestsJob(job.goldens, {}, { folder: job.folder }));
  const by = (kind: LiveReason['kind']) => live.filter((g) => g.why.some((w) => w.kind === kind));
  const results = by('fork').map((g) => store.listTestResults({ golden: g.path, limit: 1 })[0] ?? null);
  const gates = by('injection').map((g) => newestGate(store, g.path)?.cost ?? null);
  return testsEstimate(live.length, { results, injection: gates });
}

async function testsEstimates(store: Store, job: TestsEstimatesJob): Promise<ReadAnswer> {
  const pricing = pricingOf(store, job.prices);
  const index = loadRunIndex(store);
  const goldens: Record<string, GoldenEstimates> = {};
  // A pack that can't be read, or named as an option, can't be tested: it has none.
  for (const source of job.goldens) if (!unreadable(source)) goldens[source.path] = await goldenEstimates(store, index, source, pricing, job);
  const updating = job.goldens.filter((g) => job.update?.includes(g.path) && !unreadable(g));
  const update = updating.length ? { update: await estimateOf(updateOf(store, updating), pricing) } : {};
  const body: TestsEstimates = { run: await estimateOf(() => runTestsEstimate(store, job), pricing), goldens, ...update };
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

/** A kept preview's: what its Verify bills, null when it leaves nothing to verify there, or a run it names is gone. */
export interface DecisionEstimates {
  verify: Estimate | null;
}

/**
 * What `decisions --verify` bills on a kept session, as it runs: each run in the role its recording
 * plays under its checks (a golden's from the config, else those of the recording it comes from),
 * priced at what a run costs under the change (decisionRunCost), up to verify's own gate and the
 * config's `verify`. Live from the first model call for a switch; where a replay forks for the
 * prompt and tools in the working tree, which verify replays from the code.
 */
async function decisionEstimates(store: Store, job: DecisionEstimatesJob): Promise<ReadAnswer> {
  const session = decisionSession(store, job.sessionId);
  if (!session) return failed(404, `no session ${job.sessionId.slice(0, 40)}`);
  const report = sessionReport(session);
  const ids = runsToVerify(session, job.runIds.length ? job.runIds : undefined);
  const picked = (Array.isArray(ids) ? ids : []).map((id) => ({ row: report.runs?.find((r) => r.runId === id), run: store.getRun(id) }));
  if (!picked.length || picked.some((p) => !p.row || !p.run)) return answer({ verify: null } satisfies DecisionEstimates, { tagged: true });
  const entries = parseWork(job.work)?.entries ?? [];
  const price = () =>
    verifyEstimate(
      picked.map(({ row, run }) => decisionRunCost(row!, recordedRole(store, run!, recordedChecks(entries, store, run!, job.work?.dir ?? process.cwd(), row!.golden)?.spec ?? null, job.prices) === 'target')),
      { rule: job.rule, live: report.change?.fromCode ? 'fork' : 'first', writes: 'stub' },
    );
  return answer({ verify: await estimateOf(price, pricingOf(store, job.prices)) } satisfies DecisionEstimates, { tagged: true });
}

export const ESTIMATE_READS: ReadTable<EstimateJob> = {
  'run-estimates': (store, job) => runEstimates(store, job),
  'fix-estimates': (store, job) => fixEstimates(store, job),
  'tests-estimates': (store, job) => testsEstimates(store, job),
  'bisect-estimate': (store, job) => bisectEstimates(store, job),
  'decision-estimates': (store, job) => decisionEstimates(store, job),
  'injection-estimate': (store, job) => injectionPlanEstimate(store, job),
};
