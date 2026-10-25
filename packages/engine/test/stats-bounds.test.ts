import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  percent,
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
import { probeGate } from '../src/blame.js';
import { planSuite } from '../src/suite.js';

/**
 * The bound every verdict line shows (`rate >= 0.73 (95%)`) is proven here, exactly: at every pass
 * rate where its coverage can be lowest, every way a gate can stop is enumerated with its chance, and
 * the bound shown at each stop is checked against the rate. "Covers" means the statement the report
 * prints is true: `rate >= lo` after a pass, `rate <= hi` after a failure, `lo <= rate <= hi`
 * when inconclusive, with the printed ends rounded as printed. No sampling: these are sums.
 *
 * Where it can be lowest: a printed end is a whole hundredth, so the coverage jumps at every
 * hundredth, down just below a low end (`rate >= 0.73` is false at 0.7299…) and just above a high
 * end. A grid of hundredths lands on the very rates where both kinds of end hold, and reads the
 * coverage there, its highest. So each hundredth is approached from both sides, and the rates
 * between are read every thousandth, where the sums move smoothly.
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

/** Just off a rate where a statement's truth flips. */
const SIDE = 1e-9;

/**
 * The rates the coverage is read at: each hundredth approached from below and from above, where a
 * printed end makes a statement false; every thousandth between them; and each unrounded end of an
 * interval, approached from the side where it is false, for the ends read alone.
 */
function ratesFor(ends: readonly number[]): number[] {
  const rates = new Set<number>();
  for (let k = 1; k <= 99; k++) {
    rates.add(k / 100 - SIDE);
    rates.add(k / 100 + SIDE);
  }
  for (let k = 1; k < 1000; k++) if (k % 10) rates.add(k / 1000);
  for (const x of ends) for (const p of [x - SIDE, x + SIDE]) if (p > 0 && p < 1) rates.add(p);
  return [...rates].sort((a, b) => a - b);
}

/**
 * The exact coverage of what a gate's reports print, at each rate of the grid: the worst of them,
 * and where. Also each end alone (the low end after every stop, the high end after every stop),
 * which must hold at (1 + confidence)/2, half the risk each.
 */
