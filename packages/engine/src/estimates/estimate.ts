import { isJudgeCall } from '../judge-scope.js';
import { estimateCost, type Price } from '../prices.js';
import type { ModelResolver } from '../report.js';
import type { CallRecord, Usage } from '../types.js';
import { pluralS } from '../words.js';

/**
 * What a billed job costs before it starts (A15): the ground every estimate stands on, and the shape
 * each one comes in. A job replays the calls before its first live one from the recording, which
 * costs nothing; from there each model call costs what it did when it was recorded, at its model's
 * price (shadowlap.config.json's `prices` over the engine's table), or at another model's for a job
 * that asks another one. A job that makes attempts until a gate decides is priced at its ceiling, as
 * the CLI bounds its attempts; one with no bound has no estimate, and always asks first. So does one
 * whose price would rest on what nobody saw billed: a call recorded with no answer, a model with no
 * price, or a history that spent nothing live.
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
  /**
   * The price is one unit's, not the job's, said right after it: `an attempt` (`≈$0.012 an
   * attempt`, Score model…'s card). The job's own bill is its dialog's, so it always asks first.
   */
  per?: string;
  /**
   * What the ask says right after the amount, for a price billed again: `every test session, in CI
   * too` (Pack with injection gate…). The card and the drawer say the amount alone.
   */
  recurs?: string;
  /**
   * USD the job stops at (`--budget`), under what it would bill: its price reads `Stops at $2.00`, and
   * what Spending and its drawer hold it to is that much. No ceiling: the attempts already running
   * when it is spent still finish.
   */
  stops?: number;
  /**
   * The cost line's parts after the price, in the ask's words: `up to 7 probes of 33 attempts and a
   * check of the call found`. A job with no estimate ends it on why (`no estimate until it has run
   * once`), but Record run, whose line says who bills what and no more.
   */
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

/**
 * What a page's own figure says more attempts are expected to take (a fix's Verify step, a golden's
 * gate on Tests): the attempts they add on average, and what that costs at the attempts' average so
 * far, null when nothing was spent or kept. An estimate takes it as it comes, so the page and the ask
 * say the same.
 */
export interface ExpectedFigure {
  expected: number;
  cost: number | null;
}

/**
 * The price's card line for a ceiling a gate decides: an attempt the provider cut short after the
 * model answered isn't counted toward the gate's max, and up to twice the max may run in all (cli
 * verify, blame and test), so those come on top of what the ceiling counts.
 */
export const CUT_SHORT_LINE = 'Attempts the provider cuts short come on top, up to as many again.';

/** An estimate with no price, its cost line ending on why: the job always asks first. */
export function noEstimate(kind: EstimateKind, none: string, parts: string[] = []): Estimate {
  return { kind, usd: null, ceiling: false, parts: [...parts, none], none };
}

/**
 * Record run: the agent runs live, its own model calls billed, with nothing recorded yet to price them
 * from. Its line says who bills what and no more: `Billed by your provider · the agent’s own model calls`.
 */
export function recordEstimate(): Estimate {
  return { kind: 'record', usd: null, ceiling: false, parts: ['the agent’s own model calls'], none: 'no estimate until it has run once' };
}

/**
 * A count with its noun, as the cost lines say it: `1 attempt`, `3 attempts`, `1,224 requests`. The
 * noun takes its s as plural's does (words.ts); the count keeps its thousands apart, as the design's do.
 */
export const counted = (n: number, noun: string): string => `${n.toLocaleString('en-US')} ${noun}${pluralS(n)}`;

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
  /** Its request was kept, so a preview can send it again. */
  request: boolean;
  /** Its provider answered it, and the answer was kept, which a preview compares with. */
  answered: boolean;
  /** Shadowlap answered it itself (`--fail-at`, offline, a refusal), so nothing went upstream. */
  own: boolean;
  usage: Usage | null;
  /**
   * USD asked live, at its own model's price. Null when that is unknown: its model has no price, it
   * kept no token counts, or it got no answer when recorded (it failed, never ended, or Shadowlap
   * answered it), so what asking it costs was never seen.
   */
  usd: number | null;
}

const scopeOf = (c: Pick<CallRecord, 'meta'>): string | null => (typeof c.meta.scope === 'string' && c.meta.scope ? c.meta.scope : null);

/**
 * A recording's model calls in call order, each priced as asked live, whatever its origin: a call a
 * replay served, or one an imported run's process made elsewhere, costs as much asked again.
 */
export function pricedCalls(calls: readonly CallRecord[], o: PriceOptions = {}): PricedCall[] {
  return calls
    .filter((c) => c.kind === 'api')
    .sort((a, b) => a.callNo - b.callNo)
    .map((c) => {
      const end = c.end;
      const usage = end?.meta.usage ?? null;
      const model = end?.meta.model ?? c.meta.model ?? o.modelOf?.(c) ?? null;
      const own = !!(end?.meta.injected || end?.meta.offline || end?.meta.refused);
      return { callNo: c.callNo, model, provider: c.meta.provider ?? end?.meta.provider ?? null, scope: scopeOf(c), judge: isJudgeCall(c), ended: !!end, request: !!c.requestRef, answered: end?.outcome === 'ok' && !own, own, usage, usd: usage ? estimateCost(model, usage, o.prices) : null };
    });
}

