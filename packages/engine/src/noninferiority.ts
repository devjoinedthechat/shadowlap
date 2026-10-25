import { betaCdf, confidencePercent, riskPercent, type Tally } from './stats.js';

/**
 * Whether a change keeps a good run: not worse than the run's own baseline by `margin` or more. A
 * good run that forks is a sample, and so is its baseline, so "kept" is a test between two pass
 * rates, the change's (p_c) and the baseline's (p_b), on attempts that come in one at a time:
 *
 *   kept    rejects  H0: p_c <= p_b - margin   (it dropped by the margin or more)
 *   broken  rejects  H0': p_c >= p_b           (it didn't drop at all)
 *
 * Each verdict is wrong at most `risk` of the time: P(kept | drop >= margin) <= risk, and P(broken |
 * no drop) <= risk. Between the two either can come, and when `max` runs out first the run is
 * inconclusive.
 *
 * **Paired** (the default): the same good run replayed at the base revision, attempt for attempt
 * with the change's, the two arms of a pair run side by side. Each pair gives Z = X - Y, the change's
 * outcome minus the baseline's (1, 0 or -1), and the test is a betting e-process on Z (Waudby-Smith
 * and Ramdas, "Estimating means of bounded random variables by betting", 2023):
 *
 *   kept:   E_n = mean over the bets c of  prod_i (1 + c (Z_i + margin) / (1 - margin))
 *   broken: E'_n = mean over the bets c of prod_i (1 - c Z_i)
 *
 * Under H0, E[Z_i | the pairs before] <= -margin, so each factor has mean at most 1 and E_n is a
 * nonnegative supermartingale; by Ville's inequality P(E_n ever reaches 1/risk) <= risk. That holds
 * at every look and under any stopping, and for any pairs the null allows: arms that drift together
 * over time (the provider changes between attempts), arms that are correlated, pass rates that change
 * from pair to pair, so long as every pair's conditional drop is at least the margin. That is why
 * the pairs are interleaved: drift moves both arms of a pair, and the test needs nothing else of it.
 * The bets are fixed, so E_n depends on the counts of +1, 0 and -1 only, and the exact odds of each
 * verdict can be computed by enumerating the counts (`pairedOdds`), as can the worst case over every
 * null at once (`pairedWorstCase`), which Ville bounds by `risk` without the enumeration.
 *
 * **Against history**: the good run's golden's own past attempts (Tally) as the baseline, and only
 * the change's arm runs. The history is split from the attempts with Bonferroni: an exact one-sided
 * Clopper-Pearson bound on p_b at risk/2, then the one-sample version of the same e-process on the
 * change's attempts at risk/2. P(kept | drop >= margin) <= P(p_b above its upper bound) + P(the
 * e-process rejects p_c <= upper - margin) <= risk/2 + risk/2. It assumes the history's attempts are
 * draws of the pass rate the baseline has now; nothing pairs them with the change's.
 *
 * Inverting either e-process over the margin gives a confidence sequence for the drop p_b - p_c,
 * valid at the stopping time: `drop <= hi` at 1 - risk for a run kept, `drop >= lo` for one broken.
 */

export type BaselineSource = 'paired' | 'history';

export interface BaselineRule {
  /** The drop in pass rate from the baseline that breaks a run: 0.1 is 10 points. */
  margin: number;
  /** The most a verdict may be wrong: kept at a drop of `margin` or more, broken at no drop. */
  risk: number;
  /** The most pairs (paired) or attempts (history) it runs; between its bounds then, it is inconclusive. */
  max: number;
}

/**
 * The figures a good run is kept by when none are given: a drop of 10 points, up to 200 pairs. The
 * risk is the verify gate's. At these figures a run whose arms pass every attempt is kept after 38
 * pairs; one at 99% without a drop after 46 on average, and at 90% after 116, kept 79% of the time
 * and inconclusive most of the rest. A drop of 10 points is kept at most 3.8% of the time.
 */
export const KEPT_DEFAULTS: Readonly<Omit<BaselineRule, 'risk'>> = Object.freeze({ margin: 0.1, max: 200 });

/** The most pairs or attempts a baseline test may run. */
export const KEPT_MAX = 1000;

