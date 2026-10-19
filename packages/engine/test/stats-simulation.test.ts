import { describe, expect, it } from 'vitest';
import { BASELINE_DEFAULTS, SPRT_DEFAULTS, countOdds, decide, decideCount, gateOdds, type BaselineGate, type Gate, type GateDecision, type GateHistory, type SprtGate } from '../src/stats.js';

/**
 * A healthy agent, one that passes 95% of the time, behind 100 forked goldens in CI: how often each
 * gate fails a CI run for nothing. A fixed 4 of 5 fails about 2 goldens a run, and at least one in
 * about 90% of runs; a gate that states its risk should fail almost none, and say what it costs in
 * attempts. Seeded, so every run of this test sees the same coin flips; the exact odds (gateOdds)
 * say what the simulation should come close to.
 */

/** mulberry32: a small, seeded generator with a period of 2^32. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const AGENT = 0.95;
const GOLDENS = 100;
const CI_RUNS = 300;

interface Outcome {
  /** Goldens the gate failed, though the agent is healthy: spurious failures. */
  failed: number;
  inconclusive: number;
  attempts: number;
}

/** One golden under a rule that is asked after every attempt and stops at its first answer. */
function oneGolden(rule: (passes: number, attempts: number) => GateDecision, flip: () => boolean): { decision: GateDecision; attempts: number } {
  let passes = 0;
  for (let n = 1; ; n++) {
    if (flip()) passes++;
    const d = rule(passes, n);
    if (d !== 'continue') return { decision: d, attempts: n };
  }
}

/** CI_RUNS runs of GOLDENS goldens, each golden a fresh sample of the agent. */
function simulate(rule: (passes: number, attempts: number, golden: number) => GateDecision, seed: number): { perRun: Outcome[]; total: Outcome } {
  const random = seeded(seed);
  const flip = () => random() < AGENT;
  const perRun: Outcome[] = [];
  for (let r = 0; r < CI_RUNS; r++) {
    const o: Outcome = { failed: 0, inconclusive: 0, attempts: 0 };
    for (let g = 0; g < GOLDENS; g++) {
      const { decision, attempts } = oneGolden((s, n) => rule(s, n, g), flip);
      if (decision === 'fail') o.failed++;
      if (decision === 'inconclusive') o.inconclusive++;
      o.attempts += attempts;
    }
    perRun.push(o);
  }
  const total = perRun.reduce((a, b) => ({ failed: a.failed + b.failed, inconclusive: a.inconclusive + b.inconclusive, attempts: a.attempts + b.attempts }), { failed: 0, inconclusive: 0, attempts: 0 });
  return { perRun, total };
}

const runs = (n: number) => n / CI_RUNS;
const perGolden = (n: number) => n / (CI_RUNS * GOLDENS);
const row = (name: string, s: ReturnType<typeof simulate>, exact: { fail: number; inconclusive: number; attempts: number }) =>
  `${name.padEnd(34)} ${runs(s.total.failed).toFixed(2).padStart(8)} ${`${Math.round((100 * s.perRun.filter((x) => x.failed > 0).length) / CI_RUNS)}%`.padStart(10)} ${runs(s.total.inconclusive).toFixed(2).padStart(13)} ${perGolden(s.total.attempts).toFixed(2).padStart(9)} ${(exact.attempts).toFixed(2).padStart(9)}   ${(100 * exact.fail).toFixed(2)}% / ${(100 * exact.inconclusive).toFixed(2)}%`;

