import { describe, expect, it } from 'vitest';
import { BASELINE_DEFAULTS, SPRT_DEFAULTS, describeGate, gateOdds, type BaselineGate, type SprtGate } from '../src/stats.js';
import { INCONCLUSIVE_AT_GOOD, SUITE_RISK, planSuite, type SuiteGolden } from '../src/suite.js';

/**
 * A test session's one risk, split across its gated goldens: what each gate becomes, that every
 * share is kept exactly, and what the forecast says before anything runs.
 */
const sprt = (o: Partial<Omit<SprtGate, 'kind'>> = {}): SprtGate => ({ kind: 'sprt', ...SPRT_DEFAULTS, ...o });
const history = (o: Partial<Omit<BaselineGate, 'kind'>> = {}): BaselineGate => ({ kind: 'baseline', ...BASELINE_DEFAULTS, ...o });
const goldens = (n: number, g: Partial<SuiteGolden> = {}): SuiteGolden[] => Array.from({ length: n }, (_, i) => ({ golden: `goldens/g${i}`, gate: sprt(), maxGiven: false, ...g }));

describe('planSuite', () => {
  it('leaves a single golden as it was: its own gate keeps within 5%', () => {
    const plan = planSuite(goldens(1))!;
    expect(plan).toMatchObject({ risk: SUITE_RISK, perGoldenRisk: 0.05, goldens: 1, method: 'bonferroni', inconclusive: 'fail' });
    expect(plan.planned[0]!.gate).toEqual(sprt());
    expect(describeGate(plan.planned[0]!.gate)).toBe('tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    // Red for nothing at its good rate: 3.3% failed and 0.9% inconclusive, within its 5%.
    const odds = gateOdds(sprt(), 0.9);
    expect(plan.planned[0]!.red).toBeCloseTo(odds.fail + odds.inconclusive, 12);
    expect(plan.red).toBeLessThanOrEqual(0.05);
  });

  it('gives each of several goldens its share for a failure, keeps the risk for a pass, and sizes max', () => {
    for (const n of [2, 10, 100]) {
      const plan = planSuite(goldens(n))!;
      const share = 0.05 / n;
      expect(plan.perGoldenRisk).toBeCloseTo(share, 15);
      for (const p of plan.planned) {
        const g = p.gate as SprtGate;
        expect(g).toMatchObject({ good: 0.9, bad: 0.7, risk: 0.05 });
        expect(g.failRisk).toBeLessThan(0.05);
        // Exactly: at its good rate, red (failed or inconclusive) within its share, and at most 1% inconclusive.
        const odds = gateOdds(g, 0.9);
        expect(odds.fail + odds.inconclusive).toBeLessThanOrEqual(share);
        expect(odds.inconclusive).toBeLessThanOrEqual(Math.min(INCONCLUSIVE_AT_GOOD, share / 2));
        expect(p.red).toBeCloseTo(odds.fail + odds.inconclusive, 12);
        // Its failRisk is two significant digits, rounded down: a figure a person can read.
        expect(String(g.failRisk)).toMatch(/^0\.0*[1-9]\d?$/);
      }
      expect(plan.red).toBeLessThanOrEqual(0.05);
    }
  });

  it('keeps a max the config set, and says when it leaves too many inconclusive for the share', () => {
    const plan = planSuite(goldens(10, { gate: sprt({ max: 20 }), maxGiven: true }))!;
    const p = plan.planned[0]!;
    expect(p.gate.max).toBe(20);
    expect(p.over).toMatch(/^its max of 20 leaves \d+(\.\d+)?% of attempts at its good rate inconclusive, more than its 0\.5% share of the suite's risk: raise its max/);
    // The red rate it reports is what it is, not what the share asked for.
    expect(plan.red).toBeGreaterThan(0.05);
    // A max the config set that leaves room is kept, with the share for a failure.
    const roomy = planSuite(goldens(10, { gate: sprt({ max: 300 }), maxGiven: true }))!.planned[0]!;
    expect(roomy.gate.max).toBe(300);
    expect(roomy.over).toBeUndefined();
    expect(roomy.red).toBeLessThanOrEqual(0.005);
  });

  it('under --inconclusive warn, spends the share on failures alone', () => {
    const plan = planSuite(goldens(10), { inconclusive: 'warn' })!;
    const g = plan.planned[0]!.gate as SprtGate;
    const odds = gateOdds(g, 0.9);
    expect(odds.fail).toBeLessThanOrEqual(0.005);
    expect(odds.inconclusive).toBeLessThanOrEqual(INCONCLUSIVE_AT_GOOD);
    expect(plan.planned[0]!.red).toBeCloseTo(odds.fail, 12);
  });

  it('gives a gate against history its share as its risk, and works out its red rate at its baseline\'s pass rate', () => {
    const base = { passes: 47, attempts: 50 };
    const one = planSuite([{ golden: 'goldens/h', gate: history(), maxGiven: false, history: base }])!.planned[0]!;
    // One golden: unchanged.
    expect(one.gate).toEqual(history());
    expect(one.at).toBeCloseTo(0.94, 12);
    const plan = planSuite(Array.from({ length: 20 }, (_, i) => ({ golden: `goldens/h${i}`, gate: history(), maxGiven: false, history: base })))!;
    const g = plan.planned[0]!.gate as BaselineGate;
    expect(g.risk).toBeLessThanOrEqual(0.0025);
    const odds = gateOdds(g, 0.94, base);
    expect(odds.fail + odds.inconclusive).toBeLessThanOrEqual(0.0025);
    expect(plan.planned[0]!.red).toBeCloseTo(odds.fail + odds.inconclusive, 12);
    expect(describeGate(g)).toMatch(/once 99\.\d+% likely/);
  });

  it('forecasts the attempts on average and at most, and their cost, at each golden\'s recent rate', () => {
    const plan = planSuite([
      { golden: 'goldens/a', gate: sprt(), maxGiven: false, rate: 1, costPerAttempt: 0.01 },
      { golden: 'goldens/b', gate: sprt(), maxGiven: false, rate: null, costPerAttempt: 0.02 },
      { golden: 'goldens/c', gate: sprt(), maxGiven: false, rate: 0.95, costPerAttempt: null },
    ])!;
    const [a, b, c] = plan.planned;
    // An agent that always passes needs 12; one with no recent results is forecast at its good rate.
    expect(a!.attempts).toBeCloseTo(12, 12);
    expect(b!.forecastAt).toBe(0.9);
    expect(b!.attempts).toBeCloseTo(gateOdds(b!.gate, 0.9).attempts, 12);
    expect(c!.cost).toBeNull();
    expect(plan.forecast.attempts).toBeCloseTo(a!.attempts + b!.attempts + c!.attempts, 9);
    expect(plan.forecast.most).toBe(a!.most + b!.most + c!.most);
    expect(plan.forecast.cost).toBeCloseTo(a!.attempts * 0.01 + b!.attempts * 0.02, 9);
    expect(plan.forecast.unpriced).toBe(1);
  });

  it('plans nothing without a gated golden, and refuses a risk that is no risk', () => {
    expect(planSuite([])).toBeNull();
    expect(() => planSuite(goldens(2), { risk: 0.5 })).toThrow('the suite risk must be above 0 and below 0.5');
    expect(() => planSuite(goldens(2), { risk: 0 })).toThrow();
  });
});
