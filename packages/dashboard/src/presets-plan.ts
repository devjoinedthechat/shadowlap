import {
  chaosIn,
  chaosJudge,
  chaosTargets,
  chaosToolChoices,
  commandIsImported,
  effectsFor,
  expectPrefill,
  gateWords,
  importedCommandSource,
  isObject,
  JUDGED_FROM,
  messageOf,
  parseExpect,
  presetsEstimate,
  presetsGate,
  presetsTarget,
  quoteArgv,
  recordedChecks,
  replayChaosSpec,
  specFor,
  storeEffects,
  testsEntryFor,
  type ChaosJudge,
  type ChaosPreset,
  type ChaosSpec,
  type ChaosTarget,
  type Effect,
  type Estimate,
  type PresetGate,
  type Price,
  type RunRecord,
  type Store,
  type TestSpec,
} from '@shadowlap/engine';
import { resolve } from 'node:path';
import { lookupRun, noSuchRun } from './api.js';
import { estimateOf, pricingOf } from './pricing.js';
import { answer, failed, type ReadAnswer, type ReadTable } from './read-registry.js';
import { parseWork, type OutcomeWork } from './run-outcome.js';

/**
 * Run error-path presets…'s plan, a pooled read (`GET /api/chaos/runs/:id/plan`): the recording the
 * presets run on and the golden whose presets they are, the tools they can hit and where, what judges
 * every attempt and what decides, the command someone else recorded that runs here, and what the
 * picks bill. It works each out as the CLI does (the engine's chaosTargets, replayChaosSpec,
 * chaosJudge, presetsGate and presetsEstimate), from what the server read first.
 */
export type PresetsPlanJob = {
  kind: 'presets-plan';
  /** The run the dialog opened on. */
  runId: string;
  /** The picks: the presets (what the command runs naming none, when absent) and the tool (the first it would hit). */
  presets?: ChaosPreset[];
  tool?: string;
  /** The `--expect` field has checks: `replay --chaos` is then judged by them, one attempt each. */
  expect?: boolean;
  /** The config's tests as written, the project's folder and its goldens, read on the server's thread. */
  work: OutcomeWork | null;
  /** The command a golden from a pack the repository doesn't track runs (goldensNeedingConsent), read on the server's thread. */
  untracked?: string[] | null;
  /** `mcp.effects` in the config, over the effects the store has seen. */
  effects?: Record<string, string>;
  /** Names show (a team store): who recorded a command someone else did. */
  shared: boolean;
  prices?: Record<string, Price>;
};

/** What the dialog asks and draws, for the picks it was asked with. */
export interface PresetsPlan {
  /** The recording the presets run on: the run, or the recording a clean or test replay came from. */
  target: string;
  /** The golden whose recording it is: `test <golden> --chaos`; null runs `replay <target> --chaos`. */
  golden: string | null;
  /** The presets the command runs when it names none, in their order. */
  presets: ChaosPreset[];
  /** The tools the tool presets can hit, each at its first answered call, in call order. */
  choices: Array<{ name: string; callNo: number }>;
  /** The tool they hit when the command names none, or null when there is none. */
  tool: string | null;
  /** Where the picks hit: the tool call, and the model call that reads its answer, or the engine's words for why none. */
  at: { tool: ChaosTarget; model: ChaosTarget };
  /** What judges every attempt besides the agent exiting 0, with `--expect` empty; `from` says where it comes from, null for the exit alone. */
  judge: ChaosJudge & { from: string | null };
  /** The `--expect` to start the field with: the write limit the run's own failed check set (Q8), else null. */
  expect: string | null;
  /** What decides each preset: a sequential gate's figures, or the count that must pass; `rule` in the engine's words. */
  gate: PresetGate;
  rule: string;
  /** A command someone else recorded, which each preset runs on this machine: where it came from, and who recorded it where names show. */
  runsHere: { command: string; from: string; by: string | null } | null;
  /** What the picks bill at most, or null where it can't be worked out. */
  estimate: Estimate | null;
}

/** How a golden's or a run's presets are set and judged, as the command the dialog shows would run them. */
interface PlanSpec {
  golden: string | null;
  chaos: ChaosSpec;
  spec: TestSpec | null;
}

/**
 * `test <golden> --chaos` for a golden's recording whose tests entry runs its presets; else `replay
 * <run> --chaos`, set and judged by replayChaosSpec from the checks the run is judged by (its golden's
 * entry found through it and its ancestors, or `--expect`). A golden whose entry says `"chaos": false`
 * is skipped by `test --chaos`, so its recording's presets run as a run's.
 */
