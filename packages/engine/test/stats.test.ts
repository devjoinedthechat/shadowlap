import { describe, expect, it } from 'vitest';
import {
  BASELINE_DEFAULTS,
  BASELINE_PASS_AT,
  BLAME_DEFAULTS,
  RECORDING_BASELINE,
  SPRT_DEFAULTS,
  attemptsToFail,
  attemptsToPass,
  confidencePercent,
  betaCdf,
  betaPdf,
  binomialTail,
  countOdds,
  decide,
  decideCount,
  describeGate,
  dropProbability,
  formatPassK,
  formatTally,
  gateOdds,
  gateOddsAt,
  gateOf,
  gateResult,
  gateSentence,
  lnGamma,
  normalQuantile,
  parseGate,
  passHatK,
  passesPerFailure,
  percent,
  runsRed,
  sprtBounds,
  sprtScore,
  sprtStep,
  verdictLine,
  wilson,
  rateBound,
  riskPercent,
  type BaselineGate,
  type SprtGate,
} from '../src/stats.js';

const sprt = (o: Partial<Omit<SprtGate, 'kind'>> = {}): SprtGate => ({ kind: 'sprt', ...SPRT_DEFAULTS, ...o });
const baseline = (o: Partial<Omit<BaselineGate, 'kind'>> = {}): BaselineGate => ({ kind: 'baseline', ...BASELINE_DEFAULTS, ...o });
/** The figures docs/gating.md opens with: tell 90% or more from 70% or less, 5% risk each, give up after 20. */
const SPEC = sprt({ good: 0.9, bad: 0.7, risk: 0.05, max: 20 });
/** Attempts in order, T for a pass and F for a failure. */
const path = (s: string): boolean[] => [...s].map((c) => c === 'T');

describe('the binomial table: what a fixed 4 of 5 lets through', () => {
  // Exact figures, not measurements: P(at least 4 passes in 5) for an agent that passes p of the time.
  it('clears a 95% agent 97.7% of the time, an 80% agent 73.7%, a 70% agent 52.8%', () => {
    expect(binomialTail(5, 4, 0.95)).toBeCloseTo(0.9774075, 12);
    expect(binomialTail(5, 4, 0.8)).toBeCloseTo(0.73728, 12);
    expect(binomialTail(5, 4, 0.7)).toBeCloseTo(0.52822, 12);
    expect(percent(binomialTail(5, 4, 0.95))).toBe('97.7%');
    expect(percent(binomialTail(5, 4, 0.8))).toBe('73.7%');
    expect(percent(binomialTail(5, 4, 0.7))).toBe('52.8%');
  });

  it('flakes on a healthy agent: about 2 spurious failures in 100 goldens, at least one in about 90% of runs', () => {
    const fails = 1 - binomialTail(5, 4, 0.95);
    expect(fails).toBeCloseTo(0.0225925, 10);
    expect(100 * fails).toBeCloseTo(2.26, 2);
    expect(1 - (1 - fails) ** 100).toBeCloseTo(0.898, 3);
  });

  it('comes out the same stopped as soon as it is settled, as verify and blame stop', () => {
    for (const p of [0, 0.3, 0.7, 0.8, 0.95, 1]) {
      const odds = countOdds(5, 4, p);
      expect(odds.pass).toBeCloseTo(binomialTail(5, 4, p), 12);
      expect(odds.pass + odds.fail).toBeCloseTo(1, 12);
      expect(odds.inconclusive).toBe(0);
    }
    // Always passing: 4 attempts settle it; always failing, 2.
    expect(countOdds(5, 4, 1).attempts).toBe(4);
    expect(countOdds(5, 4, 0).attempts).toBe(2);
  });

  it('knows the edges', () => {
    expect(binomialTail(5, 0, 0.3)).toBe(1);
    expect(binomialTail(5, 6, 0.3)).toBe(0);
    expect(binomialTail(5, 5, 1)).toBe(1);
    expect(binomialTail(5, 1, 0)).toBe(0);
    expect(binomialTail(20, 18, 0.9)).toBeCloseTo(0.676927, 6);
  });
});

