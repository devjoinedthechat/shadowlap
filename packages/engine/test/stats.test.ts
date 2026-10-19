import { describe, expect, it } from 'vitest';
import {
  BASELINE_DEFAULTS,
  BLAME_DEFAULTS,
  SPRT_DEFAULTS,
  attemptsToFail,
  attemptsToPass,
  betaCdf,
  betaPdf,
  binomialTail,
  countOdds,
  decide,
  decideCount,
  describeGate,
  dropProbability,
  formatTally,
  gateOdds,
  gateResult,
  gateSentence,
  lnGamma,
  normalQuantile,
  parseGate,
  passHatK,
  passesPerFailure,
  percent,
  sprtBounds,
  sprtScore,
  sprtStep,
  wilson,
  type BaselineGate,
  type SprtGate,
} from '../src/stats.js';

const sprt = (o: Partial<Omit<SprtGate, 'kind'>> = {}): SprtGate => ({ kind: 'sprt', ...SPRT_DEFAULTS, ...o });
const baseline = (o: Partial<Omit<BaselineGate, 'kind'>> = {}): BaselineGate => ({ kind: 'baseline', ...BASELINE_DEFAULTS, ...o });
/** The spec's figures: pass at 90% or more, fail at 70% or less, 5% risk each, give up after 20. */
const SPEC = sprt({ good: 0.9, bad: 0.7, risk: 0.05, max: 20 });

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
  it('adds ln(good/bad) for a pass and ln((1−good)/(1−bad)) for a failure, between ±ln((1−risk)/risk)', () => {
    const b = sprtBounds(SPEC);
    expect(b.pass).toBeCloseTo(Math.log(0.9 / 0.7), 14);
    expect(b.fail).toBeCloseTo(Math.log(0.1 / 0.3), 14);
    expect(b.upper).toBeCloseTo(Math.log(19), 14);
    expect(b.lower).toBe(-b.upper);
    expect(b.pass).toBeCloseTo(0.2513144, 7);
    expect(b.fail).toBeCloseTo(-1.0986123, 7);
    expect(b.upper).toBeCloseTo(2.9444390, 7);
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
    // Four failures outweigh a pass: 0.25 − 4.39 is below −2.94.
    expect(decide(1, 5, SPEC)).toBe('fail');
  });

  it('is inconclusive when max runs out between the bounds, and only then', () => {
    expect(decide(16, 19, SPEC)).toBe('continue');
    expect(decide(16, 20, SPEC)).toBe('inconclusive');
    expect(decide(16, 20, { ...SPEC, max: 40 })).toBe('continue');
    expect(decide(0, 0, SPEC)).toBe('continue');
  });

  it('keeps each verdict wrong at most risk of the time, as Wald bounds it, at good and at bad', () => {
    for (const g of [SPEC, sprt(), sprt({ good: 0.95, bad: 0.8, risk: 0.1, max: 60 }), sprt({ ...BLAME_DEFAULTS })]) {
      const bound = g.risk / (1 - g.risk);
      expect(gateOdds(g, g.good).fail, describeGate(g)).toBeLessThanOrEqual(bound);
      expect(gateOdds(g, g.bad).pass, describeGate(g)).toBeLessThanOrEqual(bound);
    }
  });

  it('gives exact odds and attempts: every way it can end, adding up to 1', () => {
    const always = gateOdds(SPEC, 1);
    expect(always).toEqual({ pass: 1, fail: 0, inconclusive: 0, attempts: 12 });
    expect(gateOdds(SPEC, 0)).toEqual({ pass: 0, fail: 1, inconclusive: 0, attempts: 3 });
    const healthy = gateOdds(SPEC, 0.95);
    expect(healthy.pass + healthy.fail + healthy.inconclusive).toBeCloseTo(1, 12);
    // A 95% agent: wrongly failed 0.16% of the time where 4 of 5 fails it 2.26%, at 15.2 attempts.
    expect(healthy.fail).toBeCloseTo(0.0016, 4);
    expect(healthy.attempts).toBeCloseTo(15.16, 2);
    // With 20 attempts one failure can be made up for, two can't: a fifth of 95% agents end inconclusive.
    expect(healthy.inconclusive).toBeCloseTo(0.2072, 4);
    // The default, 40, leaves under 1% of them inconclusive for 1.4 more attempts on average.
    const roomier = gateOdds(sprt(), 0.95);
    expect(roomier.inconclusive).toBeLessThan(0.01);
    expect(roomier.attempts).toBeCloseTo(16.55, 2);
    // A 70% agent gets through 2% of the time, not 53%.
    expect(gateOdds(SPEC, 0.7).pass).toBeCloseTo(0.0222, 4);
  });

  it('settles what 2 of 5 settled for blame, at the same cost, and says how sure it is', () => {
    const g = sprt({ ...BLAME_DEFAULTS });
    expect(attemptsToPass(g)).toBe(2);
    expect(attemptsToFail(g)).toBe(4);
    expect(decide(2, 2, g)).toBe('pass');
    expect(decide(0, 4, g)).toBe('fail');
    // A pass and three failures: no verdict yet, where 2 of 5 would call it lost already only after 4.
    expect(decide(1, 4, g)).toBe('continue');
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

  it('continues until min attempts, then decides once', () => {
    const g = baseline({ min: 3 });
    expect(decide(0, 0, g, history)).toBe('continue');
    expect(decide(0, 2, g, history)).toBe('continue');
    expect(decide(3, 3, g, history)).toBe('pass');
    expect(decide(2, 3, g, history)).toBe('pass');
    expect(decide(1, 3, g, history)).toBe('fail');
    expect(decide(0, 3, g, history)).toBe('fail');
  });

  it('fails when P(now < baseline − drop) > 1 − risk', () => {
    const g = baseline({ min: 3 });
    for (let s = 0; s <= 3; s++) {
      const q = dropProbability({ passes: s, attempts: 3 }, history, g.drop);
      expect(decide(s, 3, g, history)).toBe(q > 1 - g.risk ? 'fail' : 'pass');
    }
  });

  it('without history, compares with a golden that always passes', () => {
    expect(decide(2, 3, baseline({ min: 3 }), null)).toBe('pass');
    expect(decide(1, 3, baseline({ min: 3 }), null)).toBe('fail');
    expect(decide(1, 3, baseline({ min: 3 }), { passes: 0, attempts: 0, sessions: 0 })).toBe('fail');
    // At its default of 5 attempts, that is the 4 of 5 it replaces.
    expect(decide(4, 5, baseline(), null)).toBe('pass');
    expect(decide(3, 5, baseline(), null)).toBe('fail');
    expect(gateOdds(baseline(), 0.95, null).fail).toBeCloseTo(1 - binomialTail(5, 4, 0.95), 12);
  });

  it('lets an unchanged agent pass after exactly min attempts, nearly every time', () => {
    for (const p of [0.8, 0.95, 1]) {
      const past = { passes: Math.round(p * 100), attempts: 100, sessions: 10 };
      const odds = gateOdds(baseline(), p, past);
      expect(odds.attempts, `p ${p}`).toBeCloseTo(BASELINE_DEFAULTS.min, 12);
      expect(odds.pass, `p ${p}`).toBeGreaterThan(0.97);
      expect(odds.inconclusive).toBe(0);
    }
  });

  it('fails a golden whose pass rate collapsed', () => {
    expect(gateOdds(baseline({ min: 5 }), 0.2, { passes: 95, attempts: 100 }).fail).toBeGreaterThan(0.9);
  });
});

