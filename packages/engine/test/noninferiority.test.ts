import { describe, expect, it } from 'vitest';
import { addPair, clopperPearsonBound, decideAgainstHistory, decidePaired, describeBaselineRule, dropBound, historyDrop, historyOdds, KEPT_DEFAULTS, NO_PAIRS, pairedDrop, pairedOdds, pairedWorstCase, type BaselineRule, type PairCounts } from '../src/noninferiority.js';

/**
 * verify keeps a good run when it is not worse than its own baseline by the margin or more. The
 * claims these tests hold the code to, on the grid the review asked for (baselines of 75%, 85%, 90%
 * and 99%; drops of 0, 5, 10, 15 and 25 points):
 *
 * - P(kept | drop >= margin) <= risk, computed exactly over every count of pairs the test can see,
 *   and over every null at once, drift and correlation included (backward induction);
 * - the same by seeded simulation, with arms that drift together and are correlated, which the exact
 *   walk over independent arms doesn't cover and the e-process's guarantee does;
 * - the power at no drop, and the attempts each arm runs, printed as the table docs/verify.md shows.
 */

const RULE: BaselineRule = { ...KEPT_DEFAULTS, risk: 0.05 };
const BASES = [0.75, 0.85, 0.9, 0.99];
const DROPS = [0, 0.05, 0.1, 0.15, 0.25];

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

describe('the paired test, exactly', () => {
  it('keeps a run that dropped by the margin or more at most `risk` of the time, on the whole grid, and says what it costs', () => {
    const rows: string[] = [];
    for (const pb of BASES) {
      const cells: string[] = [];
      for (const drop of DROPS) {
        const o = pairedOdds(RULE, pb - drop, pb);
        expect(o.kept + o.broken + o.inconclusive).toBeCloseTo(1, 9);
        if (drop >= RULE.margin) expect(o.kept, `kept at a drop of ${drop} from ${pb}`).toBeLessThanOrEqual(RULE.risk);
        // Broken when nothing dropped: at most risk too.
        if (drop === 0) expect(o.broken, `broken at no drop from ${pb}`).toBeLessThanOrEqual(RULE.risk);
        cells.push(`${(100 * o.kept).toFixed(1).padStart(5)}% kept · ${(100 * o.broken).toFixed(1).padStart(5)}% broken · ${o.attempts.toFixed(0).padStart(3)}`);
      }
      rows.push(`${String(pb).padEnd(5)} ${cells.join(' | ')}`);
    }
    console.log(`paired, margin ${RULE.margin}, risk ${RULE.risk}, up to ${RULE.max} pairs; each cell: kept, broken, attempts per arm on average\nbase  ${DROPS.map((d) => `drop ${d}`.padEnd(33)).join('| ')}\n${rows.join('\n')}`);
    // The figures docs/verify.md quotes: power at no drop, and the attempts it takes.
    const at = (pb: number, drop: number) => pairedOdds(RULE, pb - drop, pb);
    expect(at(0.99, 0).kept).toBeGreaterThan(0.999);
    expect(at(0.99, 0).attempts).toBeCloseTo(46, 0);
    expect(at(0.9, 0).kept).toBeCloseTo(0.791, 2);
    expect(at(0.9, 0).attempts).toBeCloseTo(114, 0);
    expect(at(0.75, 0).kept).toBeCloseTo(0.48, 2);
    expect(Math.max(...BASES.map((pb) => at(pb, 0.1).kept))).toBeCloseTo(0.038, 2);
  });

  it('keeps that error under `risk` for every null at once: drift, correlation, any strategy that sees the pairs before', () => {
    // Ville's inequality bounds both by risk; backward induction says how close they come.
    const kept = pairedWorstCase(RULE, 'kept');
    const broken = pairedWorstCase(RULE, 'broken');
    expect(kept).toBeLessThanOrEqual(RULE.risk);
    expect(broken).toBeLessThanOrEqual(RULE.risk);
    expect(kept).toBeCloseTo(0.0493, 3);
    console.log(`the worst null at once: kept ${(100 * kept).toFixed(2)}%, broken ${(100 * broken).toFixed(2)}%`);
    // At other figures too.
    for (const rule of [{ margin: 0.2, risk: 0.05, max: 120 }, { margin: 0.05, risk: 0.1, max: 150 }, { margin: 0.1, risk: 0.01, max: 100 }]) {
      expect(pairedWorstCase(rule, 'kept'), JSON.stringify(rule)).toBeLessThanOrEqual(rule.risk);
      expect(pairedWorstCase(rule, 'broken'), JSON.stringify(rule)).toBeLessThanOrEqual(rule.risk);
    }
  });

  it('keeps a run whose arms pass every attempt after 38 pairs, and bounds its drop', () => {
    let c: PairCounts = NO_PAIRS;
    let n = 0;
    while (decidePaired(c, RULE) === 'continue') {
      c = addPair(c, true, true);
      n++;
    }
    expect(n).toBe(38);
    expect(decidePaired(c, RULE)).toBe('kept');
    const d = pairedDrop(c, RULE.risk);
    expect(d.hi).toBeLessThanOrEqual(RULE.margin);
    expect(dropBound(d, 'kept')).toBe('drop <= 0.10 (95%)');
    // One that fails every attempt where its baseline passes is broken at once, and bounded below.
    let worse: PairCounts = NO_PAIRS;
    while (decidePaired(worse, RULE) === 'continue') worse = addPair(worse, false, true);
    expect(decidePaired(worse, RULE)).toBe('broken');
    // The broken bets, 0.35 and 0.7: (1.35^n + 1.7^n) / 2 first reaches 20 at n = 7.
    expect(worse.worse).toBe(7);
    expect(pairedDrop(worse, RULE.risk).lo).toBeGreaterThan(0);
    expect(describeBaselineRule({ ...RULE, source: 'paired', revision: '370712a' })).toBe('kept unless it drops 10+ points below its baseline at 370712a, attempt for attempt, <= 5% risk, up to 200 pairs');
  });
});