describe('the SPRT', () => {
  it('adds ln(good/bad) for a pass and ln((1−good)/(1−bad)) for a failure, between ln(1/risk) and ln(failRisk)', () => {
    const b = sprtBounds(SPEC);
    expect(b.pass).toBeCloseTo(Math.log(0.9 / 0.7), 14);
    expect(b.fail).toBeCloseTo(Math.log(0.1 / 0.3), 14);
    expect(b.upper).toBeCloseTo(Math.log(20), 14);
    expect(b.lower).toBe(-b.upper);
    expect(b.pass).toBeCloseTo(0.2513144, 7);
    expect(b.fail).toBeCloseTo(-1.0986123, 7);
    expect(b.upper).toBeCloseTo(2.9957323, 7);
    // A lower risk for a failure moves only the bound a failure is decided at.
    expect(sprtBounds({ ...SPEC, failRisk: 0.001 })).toMatchObject({ upper: b.upper, lower: Math.log(0.001) });
    expect(sprtStep(0, true, SPEC)).toBe(b.pass);
    expect(sprtStep(sprtStep(0, true, SPEC), false, SPEC)).toBeCloseTo(b.pass + b.fail, 15);
    expect(sprtScore(3, 4, SPEC)).toBeCloseTo(3 * b.pass + b.fail, 15);
  });

  it('accepts an agent that always passes after 12 attempts, and not one sooner', () => {
    expect(attemptsToPass(SPEC)).toBe(12);
    for (let n = 1; n < 12; n++) expect(decide(n, n, SPEC), `after ${n}`).toBe('continue');
    expect(decide(12, 12, SPEC)).toBe('pass');
  });

  it('needs about 4.4 more passes to make up for each failure', () => {
    expect(passesPerFailure(SPEC)).toBeCloseTo(4.37147, 5);
    expect(+passesPerFailure(SPEC).toFixed(1)).toBe(4.4);
    // One failure anywhere: 17 passes, 18 attempts, where 11 failure-free passes plus 4.4 would be 16.4.
    expect(decide(16, 17, SPEC)).toBe('continue');
    expect(decide(17, 18, SPEC)).toBe('pass');
    // Two failures: 21 passes, which 20 attempts can't hold.
    expect(decide(18, 20, SPEC)).toBe('inconclusive');
  });

  it('fails an agent that always fails after 3 attempts', () => {
    expect(attemptsToFail(SPEC)).toBe(3);
    expect(decide(0, 1, SPEC)).toBe('continue');
    expect(decide(0, 2, SPEC)).toBe('continue');
    expect(decide(0, 3, SPEC)).toBe('fail');
    // Four failures outweigh a pass: 0.25 − 4.39 is below −3.00.
    expect(decide(1, 5, SPEC)).toBe('fail');
  });

  it('is inconclusive when max runs out between the bounds, and only then', () => {
    expect(decide(16, 19, SPEC)).toBe('continue');
    expect(decide(16, 20, SPEC)).toBe('inconclusive');
    expect(decide(16, 20, { ...SPEC, max: 40 })).toBe('continue');
    expect(decide(0, 0, SPEC)).toBe('continue');
  });

  it('keeps each verdict wrong at most its risk of the time, at good and at bad, as its line says', () => {
    for (const g of [SPEC, sprt(), sprt({ good: 0.95, bad: 0.8, risk: 0.1, max: 60 }), sprt({ ...BLAME_DEFAULTS }), sprt({ failRisk: 0.0005, max: 200 })]) {
      expect(gateOdds(g, g.good).fail, describeGate(g)).toBeLessThanOrEqual(g.failRisk ?? g.risk);
      expect(gateOdds(g, g.bad).pass, describeGate(g)).toBeLessThanOrEqual(g.risk);
    }
  });

  it('keeps every gate a config can set within the risk its line prints, on a grid of rates, risks and limits, where Wald’s bounds did not', () => {
    // Every gate of `good` and `bad` a twentieth apart that parseGate accepts, at five risks and three
    // limits: the exact chance it passes an agent at `bad` and fails one at `good`, every look counted.
    // Under Wald's bounds, ±ln((1 − risk) / risk), some went past the risk they print; under ln(1/risk)
    // and ln(risk), none does.
    const exactly = (g: SprtGate, upper: number, lower: number) => {
      const b = sprtBounds(g);
      const rule = (passes: number, n: number) => {
        const score = passes * b.pass + (n - passes) * b.fail;
        return score >= upper - 1e-9 ? 'pass' : score <= lower + 1e-9 ? 'fail' : n >= g.max ? 'inconclusive' : 'continue';
      };
      const at = (p: number) => {
        let walking = new Map<number, number>([[0, 1]]);
        const out = { pass: 0, fail: 0 };
        for (let n = 1; n <= g.max && walking.size; n++) {
          const next = new Map<number, number>();
          for (const [s0, m] of walking)
            for (const [x, q] of [
              [s0 + 1, p],
              [s0, 1 - p],
            ] as const) {
              const d = rule(x, n);
              if (d === 'continue') next.set(x, (next.get(x) ?? 0) + m * q);
              else if (d !== 'inconclusive') out[d] += m * q;
            }
          walking = next;
        }
        return out;
      };
      return Math.max(at(g.bad).pass, at(g.good).fail);
    };
    let tried = 0;
    let waldOver = 0;
    for (const risk of [0.01, 0.05, 0.1, 0.2, 0.3])
      for (const max of [20, 80, 1000])
        for (let good = 55; good <= 95; good += 5)
          for (let bad = 5; bad < good - 2; bad += 5) {
            let g: SprtGate;
            try {
              g = parseGate({ good: good / 100, bad: bad / 100, risk, max }, 'g') as SprtGate;
            } catch {
              continue;
            }
            tried++;
            const b = sprtBounds(g);
            expect(exactly(g, b.upper, b.lower), describeGate(g)).toBeLessThanOrEqual(risk + 1e-12);
            const wald = Math.log((1 - risk) / risk);
            if (exactly(g, wald, -wald) > risk + 1e-12) waldOver++;
          }
    expect(tried).toBeGreaterThan(1000);
    expect(waldOver).toBeGreaterThan(10);
  }, 60_000);

  it('gives exact odds and attempts: every way it can end, adding up to 1', () => {
    const always = gateOdds(SPEC, 1);
    expect(always).toEqual({ pass: 1, fail: 0, inconclusive: 0, attempts: 12 });
    expect(gateOdds(SPEC, 0)).toEqual({ pass: 0, fail: 1, inconclusive: 0, attempts: 3 });
    const healthy = gateOdds(SPEC, 0.95);
    expect(healthy.pass + healthy.fail + healthy.inconclusive).toBeCloseTo(1, 12);
    // A 95% agent: wrongly failed 0.14% of the time where 4 of 5 fails it 2.26%, at 15.2 attempts.
    expect(healthy.fail).toBeCloseTo(0.00143, 5);
    expect(healthy.attempts).toBeCloseTo(15.16, 2);
    // With 20 attempts one failure can be made up for, two can't: a fifth of 95% agents end inconclusive.
    expect(healthy.inconclusive).toBeCloseTo(0.2073, 4);
    // 40 leaves 0.78% of them inconclusive; the default, 80, almost none, for 1.5 more attempts on average.
    expect(gateOdds(sprt({ max: 40 }), 0.95).inconclusive).toBeCloseTo(0.0078, 4);
    const roomier = gateOdds(sprt(), 0.95);
    expect(SPRT_DEFAULTS.max).toBe(80);
    expect(roomier.inconclusive).toBeLessThan(0.0001);
    expect(roomier.fail).toBeCloseTo(0.001547, 6);
    expect(roomier.attempts).toBeCloseTo(16.69, 2);
    // A 70% agent gets through 2% of the time, not 53%; at 80 attempts, 4.3%.
    expect(gateOdds(SPEC, 0.7).pass).toBeCloseTo(0.0222, 4);
    expect(gateOdds(sprt(), 0.7).pass).toBeCloseTo(0.043, 4);
    // The room costs only where the evidence is close: a 90% agent takes 24.8 attempts, an 80% one 34.8.
    expect(gateOdds(sprt(), 0.9).attempts).toBeCloseTo(24.78, 2);
    expect(gateOdds(sprt(), 0.8).attempts).toBeCloseTo(34.77, 2);
  });

  it('gives the same odds at many rates at once as one at a time', () => {
    const at = gateOddsAt(SPEC, [0.99, 0.95, 0.7]);
    expect(at.map((o) => o.rate)).toEqual([0.99, 0.95, 0.7]);
    for (const o of at) expect(o).toEqual({ rate: o.rate, ...gateOdds(SPEC, o.rate) });
  });

  it('continued to a higher limit, decides exactly as a gate that had that limit from the start', () => {
    // Every way the gate with max 20 can stand after 20 attempts undecided, each continued under max 40
    // from where it stood, plus what it decided before: exactly the gate with max 40.
    const roomy = sprt({ max: 40 });
    for (const p of [0.95, 0.85, 0.7]) {
      let walking = new Map<number, number>([[0, 1]]);
      const out = { pass: 0, fail: 0, inconclusive: 0, attempts: 0 };
      for (let n = 1; n <= 20; n++) {
        const next = new Map<number, number>();
        for (const [k, mass] of walking) {
          for (const [passes, q] of [[k + 1, p], [k, 1 - p]] as const) {
            const d = decide(passes, n, roomy);
            if (d === 'continue') next.set(passes, (next.get(passes) ?? 0) + mass * q);
            else {
              out[d] += mass * q;
              out.attempts += mass * q * n;
            }
          }
        }
        walking = next;
      }
      // What max 20 called inconclusive, continued to 40.
      expect([...walking.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(gateOdds(SPEC, p).inconclusive, 12);
      for (const [k, mass] of walking) {
        const more = gateOdds(roomy, p, null, { passes: k, attempts: 20 });
        expect(more.pass + more.fail + more.inconclusive).toBeCloseTo(1, 12);
        out.pass += mass * more.pass;
        out.fail += mass * more.fail;
        out.inconclusive += mass * more.inconclusive;
        out.attempts += mass * more.attempts;
      }
      const whole = gateOdds(roomy, p);
      expect(out.pass).toBeCloseTo(whole.pass, 12);
      expect(out.fail).toBeCloseTo(whole.fail, 12);
      expect(out.inconclusive).toBeCloseTo(whole.inconclusive, 12);
      expect(out.attempts).toBeCloseTo(whole.attempts, 10);
    }
  });

  it('settles what 2 of 5 settled for blame, at the same cost, and says how sure it is', () => {
    const g = sprt({ ...BLAME_DEFAULTS });
    expect(attemptsToPass(g)).toBe(2);
    expect(attemptsToFail(g)).toBe(4);
    expect(decide(2, 2, g)).toBe('pass');
    expect(decide(0, 4, g)).toBe('fail');
    // A pass and three failures: no verdict yet, where 2 of 5 would call it lost already only after 4.
    expect(decide(1, 4, g)).toBe('continue');
    // Up to 20 attempts settle the calls in between: one the model gets right 30% of the time ends
    // inconclusive 5.7% of the time, where 10 attempts left it so 30% of the time.
    expect(BLAME_DEFAULTS.max).toBe(20);
    expect(gateOdds(g, 0.3).inconclusive).toBeCloseTo(0.0572, 4);
    expect(gateOdds({ ...g, max: 10 }, 0.3).inconclusive).toBeCloseTo(0.30, 2);
  });
});

describe('what a CI run sees', () => {
  // 100 forked goldens of an agent that passes 95% of the time: how often the run goes red for nothing.
  it('4 of 5 turns about 90% of runs red', () => {
    expect(runsRed(countOdds(5, 4, 0.95), 100)).toBeCloseTo(0.8982, 4);
  });

  it('the default gate about 15%, counting inconclusive goldens as --inconclusive fail does', () => {
    const odds = gateOdds(sprt(), 0.95);
    expect(runsRed(odds, 100, 'fail')).toBeCloseTo(0.1458, 4);
    // The floor is its false failures alone, as under --inconclusive warn: 80 attempts leave little else.
    expect(runsRed(odds, 100, 'warn')).toBeCloseTo(0.1435, 4);
    // With 40, the inconclusive goldens turn 61% of runs red; with 20, all of them.
    expect(runsRed(gateOdds(sprt({ max: 40 }), 0.95), 100)).toBeCloseTo(0.6068, 4);
    expect(runsRed(gateOdds(SPEC, 0.95), 100)).toBeGreaterThan(0.9999);
    expect(runsRed(gateOdds(SPEC, 0.95), 100, 'warn')).toBeCloseTo(0.1334, 4);
  });
});

describe('decideCount', () => {
  it('passes at the bar, fails once the bar is out of reach, and never says inconclusive', () => {
    expect(decideCount(4, 4, 5, 4)).toBe('pass');
    expect(decideCount(3, 4, 5, 4)).toBe('continue');
    expect(decideCount(1, 3, 5, 4)).toBe('fail');
    expect(decideCount(2, 5, 5, 4)).toBe('fail');
    expect(decideCount(0, 0, 5, 2)).toBe('continue');
  });
});

describe('wilson', () => {
  it('matches the score interval: 18 of 20 at 95% is 0.70 to 0.97', () => {
    const w = wilson(18, 20, 0.95);
    // As statistics libraries give it (z = 1.959963984540054).
    expect(w.lo).toBeCloseTo(0.6989663548, 8);
    expect(w.hi).toBeCloseTo(0.9721335188, 8);
  });

  it('has the right width at the edges, where the normal approximation would say 0 width', () => {
    expect(wilson(0, 10, 0.95)).toEqual({ lo: 0, hi: expect.closeTo(0.2775327999, 8) });
    expect(wilson(10, 10, 0.95)).toEqual({ lo: expect.closeTo(0.7224672001, 8), hi: 1 });
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });

  it('narrows with more attempts and widens with more confidence', () => {
    expect(wilson(90, 100).lo).toBeGreaterThan(wilson(9, 10).lo);
    expect(wilson(9, 10, 0.99).lo).toBeLessThan(wilson(9, 10, 0.9).lo);
  });

  it('refuses what is no tally', () => {
    expect(() => wilson(3, 2)).toThrow(RangeError);
    expect(() => wilson(1.5, 2)).toThrow(RangeError);
    expect(() => wilson(1, 2, 1)).toThrow(RangeError);
  });
});

describe('normalQuantile', () => {
  it('is the inverse of the normal CDF to nine digits', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963985, 8);
    expect(normalQuantile(0.95)).toBeCloseTo(1.644853627, 8);
    expect(normalQuantile(0.5)).toBe(0);
    expect(normalQuantile(0.005)).toBeCloseTo(-2.575829304, 8);
    expect(normalQuantile(0.2)).toBeCloseTo(-normalQuantile(0.8), 9);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe('passHatK', () => {
  it('is C(c,k)/C(n,k), the chance of passing all of k tries', () => {
    expect(passHatK(18, 20, 5)).toBeCloseTo(8568 / 15504, 12);
    expect(passHatK(18, 20, 1)).toBe(0.9);
    expect(passHatK(18, 20, 2)).toBeCloseTo((18 * 17) / (20 * 19), 12);
    expect(passHatK(20, 20, 8)).toBe(1);
    expect(passHatK(3, 20, 5)).toBe(0);
    expect(passHatK(7, 20, 0)).toBe(1);
  });

  it('is lower than the pass rate to the kth power would say from the same tally', () => {
    // It is unbiased: (18/20)^5 = 0.59 overstates it from 20 attempts.
    expect(passHatK(18, 20, 5)!).toBeLessThan(0.9 ** 5);
  });

  it('has no estimate with fewer attempts than k', () => {
    expect(passHatK(3, 3, 5)).toBeNull();
    expect(passHatK(0, 0, 1)).toBeNull();
    expect(() => passHatK(5, 3, 1)).toThrow(RangeError);
  });
});

describe('the Beta distribution', () => {
  it('has the CDFs of its closed forms', () => {
    for (const x of [0.1, 0.33, 0.5, 0.79, 0.95]) {
      expect(betaCdf(x, 1, 1)).toBeCloseTo(x, 12);
      expect(betaCdf(x, 2, 3)).toBeCloseTo(6 * x ** 2 - 8 * x ** 3 + 3 * x ** 4, 12);
      expect(betaCdf(x, 3, 2)).toBeCloseTo(4 * x ** 3 - 3 * x ** 4, 12);
      expect(betaCdf(x, 1, 4)).toBeCloseTo(1 - (1 - x) ** 4, 12);
    }
    expect(betaCdf(0, 2, 2)).toBe(0);
    expect(betaCdf(1, 2, 2)).toBe(1);
  });

  it('is the binomial tail: I_p(k, n−k+1) = P(X ≥ k)', () => {
    for (const [n, k, p] of [
      [5, 4, 0.95],
      [20, 18, 0.9],
      [400, 370, 0.94],
      [60, 3, 0.02],
    ] as const) {
      expect(betaCdf(p, k, n - k + 1)).toBeCloseTo(binomialTail(n, k, p), 9);
    }
  });

  it('is symmetric: I_x(a, b) = 1 − I_{1−x}(b, a), and its density integrates to its CDF', () => {
    expect(betaCdf(0.3, 7.5, 2.25)).toBeCloseTo(1 - betaCdf(0.7, 2.25, 7.5), 12);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += betaPdf((i + 0.5) * (0.6 / n), 4, 9) * (0.6 / n);
    expect(sum).toBeCloseTo(betaCdf(0.6, 4, 9), 7);
    expect(lnGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(lnGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
  });
});

describe('dropProbability: the beta-binomial comparison with history', () => {
  it('is (1 − drop)² / 2 when neither rate is known yet', () => {
    expect(dropProbability({ passes: 0, attempts: 0 }, { passes: 0, attempts: 0 }, 0.15)).toBeCloseTo(0.85 ** 2 / 2, 7);
    expect(dropProbability({ passes: 0, attempts: 0 }, { passes: 0, attempts: 0 }, 0.5)).toBeCloseTo(0.125, 7);
  });

  it('compares with a golden that always passes when there is no history', () => {
    expect(dropProbability({ passes: 1, attempts: 3 }, null, 0.15)).toBeCloseTo(betaCdf(0.85, 2, 3), 12);
    expect(dropProbability({ passes: 0, attempts: 1 }, null, 0.15)).toBeCloseTo(1 - 0.15 ** 2, 12);
  });

  it('nears the chance under a known baseline once the history is long', () => {
    // 9,400 of 10,000: the baseline's posterior is all but a point at 0.94.
    const q = dropProbability({ passes: 2, attempts: 3 }, { passes: 9400, attempts: 10000 }, 0.15);
    expect(q).toBeCloseTo(betaCdf(0.94 - 0.15, 3, 2), 2);
  });

  it('falls as more attempts pass now, as the history passes less, and as the drop grows', () => {
    const base = { passes: 47, attempts: 50 };
    const now = [0, 1, 2, 3].map((s) => dropProbability({ passes: s, attempts: 3 }, base, 0.15));
    expect(now).toEqual([...now].sort((a, b) => b - a));
    expect(dropProbability({ passes: 2, attempts: 3 }, { passes: 30, attempts: 50 }, 0.15)).toBeLessThan(dropProbability({ passes: 2, attempts: 3 }, base, 0.15));
    expect(dropProbability({ passes: 2, attempts: 3 }, base, 0.3)).toBeLessThan(dropProbability({ passes: 2, attempts: 3 }, base, 0.15));
    expect(dropProbability({ passes: 2, attempts: 3 }, base, 1)).toBe(0);
  });
});

describe('the baseline gate', () => {
  const history = { passes: 47, attempts: 50, sessions: 10 };

  it('continues until min attempts, then decides after each one', () => {
    const g = baseline();
    expect(decide(0, 0, g, history)).toBe('continue');
    expect(decide(4, 4, g, history)).toBe('continue');
    // At 5: all passing shows no drop; two failures or more show one; in between, one more attempt.
    expect(decide(5, 5, g, history)).toBe('pass');
    expect(decide(4, 5, g, history)).toBe('continue');
    expect(decide(3, 5, g, history)).toBe('continue');
    expect(decide(2, 5, g, history)).toBe('fail');
    expect(decide(0, 5, g, history)).toBe('fail');
    // One failure among them is made up for by two more passes: 5 of 6 is still a coin toss (51%), 6 of 7 shows no drop.
    expect(decide(5, 6, g, history)).toBe('continue');
    expect(decide(6, 7, g, history)).toBe('pass');
  });

  it('fails when P(now < baseline − drop) > 1 − risk, passes once it is 1/2 or less, and runs another attempt in between', () => {
    const g = baseline();
    expect(BASELINE_PASS_AT).toBe(0.5);
    for (let n = g.min; n <= 12; n++) {
      for (let s = 0; s <= n; s++) {
        const q = dropProbability({ passes: s, attempts: n }, history, g.drop);
        expect(decide(s, n, g, history), `${s} of ${n}`).toBe(q > 1 - g.risk ? 'fail' : q <= BASELINE_PASS_AT ? 'pass' : 'continue');
      }
    }
  });

  it('is inconclusive when max runs out between the two, and only then', () => {
    const g = baseline();
    expect(g.max).toBe(40);
    // 29 of 40 against 47 of 50: a drop likelier than not (77%), short of 95%.
    expect(dropProbability({ passes: 29, attempts: 40 }, history, g.drop)).toBeCloseTo(0.7727, 4);
    expect(decide(29, 39, g, history)).toBe('continue');
    expect(decide(29, 40, g, history)).toBe('inconclusive');
    expect(decide(32, 40, g, history)).toBe('pass');
    expect(decide(25, 40, g, history)).toBe('fail');
  });

  it('lets an unchanged agent pass after exactly min attempts, nearly every time', () => {
    // An agent that passes every attempt: exactly its 5, against any history of its own.
    for (const past of [history, { passes: 50, attempts: 50, sessions: 10 }, { passes: 95, attempts: 100, sessions: 10 }, null]) {
      expect(gateOdds(baseline(), 1, past)).toEqual({ pass: 1, fail: 0, inconclusive: 0, attempts: BASELINE_DEFAULTS.min });
    }
    // One that passes 95% of the time: 99.9% pass, after 5.7 attempts on average, 5 in 77% of runs.
    const odds = gateOdds(baseline(), 0.95, history);
    expect(odds.pass).toBeCloseTo(0.9986, 4);
    expect(odds.fail).toBeCloseTo(0.0014, 4);
    expect(odds.attempts).toBeCloseTo(5.67, 2);
    expect(0.95 ** 5).toBeCloseTo(0.774, 3);
  });

  it('keeps its false failures well under risk with every look counted', () => {
    // An agent passing as often as its history says, asked after every attempt from min to max.
    for (const [p, past, most] of [
      [0.94, { passes: 47, attempts: 50 }, 0.0025],
      [0.95, { passes: 95, attempts: 100 }, 0.0026],
      [0.8, { passes: 40, attempts: 50 }, 0.011],
      [0.6, { passes: 30, attempts: 50 }, 0.015],
    ] as const) {
      const odds = gateOdds(baseline(), p, past);
      expect(odds.fail, `${p} against ${past.passes} of ${past.attempts}`).toBeLessThan(most);
      expect(odds.fail).toBeLessThan(BASELINE_DEFAULTS.risk);
    }
  });

  it('catches a drop: the chance it fails, by the pass rate now', () => {
    // Against 47 of 50: what the docs' power table says.
    const fails = Object.fromEntries([0.95, 0.85, 0.75, 0.6, 0.5, 0.2].map((p) => [p, gateOdds(baseline(), p, history).fail]));
    expect(fails[0.95]).toBeCloseTo(0.0014, 4);
    expect(fails[0.85]).toBeCloseTo(0.0458, 4);
    expect(fails[0.75]).toBeCloseTo(0.2420, 4);
    expect(fails[0.6]).toBeCloseTo(0.7375, 4);
    expect(fails[0.5]).toBeCloseTo(0.9121, 4);
    expect(fails[0.2]).toBeCloseTo(0.9994, 4);
    // Deciding once at 5 attempts caught a 60% golden 32% of the time and a 50% one 50%; 4 of 5,
    // which fails a healthy agent 16 times as often, catches them 66% and 81% of the time.
    const once = baseline({ max: 5 });
    expect(gateOdds(once, 0.6, history).fail).toBeCloseTo(0.3174, 4);
    expect(gateOdds(once, 0.5, history).fail).toBeCloseTo(0.5, 4);
    expect(countOdds(5, 4, 0.6).fail).toBeCloseTo(0.6630, 4);
    expect(fails[0.6]).toBeGreaterThan(countOdds(5, 4, 0.6).fail);
    expect(fails[0.5]).toBeGreaterThan(countOdds(5, 4, 0.5).fail);
    expect(countOdds(5, 4, 0.95).fail / fails[0.95]).toBeGreaterThan(15);
  });

  it('without history, compares with its recording: the one attempt it was packed from, which passed', () => {
    expect(RECORDING_BASELINE).toEqual({ passes: 1, attempts: 1 });
    const g = baseline();
    expect(decide(3, 5, g, null)).toBe(decide(3, 5, g, RECORDING_BASELINE));
    expect(decide(3, 5, g, { passes: 0, attempts: 0, sessions: 0 })).toBe('pass');
    expect(decide(0, 5, g, null)).toBe('continue');
    // So it never flakes on a healthy agent, and fails one that collapsed, after 14 straight failures.
    expect(gateOdds(g, 0.95, null).fail).toBeLessThan(1e-12);
    expect(gateOdds(g, 0.95, null).attempts).toBeCloseTo(5.0027, 4);
    expect(gateOdds(g, 0, null)).toEqual({ pass: 0, fail: 1, inconclusive: 0, attempts: 14 });
    // It says little: an agent that passes 30% of the time mostly ends inconclusive.
    expect(gateOdds(g, 0.3, null).inconclusive).toBeCloseTo(0.7786, 4);
  });
});

describe('what a label rounds to', () => {
  it('never says a bound is surer, or a risk smaller, than worked out: confidences round down, risks up, on a grid', () => {
    // A probe at a sixth of 5% is 99.17% sure: 99.1%, where rounding to the nearest said 99.2%.
    expect(confidencePercent(1 - 0.05 / 6)).toBe('99.1%');
    expect(percent(1 - 0.05 / 6)).toBe('99.2%');
    expect([confidencePercent(0.95), confidencePercent(1 - 0.05 / 8), confidencePercent(0.9995)]).toEqual(['95%', '99.3%', '99.9%']);
    expect([riskPercent(0.05), riskPercent(0.0525), riskPercent(0.087), riskPercent(0.0005), riskPercent(0.000437)]).toEqual(['5%', '5.3%', '8.7%', '0.05%', '0.044%']);
    expect(riskPercent(0.08704)).toBe('8.8%');
    const read = (label: string) => Number(label.replace('%', '')) / 100;
    for (let i = 1; i < 100_000; i += 7) {
      const x = i / 100_000;
      expect(read(confidencePercent(x)), String(x)).toBeLessThanOrEqual(x + 1e-12);
      expect(read(riskPercent(x)), String(x)).toBeGreaterThanOrEqual(x - 1e-12);
    }
  });

  it('prints a bound and a history gate’s rule at a confidence no higher than the gate’s', () => {
    // A gate at a ninth of 5%: 99.44% sure, read 99.4%.
    const g = sprt({ risk: 0.05 / 9 });
    expect(rateBound(gateResult(g, Array(attemptsToPass(g)).fill(true)))).toMatch(/\(99\.4%\)$/);
    const h: BaselineGate = { kind: 'baseline', ...BASELINE_DEFAULTS, risk: 0.00045 };
    expect(describeGate(h)).toContain('once 99.955% likely');
    expect(describeGate({ ...h, risk: 1 / 600 })).toContain('once 99.833% likely');
  });
});

describe('parseGate', () => {
  const where = 'shadowlap.config.json: tests["goldens/refund-*"].gate';

  it('reads the SPRT gate, with every figure optional', () => {
    expect(parseGate({ good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, where)).toEqual(SPEC);
    expect(parseGate({}, where)).toEqual(sprt());
    expect(parseGate({}, where)).toEqual({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 });
    expect(parseGate({ good: 0.95 }, where)).toEqual(sprt({ good: 0.95 }));
    expect(parseGate({}, where, BLAME_DEFAULTS)).toEqual(sprt({ ...BLAME_DEFAULTS }));
  });

  it('reads the history gate, defaulting to a 15-point drop over the last 10 sessions, from 5 attempts up to 40', () => {
    expect(parseGate({ baseline: 'history' }, where)).toEqual({ kind: 'baseline', drop: 0.15, risk: 0.05, window: 10, min: 5, max: 40 });
    expect(parseGate({ baseline: 'history', drop: 0.2, risk: 0.01, window: 5, min: 4, max: 12 }, where)).toEqual({ kind: 'baseline', drop: 0.2, risk: 0.01, window: 5, min: 4, max: 12 });
    // A min above the default max keeps room past it.
    expect(parseGate({ baseline: 'history', min: 50 }, where)).toMatchObject({ min: 50, max: 50 });
  });

  it('says what is wrong, where', () => {
    expect(() => parseGate(3, where)).toThrow(`${where} must be an object`);
    expect(() => parseGate({ good: 0.9, passes: 3 }, where)).toThrow(`${where} has an unknown key "passes" (expected "good", "bad", "risk", "max")`);
    expect(() => parseGate({ baseline: 'history', good: 0.9 }, where)).toThrow(`${where} has an unknown key "good" (expected "baseline", "drop", "risk", "window", "min", "max")`);
    expect(() => parseGate({ baseline: 'last-week' }, where)).toThrow(`${where}.baseline must be "history"`);
    expect(() => parseGate({ good: 1.2 }, where)).toThrow(`${where}.good must be a number between 0 and 1, such as 0.9: the pass rate it passes at`);
    expect(() => parseGate({ risk: 0.5 }, where)).toThrow(`${where}.risk must be below 0.5: the most a verdict may be wrong`);
    expect(() => parseGate({ risk: 0 }, where)).toThrow(`${where}.risk must be a number between 0 and 0.5, such as 0.05`);
    expect(() => parseGate({ max: 2.5 }, where)).toThrow(`${where}.max must be a whole number from 1 to 1000: the most attempts it runs`);
    expect(() => parseGate({ good: 0.7, bad: 0.9 }, where)).toThrow(`${where}: bad (0.9) must be below good (0.7)`);
    expect(() => parseGate({ max: 5 }, where)).toThrow(`${where}: max (5) is fewer than the 12 attempts an agent that always passes needs`);
    expect(() => parseGate({ baseline: 'history', window: 0 }, where)).toThrow(`${where}.window must be a whole number from 1 to 1000: how many past sessions make the baseline`);
    expect(() => parseGate({ baseline: 'history', min: 10, max: 8 }, where)).toThrow(`${where}: max (8) is fewer than min (10)`);
  });

  it('words its errors as the stand-ins written before it did, so their tests hold against it', () => {
    expect(() => parseGate({ good: 1.2, bad: 0.5, risk: 0.05, max: 5 }, 'g')).toThrow('g.good must be a number between 0 and 1');
    expect(() => parseGate({ good: 0.9, bad: 0.5, risk: 0.6, max: 5 }, 'g')).toThrow('g.risk must be below 0.5');
    expect(() => parseGate({ good: 0.9, bad: 0.5, risk: 0.05, max: 0 }, 'g')).toThrow('g.max must be a whole number from 1 to 1000');
    expect(() => parseGate({ good: 0.9, bad: 0.5, risk: 0.05, max: 5, min: 1 }, 'g')).toThrow('unknown key "min"');
    expect(() => parseGate({ good: 0.5, bad: 0.7 }, '--gate')).toThrow('--gate: bad (0.7) must be below good (0.5)');
  });
});

describe('what the reports say', () => {
  // The verdict word, the tally, the bound and the rule, stated once: never a claimed rate, since a
  // gate bounds its error only at its two rates. The bound is exact under the gate's stopping
  // (stats-bounds.test.ts proves its coverage).
  it('in one line, for each verdict', () => {
    expect(gateResult(SPEC, Array(12).fill(true)).sentence).toBe('passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
    expect(gateResult(SPEC, [false, false, false]).sentence).toBe('failed · 0 of 3 · rate <= 0.71 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
    // An order the gate reaches 20 attempts by: 16 straight passes would have passed it at 12.
    const mixed = path('FFTTFTTTTFTTTTTTTTTT');
    expect(gateResult(SPEC, mixed).sentence).toBe('inconclusive · 16 of 20 · rate 0.56 to 0.95 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
    expect(gateResult(SPEC, [true], { clean: true }).sentence).toBe('passed · 1 of 1 · a clean replay, the same every time, so its one attempt settles it');
    // Cut short, it stopped by no rule of its own: the interval holds however the attempts stopped.
    expect(gateResult(SPEC, [true, true], { decision: 'continue' }).sentence).toBe('undecided · 2 of 2 · rate 0.12 to 1.00 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
    // Without the rule, for a report that states it once above its lines.
    expect(verdictLine(gateResult(SPEC, Array(12).fill(true)))).toBe('passed · 12 of 12 · rate >= 0.73 (95%)');
    for (const r of [gateResult(SPEC, Array(12).fill(true)), gateResult(SPEC, mixed), gateResult(baseline(), Array(5).fill(true))]) expect(r.sentence).not.toMatch(/at least|at most|of the time|confidence/);
  });

  it('for the history gate, with its baseline', () => {
    const history = { passes: 47, attempts: 50, sessions: 10 };
    const g = baseline();
    const rule = 'gate: fails a drop of 15+ points from its last 10 sessions once 95% likely, from 5 attempts up to 40';
    expect(gateResult(g, Array(5).fill(true), { history }).sentence).toBe(`passed · 5 of 5 · rate >= 0.47 (95%) · against 0.94 over the last 10 sessions (47 of 50) · ${rule}`);
    expect(gateResult(g, [true, false, true, false, false], { history }).sentence).toBe(`failed · 2 of 5 · rate <= 0.86 (95%) · against 0.94 over the last 10 sessions (47 of 50) · ${rule}`);
    expect(gateResult(g, path('FFTTTFTTFTTFTTFTTFTTFTTFTTFTTFTTTTTTTTTT'), { history }).sentence).toBe(`inconclusive · 29 of 40 · rate 0.40 to 0.88 (95%) · against 0.94 over the last 10 sessions (47 of 50) · ${rule}`);
    expect(gateResult(g, [true, true, true, true, false], { history }).sentence).toBe(`undecided · 4 of 5 · rate 0.21 to 1.00 (95%) · against 0.94 over the last 10 sessions (47 of 50) · ${rule}`);
    expect(gateResult(g, [true, true], { history }).sentence).toBe(`undecided · 2 of 2 · rate 0.12 to 1.00 (95%) · against 0.94 over the last 10 sessions (47 of 50) · ${rule}`);
    expect(gateResult(g, Array(5).fill(true)).sentence).toBe(`passed · 5 of 5 · rate >= 0.47 (95%) · against its recording (no history yet) · ${rule}`);
    expect(gateResult(g, Array(5).fill(true), { history: { ...history, sessions: 1 } }).sentence).toContain('against 0.94 over its last session (47 of 50)');
  });

  it('counts attempts carried over from a session it continued', () => {
    const r = gateResult(SPEC, [...Array(16).fill(true), false, false, false, false, true, true], { carried: 20 });
    expect(r.carried).toBe(20);
    expect(r.outcomes).toHaveLength(22);
    expect(r.attempts).toBe(22);
    expect(gateResult(SPEC, [true]).carried).toBeUndefined();
    // Carried over from another session, it gets the interval that holds however the attempts stopped.
    expect(gateResult(sprt({ max: 40 }), [...Array(16).fill(true), false, false, false, false, ...Array(22).fill(true)].slice(0, 26), { carried: 20, decision: 'continue' }).sentence).toBe('undecided · 22 of 26 (20 carried over) · rate 0.56 to 0.98 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 40 attempts');
  });

  it('counts apart the attempts the provider was unavailable for, which its tally and bound leave out', () => {
    const r = gateResult(SPEC, Array(12).fill(true), { unavailable: 2 });
    expect(r).toMatchObject({ unavailable: 2, passes: 12, attempts: 12, decision: 'pass' });
    // The same bound as without them: they are no evidence either way.
    expect(r.interval).toEqual(gateResult(SPEC, Array(12).fill(true)).interval);
    expect(r.sentence).toBe('passed · 12 of 12 (2 unavailable, not counted) · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
    expect(verdictLine({ ...r, carried: 4 })).toBe('passed · 12 of 12 (4 carried over; 2 unavailable, not counted) · rate >= 0.73 (95%)');
    expect(gateResult(SPEC, Array(12).fill(true)).unavailable).toBeUndefined();
    // Three in a row before any counted: nothing decided, and no rate to show.
    expect(gateResult(SPEC, [], { unavailable: 3, decision: 'continue' }).sentence).toBe('undecided · 0 of 0 (3 unavailable, not counted) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
  });

  it('shows the evidence: the tally, the interval and pass^k', () => {
    // Two failures first, then passes: the gate reaches its 20th attempt still between its bounds.
    const r = gateResult(SPEC, path('FFTTTTTTTTTTTTTTTTTT'));
    // The end of the interval that explains the verdict: the low end for a pass, the high end for a failure, both otherwise.
    expect(formatTally({ ...r, decision: 'pass' })).toBe('18 of 20 passed · rate >= 0.67 (95%) · pass^5 0.55');
    expect(r.decision).toBe('inconclusive');
    expect(formatTally(r)).toBe('18 of 20 passed · rate 0.67 to 0.99 (95%) · pass^5 0.55');
    expect(formatPassK(r)).toBe('pass^5 0.55');
    expect(formatPassK(gateResult(SPEC, [true, true]))).toBeNull();
    expect(formatTally(gateResult(SPEC, [false, false, false]))).toBe('0 of 3 passed · rate <= 0.71 (95%)');
    expect(formatTally(gateResult(SPEC, [true], { clean: true }))).toBe('1 of 1 passed · a clean replay, the same every time');
    expect(r.passK.map((x) => x.k)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.interval).toEqual({ lo: expect.closeTo(0.6727, 4), hi: expect.closeTo(0.9855, 4), confidence: 0.95 });
    expect(r.bound).toEqual({ lo: r.interval.lo, hi: r.interval.hi, confidence: 0.95, method: 'stagewise' });
    expect(formatTally(gateResult(SPEC, [true, true, false]))).toBe('2 of 3 passed · rate 0.06 to 1.00 (95%)');
  });

  it('keeps the running score after each attempt, against both bounds', () => {
    const r = gateResult(SPEC, [true, false, true]);
    if (r.evidence.kind !== 'sprt') throw new Error('an SPRT gate keeps its scores');
    const b = sprtBounds(SPEC);
    expect(r.evidence).toMatchObject({ upper: b.upper, lower: b.lower, pass: b.pass, fail: b.fail });
    const want = [b.pass, b.pass + b.fail, 2 * b.pass + b.fail];
    r.evidence.scores.forEach((score, i) => expect(score).toBeCloseTo(want[i], 14));
    expect(r.evidence.scores).toHaveLength(3);
    expect(r.decision).toBe('continue');
  });

  it('carries the gate\'s own figures, so a result reads as the gate it was decided by', () => {
    const r = gateResult(SPEC, [true, true, true]);
    expect(r).toMatchObject({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20, decision: 'continue', passes: 3, attempts: 3, outcomes: [true, true, true], clean: false });
    expect(gateOf(r)).toEqual(SPEC);
    expect(decide(r.passes, r.attempts, r)).toBe('continue');
    expect(gateOf(gateResult(baseline(), [true]))).toEqual(baseline());
  });

  it('keeps what the history gate compared, and the chance of a drop after each attempt from min on', () => {
    const history = { passes: 47, attempts: 50, sessions: 10 };
    const r = gateResult(baseline({ min: 3 }), [true, true, true, false], { history });
    const want = [3, 4].map((n) => dropProbability({ passes: 3, attempts: n }, history, 0.15));
    expect(r.evidence).toEqual({ kind: 'baseline', history, baseline: 0.94, probability: want[1], probabilities: [null, null, want[0], want[1]], threshold: 0.95, passAt: 0.5 });
    expect(r.outcomes).toEqual([true, true, true, false]);
    // Without history: the recording, one attempt that passed.
    expect(gateResult(baseline(), [true]).evidence).toMatchObject({ history: null, baseline: 1, probability: null, probabilities: [null] });
  });

  it('describes a gate by its rule, in the words Settings will preview it in', () => {
    expect(describeGate(SPEC)).toBe('tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
    expect(describeGate(sprt({ good: 0.875, bad: 0.5, risk: 0.1, max: 1 }))).toBe('tells 87.5%+ from 50%- at <= 10% risk, up to 1 attempt');
    expect(describeGate(baseline())).toBe('fails a drop of 15+ points from its last 10 sessions once 95% likely, from 5 attempts up to 40');
    const one = gateResult(SPEC, [true]);
    expect(gateSentence(SPEC, { ...one, decision: 'pass' })).toBe('passed · 1 of 1 · rate >= 0.02 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 20 attempts');
    expect(rateBound({ attempts: 0, interval: { lo: 0, hi: 1, confidence: 0.95 }, decision: 'pass' })).toBeNull();
  });
});
