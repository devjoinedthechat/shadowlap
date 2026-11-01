import { CHAOS_PRESETS, presetHits, type ChaosPreset, type ChaosTargets } from '../chaos.js';
import { DEFAULT_BASELINES, type PlantReport, type UntrustedRead } from '../injection.js';
import type { SprtGate } from '../stats.js';
import { counted, liveSums, noEstimate, noPriceWords, type Estimate, type PricedCall } from './estimate.js';
import { amountWords } from './spending.js';

/**
 * What the jobs that play something into a recording bill, each attempt replaying the calls before
 * where it plays in for free and running live from there, writes stubbed. Run injection test…: every
 * payload planted in every untrusted read a model reads, as many attempts each as asked, and as many
 * clean replays of each read as `influenced` compares with. Find cause…: the read made neutral, up to
 * its gate's attempts. Run error-path presets…: each preset at the call it hits, as many attempts as
 * its gate may take. Each prices the recording's calls as pricedCalls did, with the config's prices.
 */

/**
 * The figures Find cause… (`injection --clean`) decides with when none are given: a gate that tells a
 * write gone in 80% of clean attempts or more (caused) from one gone in 20% or less (not caused), each
 * verdict wrong at most 5% of the time at those two rates, at most 10 attempts. Three clean attempts
 * settle a write that always (or never) goes.
 */
export const CLEAN_GATE: Readonly<SprtGate> = Object.freeze({ kind: 'sprt', good: 0.8, bad: 0.2, risk: 0.05, max: 10 });

/** What `shadowlap injection` runs a read, unless told otherwise: one attempt a payload, three clean replays. */
export interface InjectionPlan {
  /** Payloads planted: the templates picked and a payload file's. */
  payloads: number;
  /** Attempts per read and payload (`--repeat`, the golden's `injection.repeat`): 1 by default. */
  repeat?: number;
  /** Clean replays of each read (`--baselines`, the golden's): DEFAULT_BASELINES, 3, by default. */
  baselines?: number;
  /** `--budget` (Stop at $): no attempt starts once it is spent, so the test may end inconclusive. */
  budget?: number | null;
}

/** The attempts a payload Pack with injection gate… gives each read, as its dialog starts and the entry it adds says. */
export const GATE_REPEAT = 3;

/** A test's attempts and clean replays, in a cost line's words: `36 attempts and 9 clean replays`. */
const attemptsWords = (attempts: number, clean: number): string => `${counted(attempts, 'attempt')}${clean ? ` and ${counted(clean, 'clean replay')}` : ''}`;

/**
 * Run injection test…: for each untrusted read a model reads (`reads`, as untrustedReads finds them),
 * each payload's attempts and the clean replays, each live from the model call that reads it
 * (`≈$1.95 · 36 attempts and 9 clean replays · live from each read, writes stubbed`). A run of many
 * reads is priced from sums worked out once. A Stop at $ under that price stops it there (`Stops at
 * $1.00 · … · inconclusive if cut short`), and is what it is held to.
 */
export function injectionEstimate(calls: readonly PricedCall[], reads: ReadonlyArray<Pick<UntrustedRead, 'callNo' | 'readAt'>>, plan: InjectionPlan): Estimate {
  const e = plantedPrice(calls, reads, plan);
  // A budget under the price stops the test there: what it bills is then that much, and what it shows may not decide.
  if (!plan.budget || e.usd === null || plan.budget >= e.usd) return e;
  return { ...e, stops: plan.budget, parts: [...e.parts, 'inconclusive if cut short'] };
}

/**
 * Pack with injection gate…: the run packed as a golden whose gate plants every payload in each read,
 * `GATE_REPEAT` attempts each, in every test session: what one session's test bills (`≈$1.95 every
 * test session, in CI too · 36 attempts and 9 clean replays · live from each read, writes stubbed`).
 */
export function injectionGateEstimate(calls: readonly PricedCall[], reads: ReadonlyArray<Pick<UntrustedRead, 'callNo' | 'readAt'>>, plan: Omit<InjectionPlan, 'budget'>): Estimate {
  const e = plantedPrice(calls, reads, { ...plan, repeat: plan.repeat ?? GATE_REPEAT });
  return e.usd ? { ...e, recurs: 'every test session, in CI too' } : e;
}

/** An injection test's price, every payload's attempts and the clean replays of every read a model reads. */
function plantedPrice(calls: readonly PricedCall[], reads: ReadonlyArray<Pick<UntrustedRead, 'callNo' | 'readAt'>>, plan: InjectionPlan): Estimate {
  const planted = reads.filter((r) => r.readAt !== null);
  if (!planted.length) return { kind: 'injection', usd: 0, ceiling: false, parts: ['no untrusted read a model reads, so nothing is planted'] };
  if (plan.payloads < 1) return noEstimate('injection', 'no payload to plant: pick a template or add a payload file');
  const repeat = plan.repeat ?? 1;
  const baselines = plan.baselines ?? DEFAULT_BASELINES;
  const from = liveSums(calls);
  let usd = 0;
  for (const r of planted) {
    const cost = from(r.readAt!);
    if (cost.usd === null) return noEstimate('injection', noPriceWords(cost));
    usd += (plan.payloads * repeat + baselines) * cost.usd;
  }
  const attempts = planted.length * plan.payloads * repeat;
  const clean = planted.length * baselines;
  return { kind: 'injection', usd, ceiling: false, parts: [attemptsWords(attempts, clean), 'live from each read, writes stubbed'], attempts: attempts + clean };
}