function planSpec(store: Store, target: RunRecord, job: PresetsPlanJob): PlanSpec {
  const work = job.work;
  const dir = work?.dir ?? process.cwd();
  const entries = parseWork(work)?.entries ?? [];
  const chaosOf = (folder: string) => chaosIn(work?.tests, testsEntryFor(entries, folder, dir)?.recording ?? null, parseExpect);
  const golden = work?.goldens.find((g) => g.runId === target.runId);
  const own = golden ? chaosOf(golden.path) : false;
  if (golden && own !== false) return { golden: golden.path, chaos: own, spec: specFor(entries, resolve(dir, golden.path), dir) };
  const checks = job.expect ? { spec: parseExpect({}, '--expect'), source: '--expect' } : recordedChecks(entries, store, target, dir);
  const { chaos, golden: spec } = replayChaosSpec(checks, chaosOf);
  return { golden: null, chaos, spec };
}

/** The run's own `--expect`, read as the CLI read it; null for one judged by its golden's checks, or none. */
function ownChecks(run: RunRecord): TestSpec | null {
  const raw = run.meta?.expect;
  if (!isObject(raw)) return null;
  try {
    return parseExpect(raw, '--expect');
  } catch {
    return null;
  }
}

async function presetsPlan(store: Store, job: PresetsPlanJob): Promise<ReadAnswer> {
  const run = lookupRun(store, job.runId);
  const target = run ? lookupRun(store, presetsTarget(run)) : null;
  if (!run || !target) {
    const no = noSuchRun(store, run ? presetsTarget(run) : job.runId);
    return failed(no.status, no.message);
  }
  let plan: PlanSpec;
  try {
    plan = planSpec(store, target, job);
  } catch (err) {
    return failed(400, messageOf(err));
  }
  const pricing = pricingOf(store, job.prices);
  const calls = pricing.raw(target.runId);
  const effectOf = effectsFor(calls, storeEffects(store, new Map(Object.entries(job.effects ?? {}) as Array<[string, Effect]>)));
  const { judge } = chaosJudge(plan.chaos, plan.spec, effectOf);
  const gate = presetsGate(plan.chaos, plan.spec);
  const first = chaosTargets(calls, { tool: plan.chaos.tool }).tool;
  const at = chaosTargets(calls, { tool: job.tool ?? plan.chaos.tool });
  const presets = job.presets ?? plan.chaos.presets;
  const price = (p: typeof pricing) => presetsEstimate(p.calls(target.runId), chaosTargets(p.raw(target.runId), { tool: job.tool ?? plan.chaos.tool }), { presets, ...('good' in gate ? { gate: { max: gate.max } } : { repeat: gate.repeat }) });
  const body: PresetsPlan = {
    target: target.runId,
    golden: plan.golden,
    presets: plan.chaos.presets,
    choices: chaosToolChoices(calls).map((c) => ({ name: c.name, callNo: c.callNo })),
    tool: 'callNo' in first ? first.name : null,
    at,
    judge: { ...judge, from: judge.source === 'exit' ? null : JUDGED_FROM[judge.source] },
    // A golden's presets are judged by its entry, and a run whose checks are its golden's by them: only a run's own `--expect` says what failed.
    expect: plan.golden ? null : expectPrefill(ownChecks(target), calls, effectOf),
    gate,
    rule: gateWords(gate),
    runsHere: runsHere(target, plan.golden, job),
    estimate: await estimateOf(price, pricing),
  };
  return answer(body, { tagged: true });
}

/** The command each preset runs here when someone else recorded it: a golden's from a pack the repository doesn't track, or a run's from a pack or the team store. */
function runsHere(target: RunRecord, golden: string | null, job: PresetsPlanJob): PresetsPlan['runsHere'] {
  if (golden) return job.untracked ? { command: quoteArgv(job.untracked), from: "a pack this repository doesn't track", by: null } : null;
  if (!commandIsImported(target)) return null;
  const author = target.meta?.author;
  return { command: quoteArgv(target.command.argv), from: importedCommandSource(target), by: job.shared && typeof author === 'string' && author ? author : null };
}

export const PRESETS_READS: ReadTable<PresetsPlanJob> = {
  'presets-plan': (store, job) => presetsPlan(store, job),
};