describe('parseGate', () => {
  const where = 'shadowlap.config.json: tests["goldens/refund-*"].gate';

  it('reads the SPRT gate, with every figure optional', () => {
    expect(parseGate({ good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, where)).toEqual(SPEC);
    expect(parseGate({}, where)).toEqual(sprt());
    expect(parseGate({ good: 0.95 }, where)).toEqual(sprt({ good: 0.95 }));
    expect(parseGate({}, where, BLAME_DEFAULTS)).toEqual(sprt({ ...BLAME_DEFAULTS }));
  });

  it('reads the history gate, defaulting to a 15-point drop over the last 10 sessions after 5 attempts', () => {
    expect(parseGate({ baseline: 'history' }, where)).toEqual({ kind: 'baseline', drop: 0.15, risk: 0.05, window: 10, min: 5 });
    expect(parseGate({ baseline: 'history', drop: 0.2, risk: 0.01, window: 5, min: 4 }, where)).toEqual({ kind: 'baseline', drop: 0.2, risk: 0.01, window: 5, min: 4 });
  });

  it('says what is wrong, where', () => {
    expect(() => parseGate(3, where)).toThrow(`${where} must be an object`);
    expect(() => parseGate({ good: 0.9, passes: 3 }, where)).toThrow(`${where} has an unknown key "passes" (expected "good", "bad", "risk", "max")`);
    expect(() => parseGate({ baseline: 'history', max: 3 }, where)).toThrow(`${where} has an unknown key "max" (expected "baseline", "drop", "risk", "window", "min")`);
    expect(() => parseGate({ baseline: 'last-week' }, where)).toThrow(`${where}.baseline must be "history"`);
    expect(() => parseGate({ good: 1.2 }, where)).toThrow(`${where}.good must be the pass rate it passes`);
    expect(() => parseGate({ risk: 0.5 }, where)).toThrow(`${where}.risk must be the most a verdict may be wrong: a number between 0 and 0.5`);
    expect(() => parseGate({ max: 2.5 }, where)).toThrow(`${where}.max must be the most attempts it runs: a whole number from 1 to 1000`);
    expect(() => parseGate({ good: 0.7, bad: 0.9 }, where)).toThrow(`${where}: bad (0.9) must be below good (0.7)`);
    expect(() => parseGate({ max: 5 }, where)).toThrow(`${where}: max (5) is fewer than the 12 attempts an agent that always passes needs`);
    expect(() => parseGate({ baseline: 'history', window: 0 }, where)).toThrow(`${where}.window must be how many past sessions make the baseline`);
  });
});

describe('what the reports say', () => {
  it('in one sentence, for each verdict', () => {
    expect(gateResult(SPEC, Array(12).fill(true)).sentence).toBe('passed: at least 90% with 95% confidence after 12 attempts');
    expect(gateResult(SPEC, [false, false, false]).sentence).toBe('failed: at most 70% with 95% confidence after 3 attempts');
    const mixed = [...Array(16).fill(true), false, false, false, false];
    expect(gateResult(SPEC, mixed).sentence).toBe('inconclusive: neither at least 90% nor at most 70% with 95% confidence after 20 attempts, the most the gate runs');
    expect(gateResult(SPEC, [true], { clean: true }).sentence).toBe('passed: a clean replay comes out the same every time, so its one attempt settles it');
    expect(gateResult(SPEC, [true, true], { decision: 'continue' }).sentence).toBe('undecided after 2 attempts: between 70% and 90% so far');
  });

  it('for the history gate, with its baseline', () => {
    const history = { passes: 47, attempts: 50, sessions: 10 };
    const g = baseline({ min: 3 });
    expect(gateResult(g, [true, true, true], { history }).sentence).toBe('passed: no drop of 15 points or more from its baseline, 0.92 over the last 10 sessions (47 of 50 attempts), with 95% confidence after 3 attempts');
    expect(gateResult(g, [false, true, false], { history }).sentence).toBe('failed: its pass rate dropped 15 points or more from its baseline, 0.92 over the last 10 sessions (47 of 50 attempts), with 95% confidence after 3 attempts');
    expect(gateResult(g, [true, true, true]).sentence).toBe('passed: no drop of 15 points or more from its baseline, a golden that always passes, since it has no history yet, with 95% confidence after 3 attempts');
  });

  it('shows the evidence: the tally, the interval and pass^k', () => {
    const r = gateResult(SPEC, [...Array(18).fill(true), false, false]);
    expect(formatTally(r)).toBe('18 of 20 passed · pass rate ≥ 0.70 (95%, Wilson) · pass^5 0.55');
    expect(r.passK.map((x) => x.k)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.interval).toEqual({ lo: expect.closeTo(0.699, 3), hi: expect.closeTo(0.972, 3), confidence: 0.95 });
    expect(formatTally(gateResult(SPEC, [true, true, false]))).toBe('2 of 3 passed · pass rate ≥ 0.21 (95%, Wilson)');
  });

  it('keeps the running score after each attempt, against both bounds', () => {
    const r = gateResult(SPEC, [true, false, true]);
    if (r.evidence.kind !== 'sprt') throw new Error('an SPRT gate keeps its scores');
    const b = sprtBounds(SPEC);
    expect(r.evidence).toMatchObject({ upper: b.upper, lower: b.lower, pass: b.pass, fail: b.fail });
    const want = [b.pass, b.pass + b.fail, 2 * b.pass + b.fail];
    r.evidence.scores.forEach((score, i) => expect(score).toBeCloseTo(want[i]!, 14));
    expect(r.evidence.scores).toHaveLength(3);
    expect(r.decision).toBe('continue');
  });

  it('keeps what the history gate compared', () => {
    const r = gateResult(baseline({ min: 3 }), [true, true, true], { history: { passes: 47, attempts: 50, sessions: 10 } });
    expect(r.evidence).toEqual({ kind: 'baseline', history: { passes: 47, attempts: 50, sessions: 10 }, baseline: 48 / 52, probability: expect.any(Number), threshold: 0.95 });
    expect(gateResult(baseline(), [true]).evidence).toMatchObject({ history: null, baseline: 1, probability: null });
  });

  it('describes a gate in the words Settings will preview it in', () => {
    expect(describeGate(SPEC)).toBe('pass at 90% or more, fail at 70% or less, at most 5% risk of the wrong verdict, up to 20 attempts');
    expect(describeGate(baseline())).toBe('fail on a drop of 15 points or more from the pass rate of the last 10 sessions, at 95% confidence, after 5 attempts');
    expect(gateSentence({ gate: SPEC, decision: 'pass', attempts: 1, clean: false, evidence: gateResult(SPEC, [true]).evidence })).toBe('passed: at least 90% with 95% confidence after 1 attempt');
  });
});
