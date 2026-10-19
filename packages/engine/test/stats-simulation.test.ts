import { describe, expect, it } from 'vitest';
import { BASELINE_DEFAULTS, SPRT_DEFAULTS, countOdds, decide, decideCount, gateOdds, runsRed, type BaselineGate, type Gate, type GateDecision, type GateHistory, type GateOdds, type SprtGate } from '../src/stats.js';

/**
 * A healthy agent, one that passes 95% of the time, behind 100 forked goldens in CI: how often each
 * gate fails a CI run for nothing. A fixed 4 of 5 fails about 2 goldens a run, and at least one in
 * about 90% of runs; a gate that states its risk should fail almost none, and say what it costs in
 * attempts. Under `--inconclusive fail`, the default, an inconclusive golden turns the run red too,
 * so a run is red when any golden failed or is inconclusive. Seeded, so every run of this test sees
 * the same coin flips; the exact odds (gateOdds, runsRed) say what the simulation should come close to.
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

type Simulated = ReturnType<typeof simulate>;
const runs = (n: number) => n / CI_RUNS;
const perGolden = (n: number) => n / (CI_RUNS * GOLDENS);
/** Runs red under `--inconclusive fail` (a golden failed or is inconclusive), and under `warn` (one failed). */
const red = (s: Simulated, mode: 'fail' | 'warn') => s.perRun.filter((x) => x.failed > 0 || (mode === 'fail' && x.inconclusive > 0)).length / CI_RUNS;
const pct = (x: number) => `${Math.round(100 * x)}%`;
const row = (name: string, s: Simulated, exact: GateOdds) =>
  [
    name.padEnd(34),
    runs(s.total.failed).toFixed(2).padStart(7),
    runs(s.total.inconclusive).toFixed(2).padStart(13),
    pct(red(s, 'fail')).padStart(9),
    pct(red(s, 'warn')).padStart(9),
    perGolden(s.total.attempts).toFixed(2).padStart(9),
    exact.attempts.toFixed(2).padStart(9),
    `   ${pct(runsRed(exact, GOLDENS, 'fail'))} / ${pct(runsRed(exact, GOLDENS, 'warn'))}`,
  ].join(' ');

