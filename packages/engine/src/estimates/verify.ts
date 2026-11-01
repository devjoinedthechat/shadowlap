import { KEPT_DEFAULTS } from '../noninferiority.js';
import { SPRT_DEFAULTS, type SprtGate } from '../stats.js';
import type { VerifyAttempt, VerifyReport, VerifyRole } from '../verify.js';
import { counted, CUT_SHORT_LINE, noEstimate, noPriceWords, type Estimate, type ExpectedFigure } from './estimate.js';
import { amountWords } from './spending.js';

/**
 * What a verify can bill at most, as `shadowlap verify` bounds each run it checks (verify.md#cost):
 * a run that must now pass (target or held-out) up to its gate's max attempts, 80 by default; one
 * that must keep passing against its own baseline, the change's attempt and the baseline's in pairs,
 * up to 200 pairs (the config's `verify.max`, or a gate's max other than its default: `--gate
 * '{"max":160}'` is 160); against its golden's history, up to as many attempts; with no baseline,
 * by the gate on its own. A fixed count (`--attempts`) runs every run up to that many. Every verify
 * is priced so: Verify again and Verify this run on a fix, a fix's Run more attempts at its higher
 * limit, a repair's candidates, Changes' verify of a preview's runs and a migration's.
 */

/** How a verify decides its runs: its gate (verify's own by default) or a fixed count, and what a good run is kept against. */
export interface VerifyRule {
  gate?: SprtGate | null;
  attempts?: number | null;
  /** The most pairs (or attempts, against history) a good run takes: `--kept-max`, else the config's `verify.max`. */
  keptMax?: number | null;
  /** What a good run is kept against: a paired baseline (the default), its golden's history, or none. */
  baseline?: 'paired' | 'history' | 'none';
}

/**
 * The most pairs (or attempts, against history) a good run takes, as `shadowlap verify` reads it:
 * `--kept-max`, else the config's `verify.max` (`kept`, the first of them given), else a gate's max
 * other than its default (`--gate '{"max":20}'` means no run takes more than 20 attempts an arm),
 * else 200. The CLI's verify keeps its runs to this.
 */
export function keptMaxOf(kept: number | null | undefined, gate: Pick<SprtGate, 'max'> | null | undefined): number {
  return kept ?? (gate && gate.max !== SPRT_DEFAULTS.max ? gate.max : null) ?? KEPT_DEFAULTS.max;
}

/** The most a verify runs on each kind of run. */
export interface VerifyLimits {
  /** Attempts a run that must now pass takes at most. */
  failing: number;
  /** What a run that must keep passing takes at most: `pairs` against its paired baseline, else attempts. */
  good: number;
  unit: 'pairs' | 'attempts';
}

/** The limits a rule sets, as verify reads them (a gate's max other than its default caps a good run's pairs too). */
export function verifyLimits(rule: VerifyRule = {}): VerifyLimits {
  if (rule.attempts) return { failing: rule.attempts, good: rule.attempts, unit: 'attempts' };
  const gate = rule.gate ?? { kind: 'sprt', ...SPRT_DEFAULTS };
  const kept = keptMaxOf(rule.keptMax, gate);
  const baseline = rule.baseline ?? 'paired';
  if (baseline === 'paired') return { failing: gate.max, good: kept, unit: 'pairs' };
  return { failing: gate.max, good: baseline === 'history' ? Math.max(gate.max, kept) : gate.max, unit: 'attempts' };
}

/** A run a verify checks, priced: what an attempt of it costs under the change, and of its baseline. */
export interface VerifyRunCost {
  role: VerifyRole;
  /** USD an attempt costs under the change, its judge's calls with it; null when it has no price (`none` says why). */
  usd: number | null;
  /** A good run's baseline attempt (the run as it was before the change): as `usd` when left out; null when it has no price. */
  baseline?: number | null;
  none?: string;
}

/** The most a good run against a paired baseline can bill: its pairs, or, when no baseline could run, its gate alone. */
function goodMost(r: VerifyRunCost, limits: VerifyLimits): number | null {
  if (r.usd === null) return null;
  if (limits.unit === 'attempts') return limits.good * r.usd;
  const b = r.baseline === undefined ? r.usd : r.baseline;
  return b === null ? null : Math.max(limits.good * (r.usd + b), limits.failing * r.usd);
}