/** What a run's model calls from one on cost asked live. */
export interface LiveCost {
  /** USD; null when a call among them has no price (`unpriced`), kept no token counts (`uncounted`) or got no answer (`unanswered`). */
  usd: number | null;
  /** The first model call counted, by call number; null when none comes at or after where it starts. */
  first: number | null;
  /** The model calls counted. */
  calls: number;
  /** Models among them with no price. */
  unpriced: string[];
  /** Calls among them, by number, that ended with an answer but kept no token counts. */
  uncounted: number[];
  /** Calls among them, by number, that got no answer when recorded: they failed, never ended, or Shadowlap answered them. */
  unanswered: number[];
}

/**
 * What a run's model calls from call `from` on cost asked live; with `model`, the agent's calls asked
 * of that model instead, their own tokens at its price (a judge's calls keep theirs).
 */
export function liveFrom(calls: readonly PricedCall[], from: number, o: { model?: string | null | undefined; prices?: Prices } = {}): LiveCost {
  const out: LiveCost = { usd: 0, first: null, calls: 0, unpriced: [], uncounted: [], unanswered: [] };
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
      (c.answered ? out.uncounted : out.unanswered).push(c.callNo);
      continue;
    }
    const model = switched ?? c.model ?? `the model of #${c.callNo}`;
    if (!out.unpriced.includes(model)) out.unpriced.push(model);
  }
  out.usd = out.unpriced.length || out.uncounted.length || out.unanswered.length ? null : usd;
  return out;
}

/**
 * What liveFrom says from any call on, worked out once for a job priced from many places in one
 * recording (an injection test's reads, the presets' calls): each answer is then a search, not a
 * pass over every call. Each call at its own model's price.
 */
export function liveSums(calls: readonly PricedCall[]): (from: number) => LiveCost {
  const sorted = [...calls].sort((a, b) => a.callNo - b.callNo);
  const n = sorted.length;
  // From index i on: what the calls cost, and the first among them with no price (n for none).
  const sum: number[] = new Array<number>(n + 1).fill(0);
  const unknownAt: number[] = new Array<number>(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) {
    const usd = sorted[i]!.usd;
    sum[i] = sum[i + 1]! + (usd ?? 0);
    unknownAt[i] = usd === null ? i : unknownAt[i + 1]!;
  }
  return (from) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid]!.callNo < from) lo = mid + 1;
      else hi = mid;
    }
    // A call with no price among them: liveFrom names why, once, as the job then has no estimate.
    if (unknownAt[lo]! < n) return liveFrom(sorted.slice(lo), from);
    return { usd: sum[lo]!, first: lo < n ? sorted[lo]!.callNo : null, calls: n - lo, unpriced: [], uncounted: [], unanswered: [] };
  };
}

/**
 * What a run's live model calls cost, the judge's among them: what an attempt that made them spent.
 * One Shadowlap answered itself cost nothing, and costs nothing when the same flags make it again.
 */
export function spentLive(calls: readonly CallRecord[], o: PriceOptions = {}): LiveCost {
  const live = new Set(calls.filter((c) => c.kind === 'api' && c.origin === 'live').map((c) => c.callNo));
  return liveFrom(
    pricedCalls(calls, o)
      .filter((c) => live.has(c.callNo))
      .map((c) => (c.own ? { ...c, usd: 0 } : c)),
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

/** Things a reason names, the first three and how many more: `#1, #2, #3 and 1,997 more`. */
function few(items: readonly string[]): string {
  if (items.length > 3) return `${items.slice(0, 3).join(', ')} and ${(items.length - 3).toLocaleString('en-US')} more`;
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}` : (items[0] ?? '');
}

/** Why calls on which a job is priced leave it with no estimate, so it always asks first: models with no price, calls with no token counts, calls with no answer. */
export function noPriceWords(cost: { unpriced?: readonly string[]; uncounted?: readonly number[]; unanswered?: readonly number[] }): string {
  const words: string[] = [];
  const { unpriced = [], uncounted = [], unanswered = [] } = cost;
  if (unpriced.length) words.push(`no price for ${few(unpriced)}: add ${unpriced.length === 1 ? 'it' : 'them'} under "prices" in shadowlap.config.json`);
  if (uncounted.length) words.push(`${few(uncounted.map((c) => `#${c}`))} kept no token counts`);
  if (unanswered.length) words.push(`${few(unanswered.map((c) => `#${c}`))} got no answer when recorded, so what ${unanswered.length === 1 ? 'it costs' : 'they cost'} is unknown`);
  return words.join('; ');
}

/**
 * A factor in words, as an ask says what calls cost asked of another model: `twice`, `half`, `1.7
 * times`, under a tenth to two figures (`0.048 times`); null for about the same, or none to give.
 */
export function timesWords(k: number): string | null {
  if (!Number.isFinite(k) || k <= 0) return null;
  const small = k < 0.1;
  const r = small ? Number(k.toPrecision(2)) : Math.round(k * 10) / 10;
  if (r === 1) return null;
  if (r === 2) return 'twice';
  if (r === 0.5) return 'half';
  return `${r.toLocaleString('en-US', small ? { maximumSignificantDigits: 2 } : { maximumFractionDigits: 1 })} times`;
}
