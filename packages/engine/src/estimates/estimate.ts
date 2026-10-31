import { isJudgeCall, isReservedScope } from '../judge-scope.js';
import { estimateCost, type Price } from '../prices.js';
import type { ModelResolver } from '../report.js';
import type { CallRecord, Usage } from '../types.js';

/**
 * What a billed job costs before it starts (A15): the ground every estimate stands on, and the shape
 * each one comes in. A job replays the calls before its first live one from the recording, which
 * costs nothing; from there each model call costs what it did when it was recorded, at its model's
 * price (shadowlap.config.json's `prices` over the engine's table), or at another model's for a job
 * that asks another one. A job that makes attempts until a gate decides is priced at its ceiling, as
 * the CLI bounds its attempts; one with no bound has no estimate, and always asks first.
 */

/** The billed jobs an estimate is worked out for, by what the job does. */
export type EstimateKind = 'record' | 'fork' | 'repeat' | 'plant' | 'presets' | 'injection' | 'cause' | 'blame' | 'verify' | 'repair' | 'tests' | 'more' | 'bisect' | 'update' | 'preview' | 'migrate';

/**
 * A billed job's cost, as its button's card, its ask, Spending and its drawer all say it: a job keeps
 * the estimate it started with, so the four agree.
 */
export interface Estimate {
  kind: EstimateKind;
  /**
   * USD: what the job is expected to bill, or with `ceiling` the most it can, every attempt it may
   * make run to its limit; 0 when nothing it runs reaches a provider. Null when it has no estimate
   * (`none` says why): it then always asks first.
   */
  usd: number | null;
  /** `usd` is the most it can bill: "At most ≈$10.88". */
  ceiling: boolean;
  /** Words that follow the price itself: `twice as recorded`. */
  note?: string;
  /** The cost line's parts after the price, in the ask's words: `up to 7 probes of 33 attempts and a check of the call found`. */
  parts: string[];
  /** Why there is no estimate, when `usd` is null. */
  none?: string;
  /** It asks first whatever Spending says, for what it does rather than what it bills, and why: `it replaces goldens`. */
  always?: string;
  /** The price's card: what the price assumes, and what an attempt costs on what it is priced. */
  card?: { title: string; lines: string[] };
  /** A ceiling's attempts in all. */
  attempts?: number;
  /** What one attempt is priced at. */
  each?: number;
  /** What makes up the price, for its card: `Blame`, `Repairer`, `A verify`. */
  items?: Array<{ what: string; usd: number }>;
  /** What a ceiling is expected to come to: the attempts its gates take on average, and their cost. */
  expected?: { usd: number; attempts: number };
  /** What the last such job cost, and in how many attempts, for the price's card. */
  last?: { usd: number; attempts: number | null };
}

/** An estimate with no price, and why, in words that end its cost line: the job always asks first. */
export function noEstimate(kind: EstimateKind, none: string, parts: string[] = []): Estimate {
  return { kind, usd: null, ceiling: false, parts, none };
}

/** Record run: the agent runs live, its own model calls billed, with nothing recorded yet to price them from. */
export function recordEstimate(): Estimate {
  return noEstimate('record', 'no estimate until it has run once', ['the agent’s own model calls']);
}

/** A count with its noun, as the cost lines say it: `1 attempt`, `3 attempts`. */
export const counted = (n: number, noun: string): string => (n === 1 ? `1 ${noun}` : `${n} ${noun}s`);

/** The config's `prices`, over the engine's table; none for the table alone. */
export type Prices = Record<string, Price> | undefined;

/** What pricing a recording's calls reads: the config's `prices`, and the model of a call recorded before calls kept theirs. */
export interface PriceOptions {
  prices?: Prices;
  modelOf?: ModelResolver | undefined;
}

/** A recorded model call, priced as it would cost asked live. */
export interface PricedCall {
  callNo: number;
  model: string | null;
  /** The provider it was made through, as the sidecar kept it: what a model's retirement is looked up by. */
  provider: string | null;
  scope: string | null;
  /** A call of Shadowlap's judge, which no `--model` switches. */
  judge: boolean;
  /** It ended, so blame can probe it. */
  ended: boolean;
  usage: Usage | null;
  /**
   * USD at its own model's price; 0 for a call no answer was kept of (it failed, or Shadowlap answered
   * it); null when its model has no price, or it ended with an answer but kept no token counts.
   */
  usd: number | null;
}

const scopeOf = (c: Pick<CallRecord, 'meta'>): string | null => (typeof c.meta.scope === 'string' && c.meta.scope ? c.meta.scope : null);

/** An answer whose tokens were counted: the provider's, not one Shadowlap gave itself (`--fail-at`, offline, a refusal). */
function answered(c: CallRecord): boolean {
  const end = c.end;
  return !!end && end.outcome === 'ok' && !end.meta.injected && !end.meta.offline && !end.meta.refused;
}

/**
 * A recording's model calls in call order, each priced as asked live, whatever its origin: a call a
 * replay served, or one an imported run's process made elsewhere, costs as much asked again.
 */
