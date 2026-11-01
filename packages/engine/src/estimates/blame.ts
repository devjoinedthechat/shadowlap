import { maxProbes, pinRule, probeGate, type BlameReport } from '../blame.js';
import { isReservedScope } from '../judge-scope.js';
import type { BaselineRule } from '../noninferiority.js';
import { BLAME_DEFAULTS, type SprtGate } from '../stats.js';
import type { CallRecord } from '../types.js';
import { counted, CUT_SHORT_LINE, liveFrom, modelFactor, noEstimate, noPriceWords, timesWords, type Estimate, type PricedCall, type Prices } from './estimate.js';
import { amountWords } from './spending.js';

/**
 * What a blame can bill at most, as `shadowlap blame` bounds it before anything runs (blame.md#cost):
 * up to 1 + ⌈log₂ m⌉ + scan probes for m model calls (maxProbes), each up to its gate's max deepened
 * to its share of the search's risk (probeGate: 20 at 5% becomes 31 to 36 over 5 to 10 probes), and
 * a call they pin checked in pairs, up to twice a probe's attempts (pinRule). Every attempt replays
 * the calls before its probe for free and runs live from there, so one costs at most what the
 * recording did from its first probed call, or about what one of the last blame's did. Run blame,
 * Run blame again, a lower bar (`--gate`) and a stronger model (`--model`) are each priced so. The
 * calls blame probes and the rules that bound its search are here, so the CLI's blame, the bound it
 * says before it starts, a repair's blame and the estimate all count the same.
 */

/** Model calls past the boundary blame probes as well, unless told otherwise (`--scan 2`). */
export const BLAME_SCAN = 2;

/**
 * Whether blame probes a model call made in `callScope`, as `blame --scope` and `repair --scope` read
 * it: never one of Shadowlap's own (its judge's), whose answers are none of the agent's; with a scope,
 * one made in it or in a scope nested in it (`agent/planner` is in `agent`); without one, any other.
 */
export function probedInScope(callScope: unknown, scope: string | null | undefined): boolean {
  if (isReservedScope(callScope)) return false;
  if (!scope) return true;
  return typeof callScope === 'string' && (callScope === scope || callScope.startsWith(`${scope}/`));
}

/** The model calls a blame of a run probes, in call order: each that ended, in its scope (probedInScope). */
export function blameSteps<T extends Pick<CallRecord, 'kind' | 'end' | 'meta'>>(calls: readonly T[], scope: string | null | undefined): T[] {
  return calls.filter((c) => c.kind === 'api' && !!c.end && probedInScope(c.meta.scope, scope));
}

/** A priced recording's model calls blame probes, as blameSteps finds them in the recording. */
export function probedCalls(calls: readonly PricedCall[], scope: string | null | undefined): PricedCall[] {
  return calls.filter((c) => c.ended && probedInScope(c.scope, scope));
}

/** How a search of a run's model calls is bounded, as `shadowlap blame` runs it. */
export interface BlameRules {
  /** The most probes (maxProbes). */
  probes: number;
  /** Each probe's gate, at its share of the search's risk (probeGate); null for a fixed count. */
  gate: SprtGate | null;
  /** The most attempts a probe counts: its gate's max, or the fixed count. */
  limit: number;
  /** The check of a pinned call: its margin, its risk and its most pairs (pinRule). */
  pin: BaselineRule;
}

/** The most a search makes, by kind. */
export interface BlameBound {
  /** The model calls it may probe. */
  steps: number;
  /** The most probes (maxProbes). */
  probes: number;
  /** The most attempts a probe makes: its gate's max at its share of the risk (probeGate), or a fixed count. */
  each: number;
  /** The most attempts the check of a pinned call makes, two a pair; 0 for a run of one model call, where there is no next call to check it against. */
  pin: number;
  /** Every attempt, probes and check together. */
  attempts: number;
}

/** How a blame decides its probes: its gate (blame's own by default), or a fixed count (`--attempts`), and its scan. */
export interface BlameRule {
  gate?: SprtGate | null;
  attempts?: number | null;
  scan?: number;
}

/** The rules a search of `steps` model calls runs by: its probes, each probe's gate and attempts, and the check of a pinned call. */
export function blameRules(steps: number, rule: BlameRule = {}): BlameRules {
  const probes = maxProbes(steps, rule.scan ?? BLAME_SCAN);
  const gate = rule.attempts ? null : probeGate(rule.gate ?? { kind: 'sprt', ...BLAME_DEFAULTS }, probes);
  return { probes, gate, limit: gate ? gate.max : rule.attempts!, pin: pinRule(gate, probes) };
}