/**
 * The bets of the kept e-process, as shares of the largest one a loss allows, 1/(1 - margin): a
 * cautious one for runs that fail now and then, and a bold one that keeps a run whose arms always
 * pass after 38 pairs at the default margin. Chosen on the exact odds (`pairedOdds`) for baselines of
 * 75% to 99%; any fixed bets keep the error bound, only the power moves.
 */
const KEPT_BETS = [0.36, 0.9] as const;
/** The bets of the broken e-process, as shares of the largest a win allows, 1/(1 + drop). */
const BROKEN_BETS = [0.35, 0.7] as const;

/** A bound crossed by less than this still counts: the e-values are sums of logarithms. */
const EPS = 1e-9;

/** ln(sum of exp(x)) over a few terms, without overflow. */
function logSumExp(xs: readonly number[]): number {
  let m = -Infinity;
  for (const x of xs) if (x > m) m = x;
  if (m === -Infinity) return m;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

/** count · ln(factor), with 0 · ln(0) = 0: a factor of 0 that no observation met costs nothing. */
const times = (count: number, factor: number) => (count === 0 ? 0 : count * Math.log(factor));

function checkRule(r: BaselineRule): void {
  if (!(r.margin > 0 && r.margin < 1)) throw new RangeError(`margin (${r.margin}) must be between 0 and 1, such as 0.1`);
  if (!(r.risk > 0 && r.risk < 0.5)) throw new RangeError(`risk (${r.risk}) must be between 0 and 0.5`);
  if (!Number.isInteger(r.max) || r.max < 1 || r.max > KEPT_MAX) throw new RangeError(`max (${r.max}) must be a whole number from 1 to ${KEPT_MAX}`);
}

// ---- Paired ---------------------------------------------------------------------------------------

/**
 * A good run's pairs so far, each an attempt of the change and one of its baseline: how many pairs
 * the change passed and the baseline failed (`better`), the other way round (`worse`), and how many
 * came out the same (`same`), with each arm's passes for the report.
 */
export interface PairCounts {
  better: number;
  worse: number;
  same: number;
  /** Pairs whose change attempt passed, and whose baseline attempt did. */
  passes: number;
  basePasses: number;
}

export const NO_PAIRS: Readonly<PairCounts> = Object.freeze({ better: 0, worse: 0, same: 0, passes: 0, basePasses: 0 });

/** The counts after one more pair. */
export function addPair(c: PairCounts, changed: boolean, baseline: boolean): PairCounts {
  return {
    better: c.better + (changed && !baseline ? 1 : 0),
    worse: c.worse + (!changed && baseline ? 1 : 0),
    same: c.same + (changed === baseline ? 1 : 0),
    passes: c.passes + (changed ? 1 : 0),
    basePasses: c.basePasses + (baseline ? 1 : 0),
  };
}

export const pairsOf = (c: Pick<PairCounts, 'better' | 'worse' | 'same'>): number => c.better + c.worse + c.same;

/**
 * ln E_n of the kept e-process at `drop`: evidence that the change's pass rate is less than `drop`
 * below its baseline's. Nondecreasing in `drop`. Defined for -1 < drop < 1.
 */
export function pairedKeptLog(c: Pick<PairCounts, 'better' | 'worse' | 'same'>, drop: number): number {
  const scale = 1 / (1 - drop);
  return logSumExp(KEPT_BETS.map((share) => Math.log(1 / KEPT_BETS.length) + times(c.better, 1 + share * scale * (1 + drop)) + times(c.worse, 1 - share) + times(c.same, 1 + share * scale * drop)));
}

/**
 * ln E'_n of the broken e-process at `drop`: evidence that the change's pass rate is more than `drop`
 * below its baseline's. Nonincreasing in `drop`. Defined for -1 < drop < 1.
 */
export function pairedBrokenLog(c: Pick<PairCounts, 'better' | 'worse' | 'same'>, drop: number): number {
  const scale = 1 / (1 + drop);
  return logSumExp(BROKEN_BETS.map((share) => Math.log(1 / BROKEN_BETS.length) + times(c.better, 1 - share) + times(c.worse, 1 + share * scale * (1 - drop)) + times(c.same, 1 - share * scale * drop)));
}

export type BaselineDecision = 'kept' | 'broken' | 'continue' | 'inconclusive';

/**
 * What the paired test says after the pairs counted: kept once the kept e-process reaches 1/risk at
 * the margin, broken once the broken one does at no drop, inconclusive when `max` pairs leave both
 * short, and otherwise another pair. Asked after every pair, stopping at its first answer.
 */
export function decidePaired(c: Pick<PairCounts, 'better' | 'worse' | 'same'>, rule: BaselineRule): BaselineDecision {
  checkRule(rule);
  const n = pairsOf(c);
  if (n === 0) return 'continue';
  const bar = Math.log(1 / rule.risk) - EPS;
  if (pairedKeptLog(c, rule.margin) >= bar) return 'kept';
  if (pairedBrokenLog(c, 0) >= bar) return 'broken';
  return n >= rule.max ? 'inconclusive' : 'continue';
}

/** Bisection for where a monotone function of the drop crosses `bar`, in (-1, 1). */
function crossing(f: (drop: number) => number, bar: number, rising: boolean): number | null {
  let lo = -1 + 1e-9;
  let hi = 1 - 1e-9;
  const above = (d: number) => f(d) >= bar;
  if (rising ? !above(hi) : !above(lo)) return null;
  if (rising ? above(lo) : above(hi)) return rising ? lo : hi;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (above(mid) === rising) hi = mid;
    else lo = mid;
  }
  return rising ? hi : lo;
}