describe('the paired test, by simulation', () => {
  /** One good run's verdict, pairs drawn by `pair(n)`, which returns the change's and the baseline's outcome for pair n. */
  function run(pair: (n: number) => [boolean, boolean]): { decision: string; pairs: number } {
    let c: PairCounts = NO_PAIRS;
    for (let n = 1; ; n++) {
      const [x, y] = pair(n);
      c = addPair(c, x, y);
      const d = decidePaired(c, RULE);
      if (d !== 'continue') return { decision: d, pairs: n };
    }
  }

  it('keeps a run that dropped by the margin no more than `risk` of the time, with arms that drift together and are correlated', () => {
    const random = seeded(20261023);
    const RUNS = 600;
    for (const pb of [0.75, 0.9, 0.99]) {
      // The baseline drifts over the run (a provider change halfway through moves both arms), the
      // change stays exactly the margin below it at every pair, and half the pairs share one coin.
      let kept = 0;
      for (let r = 0; r < RUNS; r++) {
        const res = run((n) => {
          const base = Math.min(0.995, Math.max(RULE.margin + 0.01, pb + (n > 60 ? -0.08 : 0.02)));
          const change = base - RULE.margin;
          const u = random();
          const shared = random() < 0.5;
          const v = shared ? u : random();
          return [v < change, u < base];
        });
        if (res.decision === 'kept') kept++;
      }
      // Within three standard errors of the risk at most.
      const se = Math.sqrt((RULE.risk * (1 - RULE.risk)) / RUNS);
      expect(kept / RUNS, `drifting and correlated at ${pb}`).toBeLessThanOrEqual(RULE.risk + 3 * se);
    }
  });

  it('lands on the exact odds with independent arms', () => {
    const random = seeded(7);
    const RUNS = 1500;
    for (const [pb, drop] of [
      [0.99, 0],
      [0.9, 0.1],
      [0.85, 0.25],
    ] as const) {
      const exact = pairedOdds(RULE, pb - drop, pb);
      let kept = 0;
      let broken = 0;
      let pairs = 0;
      for (let r = 0; r < RUNS; r++) {
        const res = run(() => [random() < pb - drop, random() < pb]);
        if (res.decision === 'kept') kept++;
        if (res.decision === 'broken') broken++;
        pairs += res.pairs;
      }
      const close = (sim: number, p: number) => expect(Math.abs(sim - p), `${pb} ${drop}`).toBeLessThanOrEqual(4 * Math.sqrt((p * (1 - p)) / RUNS) + 0.003);
      close(kept / RUNS, exact.kept);
      close(broken / RUNS, exact.broken);
      expect(pairs / RUNS).toBeCloseTo(exact.attempts, -1);
    }
  });
});

describe('against history', () => {
  it('bounds a pass rate exactly from its passes (Clopper-Pearson)', () => {
    // 0 of 10: the rule of three's exact form, 1 - 0.05^(1/10).
    expect(clopperPearsonBound(0, 10, 0.05, 'upper')).toBeCloseTo(1 - 0.05 ** 0.1, 6);
    expect(clopperPearsonBound(10, 10, 0.05, 'lower')).toBeCloseTo(0.05 ** 0.1, 6);
    expect(clopperPearsonBound(5, 5, 0.05, 'upper')).toBe(1);
    expect(clopperPearsonBound(47, 50, 0.025, 'upper')).toBeCloseTo(0.9875, 3);
  });

  it('keeps a run that dropped by the margin or more at most `risk` of the time, its history drawn as well', () => {
    for (const pb of BASES) {
      for (const drop of [0.1, 0.15, 0.25]) {
        const o = historyOdds({ ...RULE, max: 120 }, pb - drop, pb, 50);
        expect(o.kept, `history of 50 at ${pb}, drop ${drop}`).toBeLessThanOrEqual(RULE.risk);
      }
      expect(historyOdds({ ...RULE, max: 120 }, pb, pb, 50).broken, `no drop from ${pb}`).toBeLessThanOrEqual(RULE.risk);
    }
  });

  it('decides on the change alone, with the history as it was kept, and bounds the drop', () => {
    const history = { passes: 47, attempts: 50 };
    let n = 0;
    while (decideAgainstHistory({ passes: n, attempts: n }, history, RULE) === 'continue') n++;
    expect(decideAgainstHistory({ passes: n, attempts: n }, history, RULE)).toBe('kept');
    expect(dropBound(historyDrop({ passes: n, attempts: n }, history, RULE.risk), 'kept')).toMatch(/^drop <= 0\.\d\d \(95%\)$/);
    expect(decideAgainstHistory({ passes: 0, attempts: 4 }, history, RULE)).toBe('broken');
  });
});