/** The most probes and attempts a search of `steps` model calls makes, as the CLI states it before it starts. */
export function blameBound(steps: number, rule: BlameRule = {}): BlameBound {
  const r = blameRules(steps, rule);
  // A pinned call is checked against the next, so a run of one model call has no check.
  const pin = steps > 1 ? 2 * r.pin.max : 0;
  return { steps, probes: r.probes, each: r.limit, pin, attempts: r.probes * r.limit + pin };
}

export interface BlameEstimateOptions extends BlameRule {
  /** `--scope`: only the model calls made in it (or one nested in it) are probed. */
  scope?: string | null;
  /** `--model`: each probe re-asks that model, at its price. */
  model?: string | null;
  /** What writes do after the fork: stubbed, blame's default, or blocked. */
  writes?: 'stub' | 'block';
  prices?: Prices;
  /**
   * The last blame of the run. With attempts to its name that spent something, all of it priced, an
   * attempt is priced about as one of its did (Run blame again), unless `fresh` says the search
   * starts over (under another check); it is what the last such job cost either way. One that spent
   * nothing says nothing of what an attempt costs: the recording prices it then. One that met a model
   * with no price leaves no estimate, as what it spent leaves those calls out.
   */
  last?: Pick<BlameReport, 'attempts' | 'spent' | 'judge' | 'unknownModels'> | null;
  fresh?: boolean;
}

/** What the last blame spent, its judge's calls with it. */
const spentOf = (last: Pick<BlameReport, 'spent' | 'judge'>): number => last.spent + (last.judge?.spent ?? 0);

/** What one attempt is priced at, and the price card's line that says so; or why there is no price. */
function attemptPrice(calls: readonly PricedCall[], first: number, o: BlameEstimateOptions): { usd: number; line: string } | { none: string } {
  if (!o.fresh && o.last?.unknownModels.length) return { none: noPriceWords({ unpriced: o.last.unknownModels }) };
  const last = !o.fresh && o.last && o.last.attempts > 0 && spentOf(o.last) > 0 ? o.last : null;
  if (last) {
    const per = spentOf(last) / last.attempts;
    const theirs = `the last blame’s ${counted(last.attempts, 'attempt')}`;
    if (!o.model) return { usd: per, line: `An attempt costs about what ${theirs} did, ${amountWords(per)} each.` };
    const k = modelFactor(calls, first, o.model, o.prices);
    if (k !== null) {
      const times = timesWords(k);
      return { usd: per * k, line: `An attempt costs about ${times ? `${times} ` : ''}what ${theirs} did, at ${o.model}’s prices: ${amountWords(per * k)} each.` };
    }
  }
  const cost = liveFrom(calls, first, { model: o.model ?? null, prices: o.prices });
  if (cost.usd === null) return { none: noPriceWords(cost) };
  return { usd: cost.usd, line: `An attempt costs at most what the recording did${o.model ? ` at ${o.model}’s prices` : ''}, ${amountWords(cost.usd)}.` };
}

/**
 * Run blame's estimate, from the run's priced model calls: the search's ceiling, every probe it may
 * make at its gate's most attempts and the check of a call they pin (`At most ≈$10.88 · up to 7 probes
 * of 33 attempts and a check of the call found · live from each probe, writes stubbed`). None for a
 * run with no model call to probe, which blame refuses.
 */
export function blameEstimate(calls: readonly PricedCall[], o: BlameEstimateOptions = {}): Estimate {
  const probed = probedCalls(calls, o.scope);
  if (!probed.length) return noEstimate('blame', `the run made no model calls${o.scope ? ` in scope ${o.scope}` : ''}, so blame has nothing to probe`);
  const bound = blameBound(probed.length, o);
  const parts = [`up to ${counted(bound.probes, 'probe')} of ${counted(bound.each, 'attempt')}${bound.pin ? ' and a check of the call found' : ''}`, `live from each probe, writes ${o.writes === 'block' ? 'blocked' : 'stubbed'}`];
  const price = attemptPrice(calls, probed[0]!.callNo, o);
  if ('none' in price) return noEstimate('blame', price.none, parts);
  return {
    kind: 'blame',
    usd: bound.attempts * price.usd,
    ceiling: true,
    parts,
    card: { title: bound.pin ? 'If every probe and the check ran to their limit' : 'If every probe ran to its limit', lines: [price.line, 'A probe stops once it settles, and a later one costs less.', CUT_SHORT_LINE] },
    attempts: bound.attempts,
    each: price.usd,
    ...(o.last?.attempts && !o.last.unknownModels.length ? { last: { usd: spentOf(o.last), attempts: o.last.attempts } } : {}),
  };
}