/** A confidence interval for the drop p_b - p_c, each end at 1 - risk, valid whenever the test stopped. */
export interface DropBound {
  /** The drop is at least this (the broken e-process inverted); null when nothing bounds it from below. */
  lo: number | null;
  /** The drop is at most this (the kept e-process inverted); null when nothing bounds it from above. */
  hi: number | null;
  /** 1 - risk, each end. */
  confidence: number;
  /** How it was made: `betting`, the paired e-processes inverted; `history`, Clopper-Pearson on the history and the one-sample e-processes. */
  method: 'betting' | 'history';
}

/** The paired drop's confidence interval from the pairs so far, each end at 1 - risk. */
export function pairedDrop(c: Pick<PairCounts, 'better' | 'worse' | 'same'>, risk: number): DropBound {
  const bar = Math.log(1 / risk) - EPS;
  if (pairsOf(c) === 0) return { lo: null, hi: null, confidence: 1 - risk, method: 'betting' };
  return { lo: crossing((d) => pairedBrokenLog(c, d), bar, false), hi: crossing((d) => pairedKeptLog(c, d), bar, true), confidence: 1 - risk, method: 'betting' };
}

// ---- Against history --------------------------------------------------------------------------------

/** The exact one-sided Clopper-Pearson bound on a pass rate from `passes` of `attempts`, at 1 - risk. */
export function clopperPearsonBound(passes: number, attempts: number, risk: number, side: 'upper' | 'lower'): number {
  if (!(attempts >= 0) || passes < 0 || passes > attempts) throw new RangeError(`passes (${passes}) and attempts (${attempts}) must satisfy 0 <= passes <= attempts`);
  if (side === 'upper' && passes === attempts) return 1;
  if (side === 'lower' && passes === 0) return 0;
  // upper: the p with P(X <= passes | p) = risk; lower: the p with P(X >= passes | p) = risk.
  const tail = side === 'upper' ? (p: number) => 1 - betaCdf(p, passes + 1, attempts - passes) : (p: number) => betaCdf(p, passes, attempts - passes + 1);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    // upper: tail(p) = P(X <= passes) falls as p rises; lower: P(X >= passes) rises with p.
    if (side === 'upper' ? tail(mid) > risk : tail(mid) < risk) lo = mid;
    else hi = mid;
  }
  return side === 'upper' ? hi : lo;
}

/** ln E of the one-sample kept e-process: evidence that the change passes more than `floor` of the time. Nonincreasing in `floor`. */
export function historyKeptLog(changed: Tally, floor: number): number {
  if (floor <= 0) return changed.passes > 0 ? Infinity : 0;
  if (floor >= 1) return -Infinity;
  const fails = changed.attempts - changed.passes;
  return logSumExp(KEPT_BETS.map((share) => Math.log(1 / KEPT_BETS.length) + times(changed.passes, 1 + (share * (1 - floor)) / floor) + times(fails, 1 - share)));
}

