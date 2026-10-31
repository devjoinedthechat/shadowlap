import { KEPT_DEFAULTS } from '../noninferiority.js';
import { gateOdds, SPRT_DEFAULTS, type SprtGate } from '../stats.js';
import type { VerifyAttempt, VerifyReport, VerifyRole } from '../verify.js';
import { counted, noEstimate, type Estimate } from './estimate.js';
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
  const kept = rule.keptMax ?? (gate.max !== SPRT_DEFAULTS.max ? gate.max : null) ?? KEPT_DEFAULTS.max;
  const baseline = rule.baseline ?? 'paired';
  if (baseline === 'paired') return { failing: gate.max, good: kept, unit: 'pairs' };
  return { failing: gate.max, good: baseline === 'history' ? Math.max(gate.max, kept) : gate.max, unit: 'attempts' };
}

/** A run a verify checks, priced: what an attempt of it costs under the change, and of its baseline. */
export interface VerifyRunCost {
  role: VerifyRole;
  /** USD an attempt costs under the change, its judge's calls with it; null when it has no price (`none` says why). */
  usd: number | null;
  /** A good run's baseline attempt (the run as it was before the change): as `usd` when left out. */
  baseline?: number | null;
  none?: string;
  /** How its last verify went, for the attempts Run more attempts is expected to take: a clean replay settles in one free attempt. */
  tally?: { passes: number; attempts: number; deterministic?: boolean };
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

export interface VerifyEstimateOptions {
  rule?: VerifyRule;
  live?: keyof typeof VERIFY_LIVE;
  writes?: 'stub' | 'block';
  /** The last verify of the same runs: what an attempt of it cost, and what it spent, for the price's card. */
  last?: Pick<VerifyReport, 'attempts' | 'spent' | 'judge'> | null;
}

/** USD the last verify spent in all, and an attempt of it on average. */
function lastOf(last: Pick<VerifyReport, 'attempts' | 'spent' | 'judge'>): { usd: number; each: number } {
  const usd = last.spent + (last.judge?.spent ?? 0);
  return { usd, each: last.attempts ? usd / last.attempts : 0 };
}

/**
 * A verify's estimate: every run it checks at its gate's limit (`At most ≈$20.11 · up to 80 attempts
 * a failing run, 200 pairs a good one · live where a replay forks, writes stubbed`). The last verify
 * of the same runs, and what it spent, are the price's card.
 */
export function verifyEstimate(runs: readonly VerifyRunCost[], o: VerifyEstimateOptions = {}): Estimate {
  if (!runs.length) return noEstimate('verify', 'there is no run to verify');
  const ceiling = verifyCeiling(runs, o.rule);
  if (ceiling.usd === null) return noEstimate('verify', runs.find((r) => r.usd === null || r.baseline === null)?.none ?? 'a run it checks has no price');
  const failing = runs.filter((r) => r.role !== 'good').length;
  const last = o.last ? lastOf(o.last) : null;
  const lines = last
    ? [`An attempt costs about ${amountWords(last.each)}, as one of the last verify’s ${counted(o.last!.attempts, 'attempt')} did.`, `A gate stops once it decides: the last verify spent ${amountWords(last.usd)}.`]
    : ['A gate stops once it decides, and a run whose replay doesn’t fork settles in one free attempt.'];
  return {
    kind: 'verify',
    usd: ceiling.usd,
    ceiling: true,
    parts: [verifyParts(failing, runs.length - failing, ceiling.limits), `${VERIFY_LIVE[o.live ?? 'fork']}, writes ${o.writes === 'block' ? 'blocked' : 'stubbed'}`],
    card: { title: 'If every run’s gate ran to its limit', lines },
    attempts: ceiling.attempts,
    ...(last ? { last: { usd: last.usd, attempts: o.last!.attempts } } : {}),
  };
}

/**
 * Run more attempts on a verify's runs: verify has no `--continue`, so each run is verified again
 * from its first attempt, up to the higher limit (`rule`'s gate max), priced as verifyEstimate prices
 * it. With each run's tally, what it is expected to take as well, as the fix's Verify step works it
 * out: each at the rate it passed at so far, a clean replay one free attempt (`about 34 attempts
 * expected`).
 */
export function verifyMoreEstimate(runs: readonly VerifyRunCost[], o: VerifyEstimateOptions = {}): Estimate {
  const e = verifyEstimate(runs, o);
  // A fixed count states no rate it tells apart, so nothing says what it is expected to take.
  if (e.usd === null || o.rule?.attempts || !runs.every((r) => r.tally)) return e;
  const gate: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS, ...(o.rule?.gate ?? {}) };
  let attempts = 0;
  let usd = 0;
  for (const r of runs) {
    const t = r.tally!;
    if (t.deterministic) {
      attempts += 1;
      continue;
    }
    const n = gateOdds(gate, t.attempts ? t.passes / t.attempts : 0.5).attempts;
    attempts += n;
    usd += n * (r.usd! + (r.role === 'good' && verifyLimits(o.rule).unit === 'pairs' ? (r.baseline ?? r.usd!) : 0));
  }
  const expected = Math.round(attempts);
  return { ...e, expected: { usd, attempts: expected }, parts: [e.parts[0]!, `about ${counted(expected, 'attempt')} expected`, ...e.parts.slice(1)] };
}

/** An attempt's spend on average, or null for none. */
const mean = (xs: readonly VerifyAttempt[]): number | null => (xs.length ? xs.reduce((s, a) => s + a.spent, 0) / xs.length : null);

/**
 * The runs of a verify kept in the store, each priced at what an attempt of it cost then, its share
 * of the judge's calls with it: what Verify again and Run more attempts verify again under the same
 * change. A run whose replay was clean stays free; one that never started is priced at the verify's
 * own average.
 */
export function verifyRunCosts(report: Pick<VerifyReport, 'runs' | 'attempts' | 'spent' | 'judge'>): VerifyRunCost[] {
  const judge = report.judge && report.attempts ? report.judge.spent / report.attempts : 0;
  const average = report.attempts ? report.spent / report.attempts : 0;
  return report.runs.map((r) => {
    const tally = { passes: r.passes, attempts: r.attempts.length, deterministic: r.deterministic };
    if (r.deterministic) return { role: r.role, usd: 0, tally };
    const base = r.baselineRuns?.length ? mean(r.baselineRuns)! + judge : undefined;
    return { role: r.role, usd: (mean(r.attempts) ?? average) + judge, ...(base !== undefined ? { baseline: base } : {}), tally };
  });
}
