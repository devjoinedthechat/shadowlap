import { describe, expect, it } from 'vitest';
import {
  BASELINE_DEFAULTS,
  BLAME_DEFAULTS,
  SPRT_DEFAULTS,
  clopperPearson,
  confidenceSequence,
  decide,
  decideCount,
  gateInterval,
  gateResult,
  rateBound,
  stagewiseInterval,
  tallyInterval,
  wilson,
  type BaselineGate,
  type Gate,
  type GateDecision,
  type SprtGate,
  type Tally,
} from '../src/stats.js';

/**
 * The bound every verdict line shows (`rate >= 0.73 (95%)`) is proven here, exactly: for a pass
 * rate on a grid from 1% to 99%, every way a gate can stop is enumerated with its chance, and the
 * bound shown at each stop is checked against the rate. "Covers" means the statement the report
 * prints is true: `rate >= lo` after a pass, `rate <= hi` after a failure, `lo <= rate <= hi`
 * when inconclusive, with the printed ends rounded as printed. No sampling: these are sums.
 */

type Rule = (passes: number, attempts: number) => GateDecision;
interface Stop {
  passes: number;
  attempts: number;
  decision: 'pass' | 'fail' | 'inconclusive';
}

/** Every stop a rule can reach within `limit` attempts. */
function stopsOf(rule: Rule, limit: number): Stop[] {
  const stops: Stop[] = [];
  let walking = new Set<number>([0]);
  for (let n = 1; n <= limit; n++) {
    const next = new Set<number>();
    for (const s of walking) {
      for (const passes of [s, s + 1]) {
        const d = rule(passes, n);
        if (d === 'continue') next.add(passes);
        else if (!stops.some((t) => t.attempts === n && t.passes === passes)) stops.push({ passes, attempts: n, decision: d });
      }
    }
    walking = next;
  }
  return stops;
}

/** The chance of each stop at pass rate p, keyed `attempts/passes`. */
function stopChances(rule: Rule, limit: number, p: number): Map<string, number> {
  const out = new Map<string, number>();
  let walking = new Map<number, number>([[0, 1]]);
  for (let n = 1; n <= limit; n++) {
    const next = new Map<number, number>();
    for (const [s, mass] of walking) {
      for (const [passes, q] of [
        [s + 1, p],
        [s, 1 - p],
      ] as const) {
        if (q === 0) continue;
        const d = rule(passes, n);
        if (d === 'continue') next.set(passes, (next.get(passes) ?? 0) + mass * q);
        else out.set(`${n}/${passes}`, (out.get(`${n}/${passes}`) ?? 0) + mass * q);
      }
    }
    walking = next;
  }
  return out;
}