function coverage(gate: Gate, history: Tally | null = null): { worst: number; at: number; worstLow: number; worstHigh: number; onGrid: number } {
  const { rule, stops } = shownStops(gate, history);
  let worst = 1;
  let at = 0;
  let worstLow = 1;
  let worstHigh = 1;
  // What a grid of hundredths alone reads: the figures the page stated before, too high.
  let onGrid = 1;
  const grid = new Set(GRID);
  for (const p of ratesFor(stops.flatMap((t) => [t.interval.lo, t.interval.hi]))) {
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
  for (const p of grid) {
    const chances = stopChances(rule, gate.max, p);
    onGrid = Math.min(onGrid, stops.reduce((n, t) => n + (t.shown.lo <= p && p <= t.shown.hi ? (chances.get(`${t.attempts}/${t.passes}`) ?? 0) : 0), 0));
  }
  return { worst, at, worstLow, worstHigh, onGrid };
}

/** Every stop a gate can make, each with its interval and what the reports print there. */
function shownStops(gate: Gate, history: Tally | null = null): { rule: Rule; stops: Array<Stop & { interval: { lo: number; hi: number }; shown: { lo: number; hi: number } }> } {
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
  return { rule, stops };
}

/** Attempts in an order that reaches `t` without the rule stopping first, or null when none does. */
function pathTo(rule: Rule, t: Stop): boolean[] | null {
  // The passes each attempt can have while the rule still continues, then back from t through them.
  const reach: Array<Set<number>> = [new Set([0])];
  for (let n = 1; n < t.attempts; n++) {
    const next = new Set<number>();
    for (const s of reach[n - 1]) for (const passes of [s, s + 1]) if (rule(passes, n) === 'continue') next.add(passes);
    reach.push(next);
  }
  const path: boolean[] = [];
  let s = t.passes;
  for (let n = t.attempts; n >= 1; n--) {
    const before = reach[n - 1];
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

/** Worked out once, on first use: each takes a second or more. */
const once = <T>(f: () => T): (() => T) => {
  let v: { value: T } | null = null;
  return () => (v ??= { value: f() }).value;
};
/** The gate each probe of a blame of 17 to 32 model calls runs under: 8 probes, each with its share of the search's 5% and its max deepened to it (blame.ts). */
const PROBE = probeGate({ kind: 'sprt', ...BLAME_DEFAULTS }, 8);
/** The gate a session that splits its 5% 100 ways gives each golden of `"gate": {}` (suite.ts): its share for a failure, its max sized for it. */
const SPLIT = once(() => planSuite(Array.from({ length: 100 }, (_, i) => ({ golden: `goldens/g${i}`, gate: sprt(), maxGiven: false })))!.planned[0].gate as SprtGate);
const COVERED = {
  default: once(() => coverage(sprt())),
  blame: once(() => coverage(PROBE)),
  split: once(() => coverage(SPLIT())),
  history: once(() => coverage(history(), { passes: 47, attempts: 50 })),
};

/** docs/gating.md, which states these figures: each is held to it as worked out here. */
const PAGE = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
const says = (text: string) => expect(PAGE.includes(text), `docs/gating.md says: ${text}`).toBe(true);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

// Each sums every stop a gate can make at 99 rates: seconds apiece, more on a loaded machine.
describe('the bound beside a verdict covers the true rate as often as it says, every look counted', { timeout: 120_000 }, () => {
  it('under the default gate: at least 95% at every rate, each end alone at least 97.5%', () => {
    const c = COVERED.default();
    expect(c.worst).toBeGreaterThanOrEqual(0.95);
    expect(c.worstLow).toBeGreaterThanOrEqual(0.975);
    expect(c.worstHigh).toBeGreaterThanOrEqual(0.975);
    // Not by a mile: the bound is as tight as the gate's stopping allows.
    expect(c.worst).toBeLessThan(0.97);
  });

  it("under a blame probe's gate, at its share of the search's 5%: 0.6 / 0.1 at 0.625%, up to 34 attempts, its bound at 99.4%", () => {
    expect(PROBE).toMatchObject({ good: 0.6, bad: 0.1, max: 34 });
    expect(PROBE.risk).toBeCloseTo(0.00625, 12);
    const c = COVERED.blame();
    expect(c.worst).toBeGreaterThanOrEqual(1 - PROBE.risk);
    expect(c.worstLow).toBeGreaterThanOrEqual(1 - PROBE.risk / 2);
    expect(c.worstHigh).toBeGreaterThanOrEqual(1 - PROBE.risk / 2);
  });

  it('under a gate with its suite share of the risk for a failure, and the max sized for it', () => {
    // The gate a session gives each of 100 goldens: 0.047% to fail, up to 179 attempts.
    expect(SPLIT()).toMatchObject({ failRisk: 0.00047, max: 179 });
    const c = COVERED.split();
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
      const c = h?.passes === 47 ? COVERED.history() : coverage(history(), h);
      expect(c.worst, JSON.stringify(h)).toBeGreaterThanOrEqual(0.95);
      expect(c.worstLow).toBeGreaterThanOrEqual(0.975);
      expect(c.worstHigh).toBeGreaterThanOrEqual(0.975);
    }
  });

  it('as the page states it: the worst the printed bound does under each gate, read on both sides of every printed end, not on a grid of hundredths', () => {
    // A coverage is a floor, so the page rounds it down.
    const floor = (x: number) => `${(Math.floor(1000 * x) / 10).toFixed(1)}%`;
    says(`The worst the printed bound does is ${floor(COVERED.default().worst)} under the default gate, ${floor(COVERED.split().worst)} under a gate split 100 ways, ${floor(COVERED.history().worst)} under the gate against history against 47 of 50, and ${floor(COVERED.blame().worst)} under a blame probe's at the share of 8 probes, whose bound is at ${percent(1 - PROBE.risk)}.`);
    // Read only at the hundredths, where both kinds of printed end hold, each gate looks better than it is.
    for (const c of [COVERED.default(), COVERED.split(), COVERED.history(), COVERED.blame()]) expect(c.onGrid).toBeGreaterThan(c.worst);
    // Its worst is just off a hundredth, where a printed end stops holding.
    expect(Math.abs(100 * COVERED.default().at - Math.round(100 * COVERED.default().at))).toBeLessThan(1e-6);
  });

  it("doesn't say how often one kind of verdict is wrong: among an agent's passes at 70%, the bound is wrong a third of the time, within the 5% overall", () => {
    const { rule, stops } = shownStops(sprt());
    const chances = stopChances(rule, SPRT_DEFAULTS.max, 0.7);
    const passes = stops.filter((t) => t.decision === 'pass');
    const passed = passes.reduce((n, t) => n + (chances.get(`${t.attempts}/${t.passes}`) ?? 0), 0);
    const wrong = passes.filter((t) => t.shown.lo > 0.7);
    // Only 12 straight passes print a low end above 70%: 0.73.
    expect(wrong.map((t) => [t.passes, t.attempts])).toEqual([[12, 12]]);
    const wrongly = wrong.reduce((n, t) => n + (chances.get(`${t.attempts}/${t.passes}`) ?? 0), 0);
    expect(wrongly).toBeCloseTo(0.7 ** 12, 12);
    says(`the low end is above 70% about a third of the time (${Math.round((100 * wrongly) / passed)}%): every run of 12 straight passes. Those passes happen ${pct(passed)} of the time, so they put the bound wrong ${pct(wrongly)} of the time, within the 5%.`);
    expect(Math.round((3 * wrongly) / passed)).toBe(1);
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
    says(`it misses the true rate whenever the gate stopped early on a run of passes, as often as ${Math.round(100 * (1 - wilsonCoverage(sprt())))}% of the time under the default gate`);
    // After a pass at 75%: how often the `rate >= …` it printed, to the nearest hundredth, was wrong.
    const gate = sprt();
    const rule: Rule = (s, n) => decide(s, n, gate);
    const chances = stopChances(rule, gate.max, 0.75);
    const passes = stopsOf(rule, gate.max).filter((t) => t.decision === 'pass');
    const chance = (t: Stop) => chances.get(`${t.attempts}/${t.passes}`) ?? 0;
    const shown = (t: Stop) => +wilson(t.passes, t.attempts, 0.95).lo.toFixed(2);
    expect(shown({ passes: 12, attempts: 12, decision: 'pass' })).toBe(0.76);
    const passed = passes.reduce((n, t) => n + chance(t), 0);
    const wrong = passes.filter((t) => shown(t) > 0.75).reduce((n, t) => n + chance(t), 0);
    says(`After a pass at 75%, its \`rate >= 0.76\` was wrong ${Math.round((100 * wrong) / passed)}% of the time.`);
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
        const higher = (a: number[], b: number[]) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];
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