export function pricedCalls(calls: readonly CallRecord[], o: PriceOptions = {}): PricedCall[] {
  return calls
    .filter((c) => c.kind === 'api')
    .sort((a, b) => a.callNo - b.callNo)
    .map((c) => {
      const usage = c.end?.meta.usage ?? null;
      const model = c.end?.meta.model ?? c.meta.model ?? o.modelOf?.(c) ?? null;
      const usd = usage ? estimateCost(model, usage, o.prices) : answered(c) ? null : 0;
      return { callNo: c.callNo, model, provider: c.meta.provider ?? c.end?.meta.provider ?? null, scope: scopeOf(c), judge: isJudgeCall(c), ended: !!c.end, usage, usd };
    });
}

/** What a run's model calls from one on cost asked live. */
export interface LiveCost {
  /** USD; null when a call among them has no price (`unpriced`) or kept no token counts (`uncounted`). */
  usd: number | null;
  /** The first model call counted, by call number; null when none comes at or after where it starts. */
  first: number | null;
  /** The model calls counted. */
  calls: number;
  /** Models among them with no price. */
  unpriced: string[];
  /** Calls among them, by number, that ended with an answer but kept no token counts. */
  uncounted: number[];
}

/**
 * What a run's model calls from call `from` on cost asked live; with `model`, the agent's calls asked
 * of that model instead, their own tokens at its price (a judge's calls keep theirs).
 */
export function liveFrom(calls: readonly PricedCall[], from: number, o: { model?: string | null | undefined; prices?: Prices } = {}): LiveCost {
  const out: LiveCost = { usd: 0, first: null, calls: 0, unpriced: [], uncounted: [] };
  let usd = 0;
  for (const c of calls) {
    if (c.callNo < from) continue;
    out.first ??= c.callNo;
    out.calls++;
    const switched = o.model && !c.judge ? o.model : null;
    const cost = switched && c.usage ? estimateCost(switched, c.usage, o.prices) : c.usd;
    if (cost !== null) {
      usd += cost;
      continue;
    }
    if (!c.usage) {
      out.uncounted.push(c.callNo);
      continue;
    }
    const model = switched ?? c.model ?? `the model of #${c.callNo}`;
    if (!out.unpriced.includes(model)) out.unpriced.push(model);
  }
  out.usd = out.unpriced.length || out.uncounted.length ? null : usd;
  return out;
}

/** What a run's live model calls cost, the judge's among them: what an attempt that made them spent. */
export function spentLive(calls: readonly CallRecord[], o: PriceOptions = {}): LiveCost {
  const live = new Set(calls.filter((c) => c.kind === 'api' && c.origin === 'live').map((c) => c.callNo));
  return liveFrom(
    pricedCalls(calls, o).filter((c) => live.has(c.callNo)),
    0,
    { prices: o.prices },
  );
}

/**
 * How many times what the agent's calls from `from` on cost asked of `model` is what they cost as
 * recorded: about 1.7 for a run that reads the cache, whose reads cost the same at both prices. Null
 * when either side has no price, or the calls cost nothing as recorded.
 */
export function modelFactor(calls: readonly PricedCall[], from: number, model: string, prices?: Prices): number | null {
  const agent = calls.filter((c) => !c.judge);
  const was = liveFrom(agent, from, { prices }).usd;
  const now = liveFrom(agent, from, { model, prices }).usd;
  return was && now !== null ? now / was : null;
}

/** Why a job priced on calls with no price, or no token counts, has no estimate: it then always asks first. */
export function noPriceWords(cost: Pick<LiveCost, 'unpriced' | 'uncounted'>): string {
  const words: string[] = [];
  if (cost.unpriced.length) words.push(`no price for ${cost.unpriced.join(', ')}: add ${cost.unpriced.length === 1 ? 'it' : 'them'} under "prices" in shadowlap.config.json`);
  if (cost.uncounted.length) {
    const n = cost.uncounted.map((c) => `#${c}`);
    words.push(`${n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)!}` : n[0]!} kept no token counts`);
  }
  return words.join('; ');
}

/** A factor in words, as an ask says what calls cost asked of another model: `twice`, `half`, `1.7 times`; null for about the same. */
export function timesWords(k: number): string | null {
  const r = Math.round(k * 10) / 10;
  if (r === 1 || !Number.isFinite(r)) return null;
  return r === 2 ? 'twice' : r === 0.5 ? 'half' : `${r} times`;
}

/**
 * Whether a call was made in `scope` or one nested in it (`agent/planner` is in `agent`), as
 * `blame --scope` and `repair --scope` read it; every call when no scope is given.
 */
export function scopeHolds(scope: string | null | undefined, callScope: string | null): boolean {
  return !scope || callScope === scope || !!callScope?.startsWith(`${scope}/`);
}

/** The agent's model calls `blame` probes: ended, none of Shadowlap's own, in `scope` when it names one. */
export function probedCalls(calls: readonly PricedCall[], scope: string | null | undefined): PricedCall[] {
  return calls.filter((c) => c.ended && !c.judge && !isReservedScope(c.scope) && scopeHolds(scope, c.scope));
}
