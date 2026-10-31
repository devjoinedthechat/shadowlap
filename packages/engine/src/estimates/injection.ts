import { CHAOS_PRESETS, presetHits, type ChaosPreset, type ChaosTargets } from '../chaos.js';
import { DEFAULT_BASELINES, type UntrustedRead } from '../injection.js';
import type { SprtGate } from '../stats.js';
import { counted, liveFrom, noEstimate, noPriceWords, type Estimate, type PricedCall, type Prices } from './estimate.js';
import { amountWords } from './spending.js';

/**
 * What the jobs that play something into a recording bill, each attempt replaying the calls before
 * where it plays in for free and running live from there, writes stubbed. Run injection test…: every
 * payload planted in every untrusted read a model reads, as many attempts each as asked, and as many
 * clean replays of each read as `influenced` compares with. Find cause…: the read made neutral, up to
 * its gate's attempts. Run error-path presets…: each preset at the call it hits, as many attempts as
 * its gate may take.
 */

/** The gate Find cause… (`injection --clean`) decides by unless told otherwise: cli/src/injection.ts CLEAN_GATE, which a CLI test holds this to. */
export const CLEAN_GATE: Readonly<SprtGate> = Object.freeze({ kind: 'sprt', good: 0.8, bad: 0.2, risk: 0.05, max: 10 });

/** What `shadowlap injection` runs a read, unless told otherwise: one attempt a payload, three clean replays. */
export interface InjectionPlan {
  /** Payloads planted: the templates picked and a payload file's. */
  payloads: number;
  /** Attempts per read and payload (`--repeat`, the golden's `injection.repeat`): 1 by default. */
  repeat?: number;
  /** Clean replays of each read (`--baselines`, the golden's): DEFAULT_BASELINES, 3, by default. */
  baselines?: number;
  prices?: Prices;
}

/**
 * Run injection test…: for each untrusted read a model reads (`reads`, as untrustedReads finds them),
 * each payload's attempts and the clean replays, each live from the model call that reads it
 * (`≈$1.95 · 36 attempts and 9 clean replays · live from each read, writes stubbed`).
 */
export function injectionEstimate(calls: readonly PricedCall[], reads: ReadonlyArray<Pick<UntrustedRead, 'callNo' | 'readAt'>>, plan: InjectionPlan): Estimate {
  const planted = reads.filter((r) => r.readAt !== null);
  if (!planted.length) return { kind: 'injection', usd: 0, ceiling: false, parts: ['no untrusted read a model reads, so nothing is planted'] };
  if (plan.payloads < 1) return noEstimate('injection', 'no payload to plant: pick a template or add a payload file');
  const repeat = plan.repeat ?? 1;
  const baselines = plan.baselines ?? DEFAULT_BASELINES;
  let usd = 0;
  for (const r of planted) {
    const cost = liveFrom(calls, r.readAt!, { prices: plan.prices });
    if (cost.usd === null) return noEstimate('injection', noPriceWords(cost));
    usd += (plan.payloads * repeat + baselines) * cost.usd;
  }
  const attempts = planted.length * plan.payloads * repeat;
  const clean = planted.length * baselines;
  return { kind: 'injection', usd, ceiling: false, parts: [`${counted(attempts, 'attempt')}${clean ? ` and ${counted(clean, 'clean replay')}` : ''}`, 'live from each read, writes stubbed'], attempts: attempts + clean };
}

/**
 * Find cause… (`injection <run> --clean <read>`): the read made neutral, replayed until the gate
 * decides whether each write after it goes away, each attempt live from the model call after the read
 * to the run's end (`At most ≈$0.62 · up to 10 attempts · live from the read, writes stubbed`).
 */
export function causeEstimate(calls: readonly PricedCall[], read: number, gate: Pick<SprtGate, 'max'> = CLEAN_GATE, prices?: Prices): Estimate {
  const cost = liveFrom(calls, read + 1, { prices });
  if (cost.usd === null) return noEstimate('cause', noPriceWords(cost));
  if (cost.first === null) return { kind: 'cause', usd: 0, ceiling: false, parts: [`no model call comes after #${read}`] };
  return {
    kind: 'cause',
    usd: gate.max * cost.usd,
    ceiling: true,
    parts: [`up to ${counted(gate.max, 'attempt')}`, 'live from the read, writes stubbed'],
    card: { title: 'If the gate took all its attempts', lines: [`An attempt costs ${amountWords(cost.usd)}, live from the read made neutral to the run’s end.`, 'The gate stops once it decides.'] },
    attempts: gate.max,
    each: cost.usd,
  };
}

/**
 * Re-run injection test, and a gate's Re-run test: what the test spent the last time
 * (`≈$0.41, as the last test’s · live from each read, writes stubbed`).
 */
export function injectionAgainEstimate(spent: number): Estimate {
  return { kind: 'injection', usd: spent, ceiling: false, note: 'as the last test’s', parts: ['live from each read, writes stubbed'], last: { usd: spent, attempts: null } };
}

/**
 * Run error-path presets… (`test <golden> --chaos`, `replay <run> --chaos`): each preset picked
 * replays the recording up to the call it hits (chaosTargets), a tool preset's at the tool call and a
 * provider preset's at the model call that reads it, and runs live from there, up to its gate's
 * attempts each: `chaos.gate`'s max, else the golden's `repeat` (1 for a run). A preset that hits no
 * call runs nothing (`At most ≈$0.86 · up to 6 attempts · live from each preset’s call, writes stubbed`).
 */
export function presetsEstimate(calls: readonly PricedCall[], targets: ChaosTargets, o: { presets?: readonly ChaosPreset[]; gate?: Pick<SprtGate, 'max'> | null; repeat?: number; prices?: Prices } = {}): Estimate {
  const each = o.gate ? o.gate.max : (o.repeat ?? 1);
  let usd = 0;
  let n = 0;
  for (const p of o.presets ?? CHAOS_PRESETS) {
    const hit = presetHits(p) === 'tool' ? targets.tool : targets.model;
    if ('none' in hit) continue;
    const cost = liveFrom(calls, hit.callNo, { prices: o.prices });
    if (cost.usd === null) return noEstimate('presets', noPriceWords(cost));
    usd += each * cost.usd;
    n += each;
  }
  if (!n) return { kind: 'presets', usd: 0, ceiling: false, parts: ['no preset applies to this run'] };
  return { kind: 'presets', usd, ceiling: true, parts: [`${o.gate ? 'up to ' : ''}${counted(n, 'attempt')}`, 'live from each preset’s call, writes stubbed'], attempts: n };
}