/** ln E' of the one-sample broken e-process: evidence that the change passes less than `ceiling` of the time. Nondecreasing in `ceiling`. */
export function historyBrokenLog(changed: Tally, ceiling: number): number {
  if (ceiling >= 1) return changed.attempts > changed.passes ? Infinity : 0;
  if (ceiling <= 0) return -Infinity;
  const fails = changed.attempts - changed.passes;
  return logSumExp(BROKEN_BETS.map((share) => Math.log(1 / BROKEN_BETS.length) + times(changed.passes, 1 - share) + times(fails, 1 + (share * ceiling) / (1 - ceiling))));
}

/** The bounds on the baseline's pass rate a history gives, each at 1 - risk/2. */
export function historyBounds(history: Tally, risk: number): { lo: number; hi: number } {
  return { lo: clopperPearsonBound(history.passes, history.attempts, risk / 2, 'lower'), hi: clopperPearsonBound(history.passes, history.attempts, risk / 2, 'upper') };
}

/**
 * What the test against history says after the change's attempts so far: kept once its e-process
 * shows it passes more than (the baseline's upper bound - margin) of the time, broken once it shows
 * it passes less than the baseline's lower bound, each at risk/2; inconclusive at `max`.
 */
export function decideAgainstHistory(changed: Tally, history: Tally, rule: BaselineRule): BaselineDecision {
  checkRule(rule);
  if (history.attempts === 0) throw new RangeError('a baseline from history needs at least one attempt in it');
  return againstBounds(changed, historyBounds(history, rule.risk), rule);
}

/** The same with the history's bounds worked out already. */
function againstBounds(changed: Tally, b: { lo: number; hi: number }, rule: BaselineRule): BaselineDecision {
  if (changed.attempts === 0) return 'continue';
  const bar = Math.log(2 / rule.risk) - EPS;
  if (historyKeptLog(changed, b.hi - rule.margin) >= bar) return 'kept';
  if (historyBrokenLog(changed, b.lo) >= bar) return 'broken';
  return changed.attempts >= rule.max ? 'inconclusive' : 'continue';
}

/** The drop's confidence interval against history, each end at 1 - risk: the baseline's bounds less the change's. */
export function historyDrop(changed: Tally, history: Tally, risk: number): DropBound {
  const out: DropBound = { lo: null, hi: null, confidence: 1 - risk, method: 'history' };
  if (!changed.attempts || !history.attempts) return out;
  const b = historyBounds(history, risk);
  const bar = Math.log(2 / risk) - EPS;
  // The change's own pass rate: above `floor` (kept e-process inverted), below `ceiling` (broken).
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (historyKeptLog(changed, mid) >= bar) lo = mid;
    else hi = mid;
  }
  const floor = historyKeptLog(changed, lo) >= bar ? lo : null;
  lo = 0;
  hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (historyBrokenLog(changed, mid) >= bar) hi = mid;
    else lo = mid;
  }
  const ceiling = historyBrokenLog(changed, hi) >= bar ? hi : null;
  return { ...out, hi: floor === null ? null : b.hi - floor, lo: ceiling === null ? null : b.lo - ceiling };
}

// ---- The exact odds ---------------------------------------------------------------------------------

/** How the test comes out for given pass rates, exactly: each verdict's chance, and the attempts each arm runs on average. */
export interface BaselineOdds {
  kept: number;
  broken: number;
  inconclusive: number;
  /** Pairs (paired) or the change's attempts (history) on average: what each arm runs. */
  attempts: number;
}

const VERDICTS: readonly BaselineDecision[] = ['continue', 'kept', 'broken', 'inconclusive'];

/** The last rule's decisions, kept for the next call with the same figures: a table of the odds asks for many rates. */
let lastDecider: { key: string; decide: (n: number, a: number, b: number) => BaselineDecision } | null = null;

/**
 * The paired test's decisions by counts (`a` pairs better, `b` worse, of `n`), each worked out once:
 * a byte per count, row by row as the pairs grow, so a test of `max` pairs holds about max³/6 bytes.
 */
function pairedDecider(rule: BaselineRule): (n: number, a: number, b: number) => BaselineDecision {
  checkRule(rule);
  const key = `${rule.margin} ${rule.risk} ${rule.max}`;
  if (lastDecider?.key === key) return lastDecider.decide;
  const rows: Array<Int8Array | undefined> = [];
  const decide = (n: number, a: number, b: number): BaselineDecision => {
    let row = rows[n];
    if (!row) rows[n] = row = new Int8Array((n + 1) * (n + 1)).fill(-1);
    const at = a * (n + 1) + b;
    let d = row[at]!;
    if (d < 0) row[at] = d = VERDICTS.indexOf(decidePaired({ better: a, worse: b, same: n - a - b }, rule));
    return VERDICTS[d]!;
  };
  lastDecider = { key, decide };
  return decide;
}