/**
 * Find cause… (`injection <run> --clean <read>`): the read made neutral, replayed until the gate
 * decides whether each write after it goes away, each attempt live from the model call that reads it
 * (its `readAt`, as untrustedReads finds it) to the run's end (`At most ≈$0.62 · up to 10 attempts ·
 * live from the read, writes stubbed`); Free when no model call reads it.
 */
export function causeEstimate(calls: readonly PricedCall[], read: Pick<UntrustedRead, 'callNo' | 'readAt'>, gate: Pick<SprtGate, 'max'> = CLEAN_GATE): Estimate {
  if (read.readAt === null) return { kind: 'cause', usd: 0, ceiling: false, parts: [`no model call comes after #${read.callNo}`] };
  const parts = [`up to ${counted(gate.max, 'attempt')}`, 'live from the read, writes stubbed'];
  const cost = liveSums(calls)(read.readAt);
  if (cost.usd === null) return noEstimate('cause', noPriceWords(cost), parts);
  return {
    kind: 'cause',
    usd: gate.max * cost.usd,
    ceiling: true,
    parts,
    card: { title: 'If the gate took all its attempts', lines: [`An attempt costs ${amountWords(cost.usd)}, live from the read made neutral to the run’s end.`, 'The gate stops once it decides.'] },
    attempts: gate.max,
    each: cost.usd,
  };
}

/**
 * Re-run injection test, and a gate's Re-run test: what the test spent the last time, saying whose
 * attempts it counts (`≈$3.11, as the last test’s 72 attempts and 6 clean replays · live from each
 * read, writes stubbed`). None when that met a model with no price, or spent nothing live: neither
 * says what planting again bills.
 */
export function injectionAgainEstimate(last: Pick<PlantReport, 'totals' | 'baselines' | 'cost'>): Estimate {
  const parts = ['live from each read, writes stubbed'];
  if (last.cost.unknownModels.length) return noEstimate('injection', noPriceWords({ unpriced: last.cost.unknownModels }), parts);
  if (last.cost.spent <= 0) return noEstimate('injection', 'the last test spent nothing live, so what this one bills is unknown', parts);
  const attempts = last.totals.attempts;
  const clean = last.baselines.reduce((n, b) => n + b.runs.length, 0);
  return { kind: 'injection', usd: last.cost.spent, ceiling: false, note: `as the last test’s ${attemptsWords(attempts, clean)}`, parts, last: { usd: last.cost.spent, attempts: attempts + clean } };
}

/**
 * Run error-path presets… (`test <golden> --chaos`, `replay <run> --chaos`): each preset picked
 * replays the recording up to the call it hits (chaosTargets), a tool preset's at the tool call and a
 * provider preset's at the model call that reads it, and runs live from there, at most its gate's
 * attempts each: `chaos.gate`'s max, else the golden's `repeat` (1 for a run), a count that stops at
 * its first failure or once enough have passed. A preset that hits no call runs nothing (`At most
 * ≈$0.054 · 6 attempts · live from each preset’s call, writes stubbed`; under a gate, `up to 40
 * attempts`).
 */
export function presetsEstimate(calls: readonly PricedCall[], targets: ChaosTargets, o: { presets?: readonly ChaosPreset[]; gate?: Pick<SprtGate, 'max'> | null; repeat?: number } = {}): Estimate {
  const each = o.gate ? o.gate.max : (o.repeat ?? 1);
  const from = liveSums(calls);
  let usd = 0;
  let n = 0;
  for (const p of o.presets ?? CHAOS_PRESETS) {
    const hit = presetHits(p) === 'tool' ? targets.tool : targets.model;
    if ('none' in hit) continue;
    const cost = from(hit.callNo);
    if (cost.usd === null) return noEstimate('presets', noPriceWords(cost));
    usd += each * cost.usd;
    n += each;
  }
  if (!n) return { kind: 'presets', usd: 0, ceiling: false, parts: ['no preset applies to this run'] };
  // A gate, or a count that stops at a preset's first failure (decideCount), may end it early: a ceiling either way.
  const e: Estimate = { kind: 'presets', usd, ceiling: true, parts: [`${o.gate ? 'up to ' : ''}${counted(n, 'attempt')}`, 'live from each preset’s call, writes stubbed'], attempts: n };
  if (!o.gate) return e;
  // `chaos.gate` counts an attempt the provider cut short after the model answered against either
  // verdict, but not toward its max, however many it cuts (decideUnavailable, as `shadowlap test` reads it).
  const lines = ['An attempt costs what the recording did from the call its preset hits.', 'A gate stops once it decides.', 'Attempts the provider cuts short come on top: the gate’s max doesn’t count them.'];
  return { ...e, card: { title: 'If every preset’s gate ran to its limit', lines } };
}
