import { forkArgs } from '../run-actions.js';
import type { CallRecord, RunRecord } from '../types.js';
import { counted, liveFrom, modelFactor, noEstimate, noPriceWords, spentLive, timesWords, type Estimate, type PriceOptions, type PricedCall, type Prices } from './estimate.js';

/**
 * What a fork from the run page bills: the calls before its change replay from the recording for
 * free, and from the first model call that sees the change the agent runs live, writes fenced, so
 * what its model calls cost when they were recorded is what it bills (under another model, at that
 * model's price). The fork menu's whole-run items: Repeat 5 times, each attempt the fork again; and
 * Plant instruction…, three attempts live from the model call that reads the planted text.
 */

/** The attempts the fork menu's Repeat asks for unless told otherwise (run-actions.ts, `--repeat 5`). */
export const REPEAT_TIMES = 5;

/** The attempts the fork menu's Plant instruction… runs (run-actions.ts, `--inject-result … --repeat 3`). */
export const PLANT_REPEAT = 3;

/** A change the fork menu makes at one call. */
export interface ForkChange {
  /** The call it changes, by number. */
  at: number;
  /**
   * Shadowlap answers the call itself (`--fail-at` at a model call), so nothing goes upstream there.
   * A change at a tool call (an override, a tool error, a planted instruction, forcing it live) is
   * always seen first by the model call after it.
   */
  answered?: boolean;
  /** `--model`: the agent's calls from there on asked of this model. */
  model?: string | null;
  /** It forces a write live (`--live-tool` on a write): the writes after it are still fenced. */
  write?: boolean;
  prices?: Prices;
}

/** The first call that runs live after a change at `at`: the call itself when it is a model call asked again, else the next. */
function liveAt(calls: readonly PricedCall[], change: Pick<ForkChange, 'at' | 'answered'>): number {
  return !change.answered && calls.some((c) => c.callNo === change.at) ? change.at : change.at + 1;
}

/**
 * A fork's estimate, from the recording's priced model calls: what they cost from the first one that
 * sees the change (`≈$0.027 · live from #17, writes fenced`), under another model at its price with
 * how many times the recording's that is; Free when no model call comes after the change, or when
 * Shadowlap answers the only one there is.
 */
export function forkEstimate(calls: readonly PricedCall[], change: ForkChange): Estimate {
  const from = liveAt(calls, change);
  const cost = liveFrom(calls, from, { model: change.model ?? null, prices: change.prices });
  if (cost.usd === null) return noEstimate('fork', noPriceWords(cost));
  if (cost.usd === 0 || cost.first === null) {
    const why = change.answered ? `nothing upstream at #${change.at}` : cost.first === null ? `no model call comes after #${change.at}` : `live from #${cost.first}, nothing billed`;
    return { kind: 'fork', usd: 0, ceiling: false, parts: [why] };
  }
  const k = change.model ? modelFactor(calls, from, change.model, change.prices) : null;
  const times = k === null ? null : timesWords(k);
  return {
    kind: 'fork',
    usd: cost.usd,
    ceiling: false,
    ...(times ? { note: `${times} as recorded` } : {}),
    parts: [`live from #${cost.first}, ${change.write ? 'other writes' : 'writes'} fenced`],
  };
}

/**
 * Repeat: the same replay several times. A replay Shadowlap made is made again from its parent with
 * the flags that made it (forkArgs), so each attempt forks where it did and runs live from there,
 * costing what the fork's own live calls did (`≈$0.135 · 5 attempts, live from #17, writes fenced`).
 * Anything else is replayed as it is, from its recording, which costs nothing.
 */
export function repeatEstimate(run: RunRecord, calls: readonly CallRecord[], times: number = REPEAT_TIMES, o: PriceOptions = {}): Estimate {
  const live = forkArgs(run) === null ? null : spentLive(calls, o);
  if (!live?.calls) return { kind: 'repeat', usd: 0, ceiling: false, parts: [`${counted(times, 'attempt')}, each replayed from the recording`] };
  if (live.usd === null) return noEstimate('repeat', noPriceWords(live));
  const forkAt = run.divergence?.callNo ?? live.first!;
  return { kind: 'repeat', usd: times * live.usd, ceiling: false, attempts: times, each: live.usd, parts: [`${counted(times, 'attempt')}, live from #${forkAt}, writes fenced`] };
}

/**
 * Plant instruction…: the planted text added to what read tool call `at` returned, then the run
 * replayed from there several times (`--repeat 3`), each attempt live from the model call that reads
 * it (`≈$0.081 · 3 attempts, live from #10, writes fenced`); Free when no model call reads it.
 */
export function plantEstimate(calls: readonly PricedCall[], at: number, repeat: number = PLANT_REPEAT, prices?: Prices): Estimate {
  const cost = liveFrom(calls, at + 1, { prices });
  if (cost.usd === null) return noEstimate('plant', noPriceWords(cost));
  if (cost.first === null) return { kind: 'plant', usd: 0, ceiling: false, parts: [`no model call comes after #${at}`] };
  return { kind: 'plant', usd: repeat * cost.usd, ceiling: false, attempts: repeat, each: cost.usd, parts: [`${counted(repeat, 'attempt')}, live from #${cost.first}, writes fenced`] };
}