/**
 * The paired test's exact odds when each pair's two attempts pass independently, the change's with
 * probability `pc` and the baseline's with `pb`: every count of +1, 0 and -1 the test can see, walked
 * pair by pair and stopped where it decides.
 */
export function pairedOdds(rule: BaselineRule, pc: number, pb: number): BaselineOdds {
  if (!(pc >= 0 && pc <= 1 && pb >= 0 && pb <= 1)) throw new RangeError('pass rates must be between 0 and 1');
  const up = pc * (1 - pb);
  const down = (1 - pc) * pb;
  return pairedWalk(rule, () => [up, down, 1 - up - down]);
}

/** A walk over counts where each step's law may depend on the state; `law` returns P(+1), P(-1), P(0). */
function pairedWalk(rule: BaselineRule, law: (n: number, a: number, b: number) => readonly [number, number, number]): BaselineOdds {
  const decide = pairedDecider(rule);
  const span = rule.max + 2;
  let walking = new Map<number, number>([[0, 1]]);
  const out: BaselineOdds = { kept: 0, broken: 0, inconclusive: 0, attempts: 0 };
  for (let n = 1; n <= rule.max; n++) {
    const next = new Map<number, number>();
    for (const [key, mass] of walking) {
      const a = Math.floor(key / span);
      const b = key % span;
      const [up, down, same] = law(n - 1, a, b);
      for (const [da, db, q] of [
        [1, 0, up],
        [0, 1, down],
        [0, 0, same],
      ] as const) {
        if (q <= 0) continue;
        const m = mass * q;
        const d = decide(n, a + da, b + db);
        if (d === 'continue') {
          const k = (a + da) * span + b + db;
          next.set(k, (next.get(k) ?? 0) + m);
        } else {
          out[d] += m;
          out.attempts += m * n;
        }
      }
    }
    walking = next;
  }
  return out;
}

/**
 * The most often the paired test can give `verdict` wrongly, over every null at once: for `kept`,
 * any pairs whose drop, given the pairs before, is at least the margin; for `broken`, any whose drop
 * is at most 0. Nature picks each pair's law after seeing the pairs before (drift, correlation, any
 * strategy), and backward induction over the counts finds its best. Both verdicts are monotone in the
 * outcomes, so the worst law has a drop exactly at the bound, and since the chance of the verdict is
 * linear in that law's share of ties, at one of the two extreme laws: for kept, Z = +1 or -1 only
 * ((1 - margin)/2 and (1 + margin)/2), or Z in {0, -1} only (1 - margin and margin); for broken,
 * Z = +1 or -1 at a half each, or Z = 0 always. Ville bounds the result by risk; this says by how much.
 */
export function pairedWorstCase(rule: BaselineRule, verdict: 'kept' | 'broken'): number {
  checkRule(rule);
  const decide = pairedDecider(rule);
  const laws: ReadonlyArray<readonly [number, number, number]> =
    verdict === 'kept'
      ? [
          [(1 - rule.margin) / 2, (1 + rule.margin) / 2, 0],
          [0, rule.margin, 1 - rule.margin],
        ]
      : [
          [0.5, 0.5, 0],
          [0, 0, 1],
        ];
  const span = rule.max + 2;
  // value[a * span + b]: the most likely `verdict` is from counts (n, a, b) on, before deciding there.
  let value = new Float64Array(span * span);
  for (let n = rule.max; n >= 0; n--) {
    const here = new Float64Array(span * span);
    for (let a = 0; a <= n; a++) {
      for (let b = 0; a + b <= n; b++) {
        const d = n === 0 ? 'continue' : decide(n, a, b);
        if (d !== 'continue') {
          here[a * span + b] = d === verdict ? 1 : 0;
          continue;
        }
        let best = 0;
        for (const [up, down, same] of laws) {
          const v = up * value[(a + 1) * span + b]! + down * value[a * span + b + 1]! + same * value[a * span + b]!;
          if (v > best) best = v;
        }
        here[a * span + b] = best;
      }
    }
    value = here;
  }
  return value[0]!;
}