describe('a simulated 95% agent across 100 goldens', () => {
  const fixed = simulate((s, n) => decideCount(s, n, 5, 4), 1);
  const sprtDefault: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
  const sprtSpec: SprtGate = { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20 };
  const gated = simulate((s, n) => decide(s, n, sprtDefault), 2);
  const spec = simulate((s, n) => decide(s, n, sprtSpec), 3);
  // The history gate: each golden's baseline is its last 10 sessions of 5 attempts, from the same agent.
  const history: GateHistory[] = (() => {
    const random = seeded(4);
    return Array.from({ length: GOLDENS }, () => {
      let passes = 0;
      for (let i = 0; i < 50; i++) if (random() < AGENT) passes++;
      return { passes, attempts: 50, sessions: 10 };
    });
  })();
  const baselineGate: BaselineGate = { kind: 'baseline', ...BASELINE_DEFAULTS };
  // It decides once, at min attempts, on one of min + 1 tallies: each worked out once per golden.
  const decided = new Map<string, GateDecision>();
  const baselined = simulate((s, n, g) => {
    const key = `${g}:${s}:${n}`;
    if (!decided.has(key)) decided.set(key, decide(s, n, baselineGate, history[g]));
    return decided.get(key)!;
  }, 5);

  const exact = (gate: Gate, h?: GateHistory) => gateOdds(gate, AGENT, h ?? null);
  const fixedExact = countOdds(5, 4, AGENT);
  const baselineExact = history.reduce(
    (acc, h) => {
      const o = exact(baselineGate, h);
      return { fail: acc.fail + o.fail / GOLDENS, inconclusive: 0, attempts: acc.attempts + o.attempts / GOLDENS };
    },
    { fail: 0, inconclusive: 0, attempts: 0 },
  );

  it('prints what each gate costs and how often it fails a healthy agent', () => {
    const lines = [
      `${CI_RUNS} CI runs of ${GOLDENS} forked goldens, the agent passing ${AGENT * 100}% of the time (seeded):`,
      `${'gate'.padEnd(34)} ${'failed'.padStart(8)} ${'runs red'.padStart(10)} ${'inconclusive'.padStart(13)} ${'attempts'.padStart(9)} ${'expected'.padStart(9)}   exact fail / inconclusive per golden`,
      row('4 of 5 (verify today)', fixed, fixedExact),
      row('sprt 0.9 / 0.7 / 0.05, max 40', gated, exact(sprtDefault)),
      row('sprt 0.9 / 0.7 / 0.05, max 20', spec, exact(sprtSpec)),
      row('history, 15-point drop, min 5', baselined, baselineExact),
      '(failed and inconclusive: goldens per CI run; attempts: per golden, simulated and expected)',
    ];
    console.log(lines.join('\n'));
    expect(lines).toHaveLength(7);
  });

  it('a fixed 4 of 5 fails about 2 goldens a run, and leaves about 90% of runs red', () => {
    expect(runs(fixed.total.failed)).toBeGreaterThan(1.8);
    expect(runs(fixed.total.failed)).toBeLessThan(2.8);
    expect(fixed.perRun.filter((x) => x.failed > 0).length / CI_RUNS).toBeGreaterThan(0.8);
    expect(perGolden(fixed.total.failed)).toBeCloseTo(fixedExact.fail, 2);
  });

  it('the SPRT gate fails far fewer, close to its exact odds, at the attempts it says', () => {
    const odds = exact(sprtDefault);
    // Under a fifth of 4 of 5's spurious failures; exactly, 0.17 per run against 2.26.
    expect(gated.total.failed * 5).toBeLessThan(fixed.total.failed);
    expect(odds.fail * GOLDENS).toBeLessThan(0.2);
    expect(perGolden(gated.total.failed)).toBeCloseTo(odds.fail, 2);
    expect(perGolden(gated.total.inconclusive)).toBeCloseTo(odds.inconclusive, 2);
    // About 16.5 attempts a golden, the price of telling 90% from 70% at 5% risk.
    expect(perGolden(gated.total.attempts)).toBeCloseTo(odds.attempts, 0);
    expect(odds.attempts).toBeCloseTo(16.55, 1);
  });

  it('with max 20, fails as few, but leaves a fifth of the goldens inconclusive', () => {
    expect(spec.total.failed * 5).toBeLessThan(fixed.total.failed);
    expect(perGolden(spec.total.inconclusive)).toBeCloseTo(exact(sprtSpec).inconclusive, 1);
    expect(exact(sprtSpec).inconclusive).toBeGreaterThan(0.2);
  });

  it('the history gate fails fewer still, after its 5 attempts and no more', () => {
    expect(baselined.total.failed * 10).toBeLessThan(fixed.total.failed);
    expect(baselined.total.inconclusive).toBe(0);
    expect(baselined.total.attempts).toBe(CI_RUNS * GOLDENS * BASELINE_DEFAULTS.min);
    expect(perGolden(baselined.total.failed)).toBeCloseTo(baselineExact.fail, 2);
  });
});
