import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASELINE_DEFAULTS, RECORDING_BASELINE, SPRT_DEFAULTS, decide, describeGate, dropProbability, gateOdds, lnGamma, type BaselineGate, type SprtGate, type Tally } from '../src/stats.js';
import { DECLINE_AT, INCONCLUSIVE_AT_GOOD, PLANNED_FAILURES, SUITE_RISK, planSuite, type SuiteGolden } from '../src/suite.js';

/**
 * A test session's one risk, split across its gated goldens: what each gate becomes, that every
 * share is kept exactly, and what the forecast says before anything runs.
 */
const PAGE = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
const sprt = (o: Partial<Omit<SprtGate, 'kind'>> = {}): SprtGate => ({ kind: 'sprt', ...SPRT_DEFAULTS, ...o });
const history = (o: Partial<Omit<BaselineGate, 'kind'>> = {}): BaselineGate => ({ kind: 'baseline', ...BASELINE_DEFAULTS, ...o });
const goldens = (n: number, g: Partial<SuiteGolden> = {}): SuiteGolden[] => Array.from({ length: n }, (_, i) => ({ golden: `goldens/g${i}`, gate: sprt(), maxGiven: false, ...g }));

/**
 * A gate against history's chance of going red for an agent drawn from the rates `seen` leaves
 * open, one failure more, attempt by attempt (a beta-binomial), worked out the plain way: every tally
 * it can reach, each asked of `decide` against the baseline `h`.
 */
function walkOver(gate: BaselineGate, h: Tally | null, seen: Tally | null): { red: number; attempts: number } {
  const shown = seen ?? RECORDING_BASELINE;
  const yes = 1 + shown.passes;
  const no = 1 + PLANNED_FAILURES + shown.attempts - shown.passes;
  let walking = new Map<number, number>([[0, 1]]);
  let passed = 0;
  // Attempts run on average: one for each attempt the gate is still going into.
  let attempts = 0;
  for (let n = 1; n <= gate.max; n++) {
    const next = new Map<number, number>();
    for (const [s, m] of walking) {
      attempts += m;
      const up = (yes + s) / (yes + no + n - 1);
      for (const [s2, q] of [
        [s + 1, up],
        [s, 1 - up],
      ] as const) {
        const d = decide(s2, n, gate, h);
        if (d === 'pass') passed += m * q;
        else if (d === 'continue') next.set(s2, (next.get(s2) ?? 0) + m * q);
      }
    }
    walking = next;
  }
  return { red: 1 - passed, attempts };
}
const redOver = (gate: BaselineGate, h: Tally | null, seen: Tally | null): number => walkOver(gate, h, seen).red;
const attemptsOver = (gate: BaselineGate, h: Tally | null, seen: Tally | null): number => walkOver(gate, h, seen).attempts;