/** What a verify of `runs` can bill at most under `rule`, and how many attempts that is; null with a run that has no price. */
export function verifyCeiling(runs: readonly VerifyRunCost[], rule: VerifyRule = {}): { usd: number | null; attempts: number; limits: VerifyLimits } {
  const limits = verifyLimits(rule);
  let usd: number | null = 0;
  let attempts = 0;
  for (const r of runs) {
    const good = r.role === 'good';
    const most = good ? goodMost(r, limits) : r.usd === null ? null : limits.failing * r.usd;
    attempts += !good ? limits.failing : limits.unit === 'pairs' ? Math.max(2 * limits.good, limits.failing) : limits.good;
    usd = usd === null || most === null ? null : usd + most;
  }
  return { usd, attempts, limits };
}

/** How many attempts a verify may take, in a cost line's words: `up to 80 attempts a failing run, 200 pairs a good one`. */
export function verifyParts(failing: number, good: number, limits: VerifyLimits): string {
  const f = counted(limits.failing, 'attempt');
  const g = counted(limits.good, limits.unit === 'pairs' ? 'pair' : 'attempt');
  if (failing && good) return f === g ? `up to ${f} a run` : `up to ${f} a failing run, ${g} a good one`;
  if (good) return limits.unit === 'pairs' ? `up to ${g} a run against its baseline` : `up to ${g} a run`;
  return `up to ${f} a run`;
}

/** Where a verify's attempts run live, as its cost line says it. */
export const VERIFY_LIVE = {
  /** A change in the code: each attempt replays until a request differs, then runs live. */
  fork: 'live where a replay forks',
  /** A change of request fields from each run's first model call (a preview's switch, a migration). */
  first: 'live from the first model call',
  /** A repair's candidate, which rewrites the prompt or a tool every request carries. */
  each: 'live from each run’s first model call',
} as const;

/** What a kept verify spent, as a price's card reads it. */
export type LastVerify = Pick<VerifyReport, 'attempts' | 'spent' | 'judge' | 'unknownModels'>;

export interface VerifyEstimateOptions {
  rule?: VerifyRule;
  live?: keyof typeof VERIFY_LIVE;
  writes?: 'stub' | 'block';
  /** The last verify of the same runs: what an attempt of it cost, and what it spent, for the price's card. */
  last?: LastVerify | null;
  /**
   * What the verify it runs is expected to take, and cost, as the page works it out (Verify this run,
   * with no verify of those runs before it): for the price's card, when there is no `last`.
   */
  expected?: ExpectedFigure | null;
}

/** The price's card lines from what a verify is expected to take: what an attempt costs, then the attempts and their cost. */
function expectedLines(x: ExpectedFigure): string[] {
  const attempts = counted(Math.round(x.expected), 'attempt');
  if (x.cost === null || x.expected <= 0) return [`A gate stops once it decides: about ${attempts}.`];
  return [`An attempt costs about ${amountWords(x.cost / x.expected)}.`, `A gate stops once it decides: about ${attempts}, ${amountWords(x.cost)}.`];
}

/** USD the last verify spent in all, and an attempt of it on average; null when it made no attempt, or met a model with no price, so what it spent says nothing whole. */
export function lastVerify(last: LastVerify | null | undefined): { usd: number; each: number; attempts: number } | null {
  if (!last?.attempts || last.unknownModels.length) return null;
  const usd = last.spent + (last.judge?.spent ?? 0);
  return { usd, each: usd / last.attempts, attempts: last.attempts };
}

/**
 * A verify's estimate: every run it checks at its gate's limit (`At most ≈$20.11 · up to 80 attempts
 * a failing run, 200 pairs a good one · live where a replay forks, writes stubbed`). The last verify
 * of the same runs, and what it spent, are the price's card (Verify again); with none, what the
 * verify it runs is expected to take (Verify this run).
 */