/**
 * The test against history's exact odds when the change passes `pc` of the time and the baseline
 * `pb`, its history `size` attempts of it: averaged over every history the baseline could have left
 * (binomial), each walked attempt by attempt over the change's passes.
 */
export function historyOdds(rule: BaselineRule, pc: number, pb: number, size: number): BaselineOdds {
  checkRule(rule);
  const out: BaselineOdds = { kept: 0, broken: 0, inconclusive: 0, attempts: 0 };
  for (let s = 0; s <= size; s++) {
    const weight = Math.exp(lnChoose(size, s) + times(s, pb) + times(size - s, 1 - pb));
    if (weight < 1e-15) continue;
    const bounds = historyBounds({ passes: s, attempts: size }, rule.risk);
    // The decision depends on the change's passes and attempts alone, given the history.
    const memo = new Map<number, BaselineDecision>();
    const decide = (p: number, n: number) => {
      const k = n * (rule.max + 1) + p;
      let d = memo.get(k);
      if (d === undefined) memo.set(k, (d = againstBounds({ passes: p, attempts: n }, bounds, rule)));
      return d;
    };
    let walking = new Map<number, number>([[0, 1]]);
    for (let n = 1; n <= rule.max; n++) {
      const next = new Map<number, number>();
      for (const [passes, mass] of walking) {
        for (const [p, q] of [
          [passes + 1, pc],
          [passes, 1 - pc],
        ] as const) {
          if (q <= 0) continue;
          const m = mass * q;
          const d = decide(p, n);
          if (d === 'continue') next.set(p, (next.get(p) ?? 0) + m);
          else {
            out[d] += weight * m;
            out.attempts += weight * m * n;
          }
        }
      }
      walking = next;
    }
  }
  return out;
}

function lnChoose(n: number, k: number): number {
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}

// ---- What the reports say -------------------------------------------------------------------------

/** Points of a drop: 0.1 is `10`. */
const points = (x: number) => `${+(x * 100).toFixed(1)}`;

/**
 * The rule a good run is kept by, in a line: `kept unless it drops 10+ points below its baseline at
 * 370712a, <= 5% risk, up to 200 pairs` (paired), or `... below its golden's history, ..., up to 200
 * attempts`. Each verdict wrong at most `risk` of the time: kept at a drop of the margin or more,
 * broken at no drop.
 */
export function describeBaselineRule(r: BaselineRule & { source: BaselineSource; revision?: string | null }): string {
  const against = r.source === 'paired' ? `its baseline${r.revision ? ` at ${r.revision}` : ''}, attempt for attempt` : "its golden's history";
  return `kept unless it drops ${points(r.margin)}+ points below ${against}, <= ${riskPercent(r.risk)} risk, up to ${r.max} ${r.source === 'paired' ? 'pairs' : 'attempts'}`;
}

/**
 * The baseline test in a few words, as `gateShort` puts a gate's: `tells no drop from one of 10+
 * points at <= 5% risk`. Kept at a drop of the margin or more, or broken at no drop, each at most
 * `risk` of the time.
 */
export function baselineShort(r: Pick<BaselineRule, 'margin' | 'risk'>): string {
  return `tells no drop from one of ${points(r.margin)}+ points at <= ${riskPercent(r.risk)} risk`;
}

/** A drop to two places, signed: `0.07`, `-0.03`. */
const signed = (x: number) => (Math.abs(x) < 0.005 ? '0.00' : x.toFixed(2));

/**
 * The bound that bears on a baseline verdict: `drop <= 0.07 (95%)` for a run kept, `drop >= 0.12
 * (95%)` for one broken, both ends otherwise (`drop -0.04 to 0.18 (95%)`), each end valid whenever the
 * test stopped. Null with nothing to bound.
 */
export function dropBound(d: DropBound, decision: BaselineDecision | 'pass' | 'fail' | null | undefined): string | null {
  const at = `(${confidencePercent(d.confidence)})`;
  if ((decision === 'kept' || decision === 'pass') && d.hi !== null) return `drop <= ${signed(d.hi)} ${at}`;
  if ((decision === 'broken' || decision === 'fail') && d.lo !== null) return `drop >= ${signed(d.lo)} ${at}`;
  if (d.lo === null && d.hi === null) return null;
  return `drop ${d.lo === null ? '?' : signed(d.lo)} to ${d.hi === null ? '?' : signed(d.hi)} ${at}`;
}