describe('planSuite', () => {
  it('leaves a single golden as it was: its own gate keeps within 5%', () => {
    const plan = planSuite(goldens(1))!;
    expect(plan).toMatchObject({ risk: SUITE_RISK, perGoldenRisk: 0.05, goldens: 1, method: 'bonferroni', inconclusive: 'fail' });
    expect(plan.planned[0].gate).toEqual(sprt());
    expect(describeGate(plan.planned[0].gate)).toBe('tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    // Red for nothing at its good rate: 3.3% failed and 0.9% inconclusive, within its 5%.
    const odds = gateOdds(sprt(), 0.9);
    expect(plan.planned[0].red).toBeCloseTo(odds.fail + odds.inconclusive, 12);
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
    const p = plan.planned[0];
    expect(p.gate.max).toBe(20);
    expect(p.over).toMatch(/^its max of 20 leaves \d+(\.\d+)?% of attempts at its good rate inconclusive, more than its 0\.5% share of the suite's risk: raise its max/);
    // The red rate it reports is what it is, not what the share asked for.
    expect(plan.red).toBeGreaterThan(0.05);
    // A max the config set that leaves room is kept, with the share for a failure.
    const roomy = planSuite(goldens(10, { gate: sprt({ max: 300 }), maxGiven: true }))!.planned[0];
    expect(roomy.gate.max).toBe(300);
    expect(roomy.over).toBeUndefined();
    expect(roomy.red).toBeLessThanOrEqual(0.005);
  });

  it('under --inconclusive warn, spends the share on failures alone', () => {
    const plan = planSuite(goldens(10), { inconclusive: 'warn' })!;
    const g = plan.planned[0].gate as SprtGate;
    const odds = gateOdds(g, 0.9);
    expect(odds.fail).toBeLessThanOrEqual(0.005);
    expect(odds.inconclusive).toBeLessThanOrEqual(INCONCLUSIVE_AT_GOOD);
    expect(plan.planned[0].red).toBeCloseTo(odds.fail, 12);
  });

  it('gives a gate against history its share as its risk, and works out its red rate over every pass rate its sessions leave open', () => {
    const base = { passes: 47, attempts: 50 };
    const one = planSuite([{ golden: 'goldens/h', gate: history(), maxGiven: false, history: base }])!.planned[0];
    // One golden: its gate as it was, within the whole 5%, worked out around the mean of the rates its baseline leaves open, one failure more;
    // past its own max, should it be raised, a pass held to its record, here its baseline, as a caller that gives no record has it.
    expect(one.gate).toEqual({ ...history(), widened: { from: BASELINE_DEFAULTS.max, record: base, risk: BASELINE_DEFAULTS.risk } });
    expect(one.red).toBeCloseTo(redOver(history(), base, base), 12);
    expect(one.red).toBeLessThanOrEqual(0.05);
    expect(one.at).toBeCloseTo(48 / 53, 12);
    // What it costs is forecast over the same rates, its mean, exactly.
    expect(one.forecastAt).toBeCloseTo(48 / 53, 12);
    expect(one.attempts).toBeCloseTo(attemptsOver(one.gate as BaselineGate, base, base), 9);
    // 30 sessions a little below what the baseline shows: more attempts than its own max, and past it a pass holds against that record too, at the gate's own risk.
    const record = { passes: 150, attempts: 170, sessions: 30 };
    const sessions = { passes: 51, attempts: 57 };
    const plan = planSuite(Array.from({ length: 20 }, (_, i) => ({ golden: `goldens/h${i}`, gate: history(), maxGiven: false, history: base, sessions, record })))!;
    const g = plan.planned[0].gate as BaselineGate;
    expect(g.risk).toBeLessThanOrEqual(0.0025);
    expect(g.max).toBeGreaterThan(BASELINE_DEFAULTS.max);
    expect(g.widened).toEqual({ from: BASELINE_DEFAULTS.max, record, risk: BASELINE_DEFAULTS.risk });
    expect(plan.planned[0].red).toBeCloseTo(redOver(g, base, record), 12);
    expect(plan.planned[0].red).toBeLessThanOrEqual(0.0025);
    expect(plan.planned[0].over).toBeUndefined();
    expect(describeGate(g)).toMatch(/once 99\.\d+% likely, from 5 attempts up to \d+, and past 40 passes only once that drop from every attempt of its last 30 sessions \(150 of 170\) is 5% likely or less$/);
    // As docs/gating.md shows the rule.
    expect(PAGE.includes(`\`gate: ${describeGate(g)}\``), 'docs/gating.md shows the widened rule').toBe(true);
    // With a record as good as its baseline, its own max does.
    const steady = planSuite(Array.from({ length: 20 }, (_, i) => ({ golden: `goldens/h${i}`, gate: history(), maxGiven: false, history: base, sessions: { passes: 53, attempts: 56 }, record: { passes: 160, attempts: 170, sessions: 30 } })))!.planned[0];
    expect(steady.gate).toEqual(history({ risk: 0.0025, widened: { from: 40, record: { passes: 160, attempts: 170, sessions: 30 }, risk: 0.05 } }));
    // Its rule says nothing of the record until its max comes past 40.
    expect(describeGate(steady.gate)).toBe('fails a drop of 15+ points from its last 10 sessions once 99.75% likely, from 5 attempts up to 40');
    expect(steady.red).toBeLessThanOrEqual(0.0025);
    // A caller that gives no record: its baseline is what the plan sizes for, and what a pass past 40 holds to.
    const bare = planSuite(Array.from({ length: 20 }, (_, i) => ({ golden: `goldens/h${i}`, gate: history(), maxGiven: false, history: base })))!.planned[0];
    expect((bare.gate as BaselineGate).widened).toEqual({ from: BASELINE_DEFAULTS.max, record: base, risk: BASELINE_DEFAULTS.risk });
    expect(bare.red).toBeCloseTo(redOver(bare.gate as BaselineGate, base, base), 12);
    expect(bare.over === undefined).toBe(bare.red <= 0.0025);
  });

  it('sizes a gate against history for the agent its record shows, those that went red included, and bounds a pass past its own max by that record', () => {
    const base = { passes: 47, attempts: 50 };
    // 30 sessions at about 82%, the last 10 a little better: a baseline that came out lucky, no drop.
    const record = { passes: 140, attempts: 170, sessions: 30 };
    const sessions = { passes: 51, attempts: 57 };
    expect(dropProbability(sessions, base, 0)).toBeLessThan(DECLINE_AT);
    const lucky: SuiteGolden = { golden: 'goldens/h', gate: history(), maxGiven: false, history: base, sessions, record };
    const p = planSuite(Array.from({ length: 20 }, () => lucky))!.planned[0];
    const g = p.gate as BaselineGate;
    expect(p.red).toBeCloseTo(redOver(g, base, record), 12);
    expect(p.red).toBeGreaterThan(0.0025);
    expect(p.over).toBe(`against its baseline (47 of 50) it goes red about ${+(100 * p.red).toPrecision(2)}% of the time, averaged over the pass rates its last 30 sessions leave open (140 of 170 attempts passed), where its share of the suite's risk is 0.25%: a baseline that came out lucky, or too short a one, to tell a drop from chance at that share`);
    // It runs at its share all the same, with every attempt it may, a pass past 40 held to its record.
    expect(g).toMatchObject({ risk: 0.0025, max: 400, widened: { from: 40, record, risk: 0.05 } });
    // Its forecast: the agent its last 10 sessions show, exactly, under the same rule.
    expect(p.forecastAt).toBeCloseTo((1 + 51) / (2 + PLANNED_FAILURES + 57), 12);
    expect(p.attempts).toBeCloseTo(attemptsOver(g, base, sessions), 9);
  });

  it('reads a drop when its last sessions sit below the sessions before them beyond chance at its share, and runs as its baseline asks, at its own max', () => {
    const base = { passes: 47, attempts: 50 };
    // 20 sessions as the baseline shows the agent, then 10 at about 70%.
    const record = { passes: 105 + 40, attempts: 112 + 56, sessions: 30 };
    const sessions = { passes: 40, attempts: 56 };
    expect(dropProbability(sessions, { passes: 105, attempts: 112 }, 0)).toBeGreaterThan(1 - 0.0025);
    const p = planSuite(Array.from({ length: 20 }, () => ({ golden: 'goldens/h', gate: history(), maxGiven: false, history: base, sessions, record })))!.planned[0];
    expect(p.drop).toBe('its last 10 sessions passed 40 of 56 attempts, below the 20 sessions before them, 105 of 112, beyond chance at its 0.25% share: a drop; it runs as its baseline asks, at its share, up to its 40 attempts');
    expect(PAGE.includes(`\`${p.drop}\``), 'docs/gating.md shows the drop').toBe(true);
    expect(p.over).toBeUndefined();
    // Raised past 40, a pass is held to the agent before the drop: the 20 sessions before its last 10.
    expect(p.gate).toEqual(history({ risk: 0.0025, widened: { from: 40, record: { passes: 105, attempts: 112, sessions: 20 }, before: 10, risk: 0.05 } }));
    expect(describeGate({ ...p.gate, max: 160 })).toContain('and past 40 passes only once that drop from every attempt of the 20 sessions before its last 10 (105 of 112) is 5% likely or less');
    // Its red rate, for the agent before the drop: the 20 sessions before its last 10.
    expect(p.red).toBeCloseTo(redOver(p.gate as BaselineGate, base, { passes: 105, attempts: 112 }), 12);
  });

  it('gives a golden whose last sessions sit below the sessions before them no more than its own max, and says its rates come from those', () => {
    const base = { passes: 47, attempts: 50 };
    const record = { passes: 100 + 51, attempts: 106 + 57, sessions: 30 };
    const sessions = { passes: 51, attempts: 57 };
    const below = dropProbability(sessions, { passes: 100, attempts: 106 }, 0);
    expect(below).toBeGreaterThan(DECLINE_AT);
    expect(below).toBeLessThan(1 - 0.0025);
    const p = planSuite(Array.from({ length: 20 }, () => ({ golden: 'goldens/h', gate: history(), maxGiven: false, history: base, sessions, record })))!.planned[0];
    expect(p.gate).toEqual(history({ risk: 0.0025, widened: { from: 40, record: { passes: 100, attempts: 106, sessions: 20 }, before: 10, risk: 0.05 } }));
    expect(p.red).toBeCloseTo(redOver(p.gate as BaselineGate, base, { passes: 100, attempts: 106 }), 12);
    if (p.red > 0.0025) expect(p.over).toContain('averaged over the pass rates the 20 sessions before its last 10 leave open (100 of 106 attempts passed)');
  });

  it('holds a pass past 40 to the record for a max the config set too, and works its red rate out under that rule', () => {
    const base = { passes: 47, attempts: 50 };
    const record = { passes: 150, attempts: 170, sessions: 30 };
    const p = planSuite(Array.from({ length: 20 }, () => ({ golden: 'goldens/h', gate: history({ max: 160 }), maxGiven: true, history: base, sessions: { passes: 51, attempts: 57 }, record })))!.planned[0];
    expect(p.gate).toEqual(history({ risk: 0.0025, max: 160, widened: { from: 40, record, risk: 0.05 } }));
    expect(p.red).toBeCloseTo(redOver(p.gate as BaselineGate, base, record), 12);
    // With none of its sessions in a record, there is nothing to hold it to.
    expect((planSuite([{ golden: 'goldens/h', gate: history({ max: 160 }), maxGiven: true }])!.planned[0].gate as BaselineGate).widened).toBeUndefined();
  });

  it('with fewer than its window of sessions, says it has too few yet when it can\'t keep within its share', () => {
    const base = { passes: 14, attempts: 15 };
    const record = { passes: 14, attempts: 15, sessions: 3 };
    const p = planSuite(Array.from({ length: 20 }, () => ({ golden: 'goldens/h', gate: history(), maxGiven: false, history: base, sessions: record, record })))!.planned[0];
    expect(p.over).toBeUndefined();
    expect(p.early).toBe(`only 3 sessions yet: against its baseline (14 of 15) it goes red about ${+(100 * p.red).toPrecision(2)}% of the time, averaged over the pass rates its last 3 sessions leave open (14 of 15 attempts passed), where its share of the suite's risk is 0.25%; sessions that pass make it surer`);
    expect(p.red).toBeCloseTo(redOver(p.gate as BaselineGate, base, record), 12);
  });

  it('with no history, compares a gate with its recording, at its own max, and says it has no baseline yet', () => {
    const p = planSuite(Array.from({ length: 20 }, (_, i) => ({ golden: `goldens/h${i}`, gate: history(), maxGiven: false })))!.planned[0];
    expect(p.early).toMatch(/^no baseline yet, only its recording, one attempt that passed: against that it goes red about 37% of the time, averaged over the pass rates that leaves open \(more for an agent that fails more often\), where its share of the suite's risk is 0\.25%; sessions that pass make it a baseline$/);
    expect(p.over).toBeUndefined();
    // No more attempts than its own max: against its recording, an agent that fails often can't pass however long it runs.
    expect(p.gate).toEqual(history({ risk: 0.0025 }));
    expect(p.red).toBeCloseTo(redOver(p.gate as BaselineGate, null, null), 12);
    // Its forecast: over the rates its recording leaves open, their mean a half, exactly.
    expect(p.forecastAt).toBeCloseTo(0.5, 12);
    expect(p.attempts).toBeCloseTo(attemptsOver(p.gate as BaselineGate, null, null), 9);
    expect(p.attempts).toBeGreaterThan(BASELINE_DEFAULTS.min);
    // Exactly, for a max the config set.
    const given = planSuite(Array.from({ length: 20 }, (_, i) => ({ golden: `goldens/h${i}`, gate: history({ max: 60 }), maxGiven: true })))!.planned[0];
    expect(given.gate.max).toBe(60);
    expect(given.red).toBeCloseTo(redOver(given.gate as BaselineGate, null, null), 12);
    expect(given.early).toBeDefined();
  });

  it('forecasts the attempts on average and at most, and their cost, at each golden\'s recent rate', () => {
    const plan = planSuite([
      { golden: 'goldens/a', gate: sprt(), maxGiven: false, rate: 1, costPerAttempt: 0.01 },
      { golden: 'goldens/b', gate: sprt(), maxGiven: false, rate: null, costPerAttempt: 0.02 },
      { golden: 'goldens/c', gate: sprt(), maxGiven: false, rate: 0.95, costPerAttempt: null },
    ])!;
    const [a, b, c] = plan.planned;
    // An agent that always passes needs 12; one with no recent results is forecast at its good rate.
    expect(a.attempts).toBeCloseTo(12, 12);
    expect(b.forecastAt).toBe(0.9);
    expect(b.attempts).toBeCloseTo(gateOdds(b.gate, 0.9).attempts, 12);
    expect(c.cost).toBeNull();
    expect(plan.forecast.attempts).toBeCloseTo(a.attempts + b.attempts + c.attempts, 9);
    expect(plan.forecast.most).toBe(a.most + b.most + c.most);
    expect(plan.forecast.cost).toBeCloseTo(a.attempts * 0.01 + b.attempts * 0.02, 9);
    expect(plan.forecast.unpriced).toBe(1);
  });

  it('plans nothing without a gated golden, and refuses a risk that is no risk', () => {
    expect(planSuite([])).toBeNull();
    expect(() => planSuite(goldens(2), { risk: 0.5 })).toThrow('the suite risk must be above 0 and below 0.5');
    expect(() => planSuite(goldens(2), { risk: 0 })).toThrow();
  });
});

describe('reading a drop, and holding a pass past 40, as docs/gating.md states them', () => {
  const lnChoose = (n: number, k: number) => lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1);
  const binomial = (n: number, k: number, p: number) => Math.exp(lnChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
  /**
   * The chance n attempts of an agent at p read as a drop against m earlier ones of the same agent, at
   * share r, exactly: for each count now, the earlier counts from which a drop is read, as the chance
   * of one only rises with them.
   */
  function falseDrops(n: number, m: number, p: number, r: number): number {
    let total = 0;
    for (let s = 0; s <= n; s++) {
      let from = m + 1;
      for (let lo = 0, hi = m; lo <= hi; ) {
        const mid = (lo + hi) >> 1;
        if (dropProbability({ passes: s, attempts: n }, { passes: mid, attempts: m }, 0) > 1 - r) {
          from = mid;
          hi = mid - 1;
        } else lo = mid + 1;
      }
      let tail = 0;
      for (let k = from; k <= m; k++) tail += binomial(m, k, p);
      total += binomial(n, s, p) * tail;
    }
    return total;
  }

  it('reads a drop from like tallies of one agent about as often as its share, at every rate', () => {
    const rates = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
    // The last 10 sessions' attempts against the 20 before them, at about 5.6 attempts a session.
    const level = rates.map((p) => falseDrops(56, 112, p, 0.0025));
    for (const [i, x] of level.entries()) expect(x, `at ${rates[i]}`).toBeLessThan(0.003);
    const pct = (x: number) => `${(100 * x).toFixed(2)}%`;
    const says = `two tallies of one agent, its last 10 sessions' 56 attempts against the 112 before them, read as a drop ${pct(Math.min(...level))} to ${pct(Math.max(...level))} of the time at a 0.25% share, at 50% to 95%`;
    expect(PAGE.includes(says), `docs/gating.md says: ${says}`).toBe(true);
  });

  it('holds a regressed agent continued past an inconclusive 40 to the agent before its drop', () => {
    const base = { passes: 48, attempts: 50 };
    const before = { passes: 107, attempts: 112, sessions: 20 };
    const at = (max: number, held: boolean): BaselineGate => history({ risk: 0.0025, max, ...(held ? { widened: { from: 40, record: before, before: 10, risk: 0.05 } } : {}) });
    const continued = (max: number, held: boolean) => {
      const at40 = gateOdds(at(40, held), 0.75, base);
      return (gateOdds(at(max, held), 0.75, base).pass - at40.pass) / at40.inconclusive;
    };
    const pct = (x: number, d: number) => `${(100 * x).toFixed(d)}%`;
    const says = `an agent at 75% passed ${pct(continued(80, false), 1)} of the time by 80 and ${pct(continued(160, false), 1)} by 160 under the plain rule, and held to the 20 sessions before its drop (107 of 112), ${pct(continued(80, true), 2)} and ${pct(continued(160, true), 2)}`;
    expect(PAGE.includes(says), `docs/gating.md says: ${says}`).toBe(true);
  });
});