export function verifyEstimate(runs: readonly VerifyRunCost[], o: VerifyEstimateOptions = {}): Estimate {
  if (!runs.length) return noEstimate('verify', 'there is no run to verify');
  const ceiling = verifyCeiling(runs, o.rule);
  const failing = runs.filter((r) => r.role !== 'good').length;
  const parts = [verifyParts(failing, runs.length - failing, ceiling.limits), `${VERIFY_LIVE[o.live ?? 'fork']}, writes ${o.writes === 'block' ? 'blocked' : 'stubbed'}`];
  if (ceiling.usd === null) return noEstimate('verify', runs.find((r) => r.usd === null || r.baseline === null)?.none ?? 'a run it checks has no price', parts);
  const last = lastVerify(o.last);
  const expected = last ? null : (o.expected ?? null);
  const lines = last
    ? [`An attempt costs about ${amountWords(last.each)}, as one of the last verify’s ${counted(last.attempts, 'attempt')} did.`, `A gate stops once it decides: the last verify spent ${amountWords(last.usd)}.`]
    : expected
      ? expectedLines(expected)
      : ['A gate stops once it decides, and a run whose replay doesn’t fork settles in one free attempt.'];
  return {
    kind: 'verify',
    usd: ceiling.usd,
    ceiling: true,
    parts,
    card: { title: 'If every run’s gate ran to its limit', lines: [...lines, CUT_SHORT_LINE] },
    attempts: ceiling.attempts,
    ...(last ? { last: { usd: last.usd, attempts: last.attempts } } : {}),
    ...(expected && expected.cost !== null ? { expected: { usd: expected.cost, attempts: Math.round(expected.expected) } } : {}),
  };
}

/**
 * Run more attempts on a verify's runs: verify has no `--continue`, so each run is verified again
 * from its first attempt, up to the higher limit (`rule`'s gate max), priced as verifyEstimate prices
 * it. What it is expected to take, and to cost, is the fix's own figure for it (`more`, the Verify
 * step's), so the step and the ask say the same: `about 34 attempts expected`.
 */
export function verifyMoreEstimate(runs: readonly VerifyRunCost[], more: ExpectedFigure | null, o: VerifyEstimateOptions = {}): Estimate {
  const e = verifyEstimate(runs, o);
  if (e.usd === null || !more) return e;
  const attempts = Math.round(more.expected);
  return { ...e, ...(more.cost !== null ? { expected: { usd: more.cost, attempts } } : {}), parts: [e.parts[0]!, `about ${counted(attempts, 'attempt')} expected`, ...e.parts.slice(1)] };
}

/** An attempt's spend on average, or null for none. */
const mean = (xs: readonly VerifyAttempt[]): number | null => (xs.length ? xs.reduce((s, a) => s + a.spent, 0) / xs.length : null);

/** Why a run of a kept verify has no price an attempt of it can be held to. */
const NONE = {
  started: 'the last verify made no attempt, so what one costs is unknown',
  spent: 'the last verify’s attempts spent nothing live, so what one costs is unknown',
  baseline: 'the last verify’s baseline attempts spent nothing live, so what one costs is unknown',
} as const;

/**
 * The runs of a verify kept in the store, each priced at what an attempt of it cost then, its share
 * of the judge's calls with it: what Verify again and Run more attempts verify again under the same
 * change. A run whose replay was clean stays free; one that never started is priced at the verify's
 * own average. Spends that leave something out price nothing: a model with no price (its calls
 * counted as nothing), and attempts that spent nothing live, which say nothing of what the next costs.
 */
export function verifyRunCosts(report: Pick<VerifyReport, 'runs' | 'attempts' | 'spent' | 'judge' | 'unknownModels'>): VerifyRunCost[] {
  const unpriced = report.unknownModels.length ? noPriceWords({ unpriced: report.unknownModels }) : null;
  const judge = report.judge && report.attempts ? report.judge.spent / report.attempts : 0;
  const average = report.attempts && report.spent > 0 ? report.spent / report.attempts : null;
  return report.runs.map((r): VerifyRunCost => {
    if (r.deterministic) return { role: r.role, usd: 0 };
    if (unpriced) return { role: r.role, usd: null, none: unpriced };
    const own = mean(r.attempts);
    const each = own === null ? average : own > 0 ? own : null;
    if (each === null) return { role: r.role, usd: null, none: report.attempts ? NONE.spent : NONE.started };
    const base = r.baselineRuns?.length ? mean(r.baselineRuns)! : null;
    if (base === null) return { role: r.role, usd: each + judge };
    return base > 0 ? { role: r.role, usd: each + judge, baseline: base + judge } : { role: r.role, usd: each + judge, baseline: null, none: NONE.baseline };
  });
}