describe('a simulated 95% agent across 100 goldens', () => {
  const fixed = simulate((s, n) => decideCount(s, n, 5, 4), 1);
  const sprtDefault: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
  const sprt40: SprtGate = { ...sprtDefault, max: 40 };
  const sprt20: SprtGate = { ...sprtDefault, max: 20 };
  const gated = simulate((s, n) => decide(s, n, sprtDefault), 2);
  const gated40 = simulate((s, n) => decide(s, n, sprt40), 3);
  const gated20 = simulate((s, n) => decide(s, n, sprt20), 4);
  // The history gate: each golden's baseline is its last 10 sessions of 5 attempts, from the same agent.
  const history: GateHistory[] = (() => {
    const random = seeded(5);
    return Array.from({ length: GOLDENS }, () => {
      let passes = 0;
      for (let i = 0; i < 50; i++) if (random() < AGENT) passes++;
      return { passes, attempts: 50, sessions: 10 };
    });
  })();
  const baselineGate: BaselineGate = { kind: 'baseline', ...BASELINE_DEFAULTS };
  // Its decisions don't depend on the coin flips, only on the tally: each worked out once per golden.
  const decided = new Map<string, GateDecision>();
  const baselined = simulate((s, n, g) => {
    const key = `${g}:${s}:${n}`;
    if (!decided.has(key)) decided.set(key, decide(s, n, baselineGate, history[g]));
    return decided.get(key)!;
  }, 6);

  const exact = (gate: Gate) => gateOdds(gate, AGENT);
  const fixedExact = countOdds(5, 4, AGENT);
  // The history gate's odds differ by golden, with its history: per golden, averaged; a run is red unless every golden is clean.
  const perHistory = history.map((h) => gateOdds(baselineGate, AGENT, h));
  const baselineExact: GateOdds = perHistory.reduce((acc, o) => ({ pass: acc.pass + o.pass / GOLDENS, fail: acc.fail + o.fail / GOLDENS, inconclusive: acc.inconclusive + o.inconclusive / GOLDENS, attempts: acc.attempts + o.attempts / GOLDENS }), { pass: 0, fail: 0, inconclusive: 0, attempts: 0 });
  const baselineRed = (mode: 'fail' | 'warn') => 1 - perHistory.reduce((p, o) => p * (1 - o.fail - (mode === 'fail' ? o.inconclusive : 0)), 1);

  it('prints what each gate costs and how often it turns a healthy agent\'s CI run red', () => {
    const lines = [
      `${CI_RUNS} CI runs of ${GOLDENS} forked goldens, the agent passing ${AGENT * 100}% of the time (seeded):`,
      `${'gate'.padEnd(34)} ${'failed'.padStart(7)} ${'inconclusive'.padStart(13)} ${'red'.padStart(9)} ${'red warn'.padStart(9)} ${'attempts'.padStart(9)} ${'expected'.padStart(9)}   exact red / red warn`,
      row('4 of 5 (verify before gates)', fixed, fixedExact),
      row('sprt 0.9 / 0.7 / 0.05, max 80', gated, exact(sprtDefault)),
      row('sprt 0.9 / 0.7 / 0.05, max 40', gated40, exact(sprt40)),
      row('sprt 0.9 / 0.7 / 0.05, max 20', gated20, exact(sprt20)),
      `${row('history, 15-point drop, 5 to 40', baselined, baselineExact).replace(/ {3}\d+% \/ \d+%$/, '')}   ${pct(baselineRed('fail'))} / ${pct(baselineRed('warn'))}`,
      '(failed and inconclusive: goldens per CI run; red: runs with a golden that failed or, under --inconclusive fail, the default,',
      ' is inconclusive; red warn: under --inconclusive warn; attempts: per golden, simulated and expected)',
    ];
    console.log(lines.join('\n'));
    expect(lines).toHaveLength(9);
  });

  it('a fixed 4 of 5 fails about 2 goldens a run, and leaves about 90% of runs red', () => {
    expect(runs(fixed.total.failed)).toBeGreaterThan(1.8);
    expect(runs(fixed.total.failed)).toBeLessThan(2.8);
    expect(red(fixed, 'fail')).toBeGreaterThan(0.8);
    expect(perGolden(fixed.total.failed)).toBeCloseTo(fixedExact.fail, 2);
    expect(runsRed(fixedExact, GOLDENS)).toBeCloseTo(0.898, 3);
  });

  it('the default gate fails far fewer, and turns about a sixth of runs red, inconclusive goldens counted', () => {
    const odds = exact(sprtDefault);
    // Under a fifth of 4 of 5's spurious failures; exactly, 0.17 per run against 2.26.
    expect(gated.total.failed * 5).toBeLessThan(fixed.total.failed);
    expect(odds.fail * GOLDENS).toBeLessThan(0.2);
    expect(perGolden(gated.total.failed)).toBeCloseTo(odds.fail, 2);
    expect(perGolden(gated.total.inconclusive)).toBeCloseTo(odds.inconclusive, 3);
    // Red runs as --inconclusive fail counts them: about 16%, where 4 of 5 is 90%.
    expect(runsRed(odds, GOLDENS, 'fail')).toBeCloseTo(0.156, 3);
    expect(Math.abs(red(gated, 'fail') - runsRed(odds, GOLDENS, 'fail'))).toBeLessThan(0.07);
    expect(red(gated, 'fail')).toBeLessThan(red(fixed, 'fail') / 3);
    // About 16.6 attempts a golden, the price of telling 90% from 70% at 5% risk.
    expect(perGolden(gated.total.attempts)).toBeCloseTo(odds.attempts, 0);
    expect(odds.attempts).toBeCloseTo(16.61, 1);
  });

  it('with less room, it fails as few but leaves goldens inconclusive, which turn runs red by default', () => {
    // max 40: 0.75% of goldens inconclusive, so 60% of runs red; under warn, the false failures alone.
    expect(gated40.total.failed * 5).toBeLessThan(fixed.total.failed);
    expect(runsRed(exact(sprt40), GOLDENS, 'fail')).toBeCloseTo(0.60, 2);
    expect(Math.abs(red(gated40, 'fail') - runsRed(exact(sprt40), GOLDENS, 'fail'))).toBeLessThan(0.1);
    expect(red(gated40, 'warn')).toBeLessThan(0.3);
    // max 20: a fifth of the goldens inconclusive, every run red.
    expect(perGolden(gated20.total.inconclusive)).toBeCloseTo(exact(sprt20).inconclusive, 1);
    expect(exact(sprt20).inconclusive).toBeGreaterThan(0.2);
    expect(red(gated20, 'fail')).toBe(1);
  });

  it('the history gate fails about as few as the default gate, at a third of its attempts', () => {
    // A tenth of 4 of 5's spurious failures: exactly 0.22 per run, against each golden's own history.
    expect(baselineExact.fail * GOLDENS).toBeLessThan(0.3);
    expect(baselined.total.failed * 8).toBeLessThan(fixed.total.failed);
    expect(perGolden(baselined.total.failed)).toBeCloseTo(baselineExact.fail, 2);
    expect(perGolden(baselined.total.inconclusive)).toBeLessThan(0.001);
    // 5 attempts, and one or two more when its first 5 had a failure: 5.7 on average.
    expect(perGolden(baselined.total.attempts)).toBeCloseTo(baselineExact.attempts, 1);
    expect(baselineExact.attempts).toBeLessThan(6);
    expect(Math.abs(red(baselined, 'fail') - baselineRed('fail'))).toBeLessThan(0.07);
    expect(red(baselined, 'fail')).toBeLessThan(red(fixed, 'fail') / 3);
  });
});