/** The ends a printed bound states, read back from the text the reports print. */
function printed(text: string): { lo: number; hi: number } {
  const m = /^rate (?:>= ([\d.]+)|<= ([\d.]+)|([\d.]+) to ([\d.]+)) \(/.exec(text);
  if (!m) throw new Error(`not a bound: ${text}`);
  if (m[1]) return { lo: Number(m[1]), hi: 1 };
  if (m[2]) return { lo: 0, hi: Number(m[2]) };
  return { lo: Number(m[3]), hi: Number(m[4]) };
}

const GRID = Array.from({ length: 99 }, (_, i) => (i + 1) / 100);

/**
 * The exact coverage of what a gate's reports print, at each rate of the grid: the worst of them,
 * and where. Also each end alone (the low end after every stop, the high end after every stop),
 * which must hold at (1 + confidence)/2, half the risk each.
 */
function coverage(gate: Gate, history: Tally | null = null): { worst: number; at: number; worstLow: number; worstHigh: number } {
  const rule: Rule = (s, n) => decide(s, n, gate, history);
  const stops = stopsOf(rule, gate.max).map((t) => {
    // An order of its attempts the rule reaches it by: all passes first could stop sooner.
    const path = pathTo(rule, t);
    if (!path) throw new Error(`no path reaches ${JSON.stringify(t)}`);
    const r = gateResult(gate, path, { history: history ? { ...history, sessions: 1 } : null });
    expect(r.decision).toBe(t.decision);
    expect(r.bound?.method).toBe('stagewise');
    return { ...t, interval: r.interval, shown: printed(rateBound(r)!) };
  });
  let worst = 1;
  let at = 0;
  let worstLow = 1;
  let worstHigh = 1;
  for (const p of GRID) {
    const chances = stopChances(rule, gate.max, p);
    let covered = 0;
    let low = 0;
    let high = 0;
    for (const t of stops) {
      const c = chances.get(`${t.attempts}/${t.passes}`) ?? 0;
      if (t.shown.lo <= p && p <= t.shown.hi) covered += c;
      if (t.interval.lo <= p) low += c;
      if (t.interval.hi >= p) high += c;
    }
    if (covered < worst) {
      worst = covered;
      at = p;
    }
    worstLow = Math.min(worstLow, low);
    worstHigh = Math.min(worstHigh, high);
  }
  return { worst, at, worstLow, worstHigh };
}

/** Attempts in an order that reaches `t` without the rule stopping first, or null when none does. */
function pathTo(rule: Rule, t: Stop): boolean[] | null {
  // The passes each attempt can have while the rule still continues, then back from t through them.
  const reach: Array<Set<number>> = [new Set([0])];
  for (let n = 1; n < t.attempts; n++) {
    const next = new Set<number>();
    for (const s of reach[n - 1]!) for (const passes of [s, s + 1]) if (rule(passes, n) === 'continue') next.add(passes);
    reach.push(next);
  }
  const path: boolean[] = [];
  let s = t.passes;
  for (let n = t.attempts; n >= 1; n--) {
    const before = reach[n - 1]!;
    if (before.has(s)) path.unshift(false);
    else if (before.has(s - 1)) {
      path.unshift(true);
      s--;
    } else return null;
  }
  return path;
}

const sprt = (o: Partial<Omit<SprtGate, 'kind'>> = {}): SprtGate => ({ kind: 'sprt', ...SPRT_DEFAULTS, ...o });
const history = (o: Partial<Omit<BaselineGate, 'kind'>> = {}): BaselineGate => ({ kind: 'baseline', ...BASELINE_DEFAULTS, ...o });

describe('the bound beside a verdict covers the true rate as often as it says, every look counted', () => {
  it('under the default gate: at least 95% at every rate from 1% to 99%, each end alone at least 97.5%', () => {
    const c = coverage(sprt());
    expect(c.worst).toBeGreaterThanOrEqual(0.95);
    expect(c.worstLow).toBeGreaterThanOrEqual(0.975);
    expect(c.worstHigh).toBeGreaterThanOrEqual(0.975);
    // Not by a mile: the bound is as tight as the gate's stopping allows.
    expect(c.worst).toBeLessThan(0.97);
  });

  it("under blame's gate, 0.6 / 0.1 / 0.05 / 20", () => {
    const c = coverage({ kind: 'sprt', ...BLAME_DEFAULTS });
    expect(c.worst).toBeGreaterThanOrEqual(0.95);
    expect(c.worstLow).toBeGreaterThanOrEqual(0.975);
    expect(c.worstHigh).toBeGreaterThanOrEqual(0.975);
  });

  it('under a gate with its suite share of the risk for a failure, and the max sized for it', () => {
    const c = coverage(sprt({ failRisk: 0.0005, max: 190 }));
    expect(c.worst).toBeGreaterThanOrEqual(0.95);
    expect(c.worstLow).toBeGreaterThanOrEqual(0.975);
    expect(c.worstHigh).toBeGreaterThanOrEqual(0.975);
  });

  it('under gates with other figures: a tight risk, a loose one, a short limit', () => {
    for (const g of [sprt({ risk: 0.01 }), sprt({ good: 0.95, bad: 0.8, risk: 0.1, max: 60 }), sprt({ max: 20 }), sprt({ good: 0.6, bad: 0.4, risk: 0.2, max: 4 })]) {
      const c = coverage(g);
      expect(c.worst, JSON.stringify(g)).toBeGreaterThanOrEqual(1 - g.risk);
      expect(c.worstLow).toBeGreaterThanOrEqual(1 - g.risk / 2);
      expect(c.worstHigh).toBeGreaterThanOrEqual(1 - g.risk / 2);
    }
  });

  it('under the gate against history, given its baseline: 47 of 50, a short history, and none', () => {
    for (const h of [{ passes: 47, attempts: 50 }, { passes: 4, attempts: 5 }, null]) {
      const c = coverage(history(), h);
      expect(c.worst, JSON.stringify(h)).toBeGreaterThanOrEqual(0.95);
      expect(c.worstLow).toBeGreaterThanOrEqual(0.975);
      expect(c.worstHigh).toBeGreaterThanOrEqual(0.975);
    }
  });

  it('where the Wilson interval it replaces covered as little as 84% (the default gate) and 87% (blame)', () => {
    // What the reports printed before: the Wilson score interval of the tally, as if its count were fixed.
    const wilsonCoverage = (gate: SprtGate) => {
      const rule: Rule = (s, n) => decide(s, n, gate);
      const stops = stopsOf(rule, gate.max);
      return Math.min(
        ...GRID.map((p) => {
          const chances = stopChances(rule, gate.max, p);
          return stops.reduce((sum, t) => {
            const w = wilson(t.passes, t.attempts, 1 - gate.risk);
            const ok = t.decision === 'pass' ? w.lo <= p : t.decision === 'fail' ? w.hi >= p : w.lo <= p && p <= w.hi;
            return sum + (ok ? (chances.get(`${t.attempts}/${t.passes}`) ?? 0) : 0);
          }, 0);
        }),
      );
    };
    expect(wilsonCoverage(sprt())).toBeLessThan(0.84);
    expect(wilsonCoverage({ kind: 'sprt', ...BLAME_DEFAULTS })).toBeLessThan(0.88);
  });

  it('is the equal-tailed interval: a one-sided 95% end shown after each verdict would cover only about 92%', () => {
    // Choosing the end to show by the verdict puts both tails at stake at a rate between the gate's two:
    // the earliest passes and the earliest failures. Half the risk on each end keeps the total at the risk.
    const gate = sprt();
    const rule: Rule = (s, n) => decide(s, n, gate);
    const stops = stopsOf(rule, gate.max).map((t) => ({ ...t, one: stagewiseInterval(rule, t, 0.9) }));
    const worst = Math.min(
      ...GRID.map((p) => {
        const chances = stopChances(rule, gate.max, p);
        return stops.reduce((sum, t) => {
          const ok = t.decision === 'pass' ? t.one.lo <= p : t.decision === 'fail' ? t.one.hi >= p : t.one.lo <= p && p <= t.one.hi;
          return sum + (ok ? (chances.get(`${t.attempts}/${t.passes}`) ?? 0) : 0);
        }, 0);
      }),
    );
    expect(worst).toBeLessThan(0.93);
  });
});

describe('the stagewise interval', () => {
  const gate = sprt();
  const rule: Rule = (s, n) => decide(s, n, gate);

  it('has the closed forms of the stops no path can beat: 12 of 12 passed, 0 of 3 failed', () => {
    // A pass at 12 is the highest stop: only 12 straight passes reach it, so P = p^12.
    const top = stagewiseInterval(rule, { passes: 12, attempts: 12, decision: 'pass' }, 0.95);
    expect(top.lo).toBeCloseTo(0.025 ** (1 / 12), 10);
    // A failure at 3 is the lowest: 3 straight failures, so P = (1 − p)^3.
    const bottom = stagewiseInterval(rule, { passes: 0, attempts: 3, decision: 'fail' }, 0.95);
    expect(bottom.hi).toBeCloseTo(1 - 0.025 ** (1 / 3), 10);
    expect(bottom.lo).toBe(0);
    expect(top.hi).toBe(1);
  });

  it('prints those as the reports do, each end rounded away from the rate', () => {
    expect(gateResult(gate, Array(12).fill(true)).sentence).toBe('passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    expect(gateResult(gate, [false, false, false]).sentence).toBe('failed · 0 of 3 · rate <= 0.71 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    expect(gateResult(gate, Array(12).fill(true)).bound).toEqual({ lo: expect.closeTo(0.7354, 4), confidence: 0.95, method: 'stagewise' });
    expect(gateResult(gate, [false, false, false]).bound).toEqual({ hi: expect.closeTo(0.7076, 4), confidence: 0.95, method: 'stagewise' });
  });

  it('rises with the rate it is computed at, as a coupling of pass rates shows: the chance of stopping as high or higher', () => {
    for (const t of stopsOf(rule, 40).filter((_, i) => i % 3 === 0)) {
      const chance = (p: number) => {
        const chances = stopChances(rule, gate.max, p);
        // As high or higher, in the stagewise order: what the interval's low end bisects on.
        const rank = (x: Stop) => (x.decision === 'pass' ? [2, -x.attempts, x.passes] : x.decision === 'fail' ? [0, x.attempts, x.passes] : [1, 0, x.passes]);
        const higher = (a: number[], b: number[]) => a[0]! !== b[0]! ? a[0]! > b[0]! : a[1]! !== b[1]! ? a[1]! > b[1]! : a[2]! >= b[2]!;
        return stopsOf(rule, gate.max).reduce((sum, x) => sum + (higher(rank(x), rank(t)) ? (chances.get(`${x.attempts}/${x.passes}`) ?? 0) : 0), 0);
      };
      let last = -1;
      for (const p of [0.05, 0.2, 0.4, 0.6, 0.7, 0.8, 0.9, 0.97]) {
        const c = chance(p);
        expect(c).toBeGreaterThanOrEqual(last - 1e-12);
        last = c;
      }
    }
  });

  it('depends only on the gate up to where it stopped: a pass at 12 reads the same under any limit', () => {
    const at12 = (max: number) => stagewiseInterval((s, n) => decide(s, n, sprt({ max })), { passes: 12, attempts: 12, decision: 'pass' }, 0.95);
    expect(at12(20)).toEqual(at12(80));
    expect(at12(20)).toEqual(at12(400));
  });
});

describe('Clopper–Pearson, for a fixed count', () => {
  it('is the beta quantiles: 18 of 20 at 95% is 0.683 to 0.988', () => {
    const i = clopperPearson(18, 20, 0.95);
    expect(i.lo).toBeCloseTo(0.6830, 3);
    expect(i.hi).toBeCloseTo(0.9877, 3);
    expect(clopperPearson(0, 10, 0.95)).toEqual({ lo: 0, hi: expect.closeTo(1 - 0.025 ** (1 / 10), 9) });
    expect(clopperPearson(10, 10, 0.95)).toEqual({ lo: expect.closeTo(0.025 ** (1 / 10), 9), hi: 1 });
  });

  it('covers at least 95% for a count run to its end, and for one stopped as soon as it is settled', () => {
    for (const [of, needed] of [
      [5, 4],
      [10, 9],
      [3, 2],
      [20, 18],
    ] as const) {
      // Stopped once settled, as verify and blame stop a fixed count (decideCount).
      const rule: Rule = (s, n) => decideCount(s, n, of, needed);
      const stops = stopsOf(rule, of).map((t) => ({ ...t, i: clopperPearson(t.passes, t.attempts, 0.95) }));
      for (const p of GRID) {
        const chances = stopChances(rule, of, p);
        let shown = 0;
        let both = 0;
        for (const t of stops) {
          const c = chances.get(`${t.attempts}/${t.passes}`) ?? 0;
          if (t.decision === 'pass' ? t.i.lo <= p : t.i.hi >= p) shown += c;
          if (t.i.lo <= p && p <= t.i.hi) both += c;
        }
        expect(shown, `${needed} of ${of} at ${p}`).toBeGreaterThanOrEqual(0.95);
        expect(both, `${needed} of ${of} at ${p}`).toBeGreaterThanOrEqual(0.95);
      }
    }
  });
});

describe('the confidence sequence, for attempts no gate stopped on by its rule', () => {
  it('covers the rate at every attempt at once: missing it ever, in 200 attempts, at most 5% of the time', () => {
    // A walk that stops at the first attempt whose interval misses p: the worst a stopping time can do.
    const N = 200;
    const intervals = new Map<string, { lo: number; hi: number }>();
    const at = (s: number, n: number) => {
      const key = `${n}/${s}`;
      let i = intervals.get(key);
      if (!i) intervals.set(key, (i = confidenceSequence(s, n, 0.95)));
      return i;
    };
    for (const p of [0.02, 0.1, 0.3, 0.5, 0.7, 0.9, 0.95, 0.99]) {
      let walking = new Map<number, number>([[0, 1]]);
      let missed = 0;
      for (let n = 1; n <= N; n++) {
        const next = new Map<number, number>();
        for (const [s, mass] of walking) {
          for (const [passes, q] of [
            [s + 1, p],
            [s, 1 - p],
          ] as const) {
            const i = at(passes, n);
            if (i.lo > p || i.hi < p) missed += mass * q;
            else next.set(passes, (next.get(passes) ?? 0) + mass * q);
          }
        }
        walking = next;
      }
      expect(missed, `p = ${p}`).toBeLessThanOrEqual(0.05);
    }
  });

  it('is what a gate cut short, carried over or clean reports, and says so', () => {
    const g = sprt();
    expect(gateResult(g, [true, true], { decision: 'continue' }).bound).toEqual({ lo: expect.any(Number), hi: expect.any(Number), confidence: 0.95, method: 'confidence-sequence' });
    expect(gateResult(g, [true, true], { decision: 'continue' }).sentence).toBe('undecided · 2 of 2 · rate 0.12 to 1.00 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts');
    const carried = gateResult(g, [...Array(16).fill(true), false, false, false, false, ...Array(8).fill(true)], { carried: 20, decision: 'pass' });
    expect(carried.bound?.method).toBe('confidence-sequence');
    expect(gateResult(g, [true], { clean: true }).bound).toBeUndefined();
    expect(gateInterval(g, [true], { clean: true }).method).toBe('confidence-sequence');
  });

  it('is wider than the exact interval where the gate did stop by its rule', () => {
    const exact = gateInterval(sprt(), Array(12).fill(true));
    const anytime = confidenceSequence(12, 12, 0.95);
    expect(anytime.lo).toBeLessThan(exact.lo);
  });
});

describe('a bound from a tally alone', () => {
  it('is stagewise where the rule stops at that tally, and a confidence sequence where it cannot', () => {
    const g = sprt();
    expect(tallyInterval(g, { passes: 12, attempts: 12 }, 'pass')).toEqual({ ...gateInterval(g, Array(12).fill(true)), method: 'stagewise' });
    // 12 of 13 is no stop: a 13th attempt after 12 straight passes never runs.
    expect(tallyInterval(g, { passes: 12, attempts: 13 }, 'pass').method).toBe('confidence-sequence');
    expect(tallyInterval(g, { passes: 3, attempts: 5 }, 'continue').method).toBe('confidence-sequence');
  });
});
