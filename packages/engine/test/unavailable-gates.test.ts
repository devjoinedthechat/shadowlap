import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decideAgainstHistory, decideAgainstHistoryAround, decidePairedAround, historyBounds, KEPT_DEFAULTS, pairedKeptLog, pairedOdds, type BaselineRule } from '../src/noninferiority.js';
import { binomialTail, decide, decideCount, decideCountUnavailable, decideUnavailable, gateOdds, passesPerFailure, SPRT_DEFAULTS, type SprtGate } from '../src/stats.js';
import { planSuite } from '../src/suite.js';
import { UNAVAILABLE_RETRY } from '../src/unavailable.js';

/**
 * Provider errors never decide a verdict. An attempt the provider cut short after the model had
 * answered is counted against either verdict (stats.ts `decideUnavailable`, noninferiority.ts
 * `decidePairedAround`, `decideAgainstHistoryAround`); one it failed before the model answered is
 * retried and never counted. These are exact: every way the gates can end, walked with its chance,
 * under the review's scenarios, where an agent's failing attempts come with a provider error with
 * chance e (an agent that loops until it is rate limited). Retrying such attempts and leaving them
 * out, as the gates did, passed an agent at 70% 7.2%, 12.1% and 20.3% of the time at e = 0.1, 0.2
 * and 0.3, where 4.3% is the gate's own; and three such errors in a row stop a gate inconclusive.
 */

const sprt = (o: Partial<Omit<SprtGate, 'kind'>> = {}): SprtGate => ({ kind: 'sprt', ...SPRT_DEFAULTS, ...o });
const IN_A_ROW = UNAVAILABLE_RETRY.inARow;

interface Odds {
  pass: number;
  fail: number;
  inconclusive: number;
  /** Stopped by the provider unavailable `IN_A_ROW` attempts in a row. */
  provider: number;
}

/**
 * The exact odds of a gate's verdicts when each try passes with chance `pass`, fails with chance
 * `fail`, is cut short by the provider after the model answered with chance `late`, and fails before
 * the model answered with chance `early` (retried, never counted): every state (passes, attempts
 * counted, cut short, unavailable in a row) walked until it decides. `counted` says how the gate
 * reads the cut-short ones: against either verdict, as now, or left out and retried, as before.
 */
function walk(gate: SprtGate, t: { pass: number; fail: number; late: number; early?: number }, counted: boolean): Odds {
  const early = t.early ?? 0;
  const out: Odds = { pass: 0, fail: 0, inconclusive: 0, provider: 0 };
  let states = new Map<string, number>([['0,0,0,0', 1]]);
  for (let step = 0; states.size && step < 10_000; step++) {
    const next = new Map<string, number>();
    const add = (k: string, m: number) => next.set(k, (next.get(k) ?? 0) + m);
    for (const [key, mass] of states) {
      if (mass < 1e-16) continue;
      const [s, n, u, row] = key.split(',').map(Number) as [number, number, number, number];
      const settle = (s2: number, n2: number, u2: number, m: number) => {
        const d = counted ? decideUnavailable(s2, n2, u2, gate) : decide(s2, n2, gate);
        if (d === 'continue') add(`${s2},${n2},${u2},0`, m);
        else out[d] += m;
      };
      settle(s + 1, n + 1, u, mass * t.pass);
      settle(s, n + 1, u, mass * t.fail);
      // A try the provider failed: a stop at the third in a row; else retried after a pause.
      for (const [q, isLate] of [
        [t.late, true],
        [early, false],
      ] as const) {
        if (q <= 0) continue;
        const m = mass * q;
        if (row + 1 >= IN_A_ROW) {
          out.provider += m;
          continue;
        }
        if (isLate && counted) {
          // Counted, and decided on: it can never decide the gate by itself, as it only ever moves a view away from its verdict.
          const d = decideUnavailable(s, n + 1, u + 1, gate);
          if (d === 'continue') add(`${s},${n + 1},${u + 1},${row + 1}`, m);
          else out[d] += m;
        } else add(`${s},${n},${u},${row + 1}`, m);
      }
    }
    states = next;
  }
  return out;
}

/** An agent at `p` whose failing attempts come with a provider error, after the model answered, with chance `e`. */
const failingPath = (p: number, e: number, early = 0) => ({ pass: p * (1 - early), fail: (1 - p) * (1 - e) * (1 - early), late: (1 - p) * e * (1 - early), early });

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/**
 * The chance the kept tally ever reaches its bound within `max` pairs, which bounds the chance the
 * run is kept however the broken one goes: each pair's change attempt passes with `pc`, and a
 * failing one comes with a provider error with chance `ec`, and the baseline's the same with `pb`,
 * `eb`. A cut-short attempt counts against keeping: the change's as a failure, with no baseline
 * attempt run beside it (counted as one that passed), the baseline's as a pass.
 */
function keptWithin(rule: BaselineRule, pc: number, ec: number, pb: number, eb: number): number {
  const changeU = (1 - pc) * ec;
  const changeF = (1 - pc) * (1 - ec);
  const baseFailed = (1 - pb) * (1 - eb);
  const up = pc * baseFailed;
  const down = changeU + changeF * (1 - baseFailed);
  const bar = Math.log(1 / rule.risk) - 1e-9;
  let walking = new Map<string, number>([['0,0', 1]]);
  let kept = 0;
  for (let n = 1; n <= rule.max; n++) {
    const next = new Map<string, number>();
    for (const [key, m] of walking) {
      const [a, b] = key.split(',').map(Number) as [number, number];
      for (const [da, db, q] of [
        [1, 0, up],
        [0, 1, down],
        [0, 0, 1 - up - down],
      ] as const) {
        if (q <= 0) continue;
        const c = { better: a + da, worse: b + db, same: n - a - da - b - db };
        if (pairedKeptLog(c, rule.margin) >= bar) kept += m * q;
        else next.set(`${c.better},${c.worse}`, (next.get(`${c.better},${c.worse}`) ?? 0) + m * q);
      }
    }
    walking = next;
  }
  return kept;
}

/** The paired scenarios: baselines of 95% and 90%, the change the margin below, errors on failing attempts of each arm. */
const PAIRED: ReadonlyArray<readonly [number, number, number]> = [0.95, 0.9].flatMap((pb) =>
  ([
    [0.2, 0.2],
    [0.2, 0],
    [0.4, 0],
  ] as const).map(([ec, eb]) => [pb, ec, eb] as const),
);
const KEPT_RULE: BaselineRule = { ...KEPT_DEFAULTS, risk: 0.05 };


describe('a gate, when the provider cuts attempts short', { timeout: 600_000 }, () => {
  const gate = sprt();

  it('passes an agent at bad at most its risk, whatever share of its failures come with a provider error, where leaving them out passed it 20.3% of the time at e = 0.3', () => {
    const rows: string[] = [];
    const own = gateOdds(gate, gate.bad).pass;
    for (const e of [0, 0.1, 0.2, 0.3, 0.5]) {
      const now = walk(gate, failingPath(gate.bad, e), true);
      const before = walk(gate, failingPath(gate.bad, e), false);
      rows.push(`e=${e}: passed ${pct(now.pass)} (before ${pct(before.pass)}), failed ${pct(now.fail)}, inconclusive ${pct(now.inconclusive + now.provider)}`);
      // Within the gate's risk, by Ville's inequality: an error held back from a failure keeps the gate
      // going where it alone would have failed, so it passes a hair more often than with no error at
      // all (own), never more than its risk.
      expect(now.pass, `e=${e}`).toBeLessThanOrEqual(gate.risk);
      expect(now.pass, `e=${e}`).toBeLessThan(own + 0.002);
      expect(now.pass + now.fail + now.inconclusive + now.provider).toBeCloseTo(1, 9);
      if (e >= 0.1) expect(before.pass, `e=${e}`).toBeGreaterThan(gate.risk);
    }
    console.log(`an agent at 70% whose failures come with a provider error with chance e, under ${JSON.stringify(gate)}:\n${rows.join('\n')}`);
  });

  it('keeps a split gate’s risk too, and its share for a failure, an error on a passing attempt counted as a pass', () => {
    const plan = planSuite(Array.from({ length: 100 }, (_, i) => ({ golden: `goldens/g${i}`, gate: sprt(), maxGiven: false })))!;
    const split = plan.planned[0].gate as SprtGate;
    for (const e of [0.1, 0.3]) {
      expect(walk(split, failingPath(split.bad, e), true).pass).toBeLessThanOrEqual(split.risk);
      // Errors on attempts that would have passed: the rate the gate fails on is the agent's own.
      const onPassing = { pass: split.good * (1 - e), fail: 1 - split.good, late: split.good * e };
      expect(walk(split, onPassing, true).fail, `e=${e}`).toBeLessThanOrEqual(split.failRisk!);
    }
    // Left out, an error on a passing attempt made a healthy agent look worse: failed beyond its share.
    expect(walk(split, { pass: split.good * 0.7, fail: 1 - split.good, late: split.good * 0.3 }, false).fail).toBeGreaterThan(split.failRisk!);
  });

  it('leaves an error before the model answered out, at no cost: the gate decides as it would with no error at all', () => {
    for (const p of [0.7, 0.9, 0.95]) {
      const none = walk(gate, { pass: p, fail: 1 - p, late: 0 }, true);
      const early = walk(gate, failingPath(p, 0, 0.1), true);
      // Only three in a row stop it; otherwise the attempts it counts are the ones it would have.
      const stopped = early.provider;
      expect(stopped).toBeGreaterThan(0);
      expect(early.pass / (1 - stopped)).toBeGreaterThan(none.pass - 0.01);
      expect(early.pass).toBeLessThanOrEqual(none.pass + 1e-12);
    }
  });

  it('a regression whose failing runs loop into a rate limit: a third of runs at 66.5% passes the gate within its risk, where leaving them out passed it 64% of the time', () => {
    // A share c of runs loops until rate limited (429) and fails; the others pass 95% of the time.
    const loops = (c: number) => ({ pass: (1 - c) * 0.95, fail: (1 - c) * 0.05, late: c });
    const before = walk(gate, loops(0.3), false);
    const now = walk(gate, loops(0.3), true);
    expect(before.pass).toBeGreaterThan(0.6);
    expect(now.pass).toBeLessThanOrEqual(gate.risk);
    console.log(`30% of runs loop into 429s (true rate 0.665): passed ${pct(now.pass)}, before ${pct(before.pass)}`);
  });

  it('costs a healthy agent a little when its provider errs at random part way through', () => {
    const rows = [0.01, 0.02, 0.05].map((e) => {
      const o = walk(gate, { pass: 0.95 * (1 - e), fail: 0.05 * (1 - e), late: e }, true);
      expect(o.pass, `e=${e}`).toBeGreaterThan(0.85);
      return `errors on ${pct(e)} of attempts: passed ${pct(o.pass)}`;
    });
    console.log(`an agent at 95%, its provider failing at random after the model answered:\n${rows.join('\n')}`);
  });
});

describe('a fixed count, when the provider cuts attempts short', { timeout: 600_000 }, () => {
  /**
   * Every sequence of `of` attempts at an agent that passes `p` of the time, where a failure is cut
   * short by the provider `e` of the time: each attempt a pass, a plain failure or a cut-short one,
   * decided after each by `rule`, as test, verify, blame and chaos decide a count.
   */
  function count(of: number, needed: number, p: number, e: number, rule: (passes: number, done: number, cut: number) => string): { pass: number; fail: number; inconclusive: number } {
    const out = { pass: 0, fail: 0, inconclusive: 0 };
    const walk = (passes: number, done: number, cut: number, mass: number) => {
      const d = rule(passes, done, cut);
      if (d !== 'continue' || done === of) {
        out[(d === 'continue' ? 'inconclusive' : d) as keyof typeof out] += mass;
        return;
      }
      walk(passes + 1, done + 1, cut, mass * p);
      walk(passes, done + 1, cut, mass * (1 - p) * (1 - e));
      if (e > 0) walk(passes, done + 1, cut + 1, mass * (1 - p) * e);
    };
    walk(0, 0, 0, 1);
    return out;
  }

  it('passes 4 of 5 at 70% as often as with no provider error, where running cut-short failures again passed it up to 67% of the time', () => {
    const exact = binomialTail(5, 4, 0.7);
    for (const e of [0, 0.1, 0.2, 0.3]) {
      const now = count(5, 4, 0.7, e, (passes, done, cut) => decideCountUnavailable(passes, done, cut, 5, 4));
      expect(now.pass, `cut short ${e}`).toBeCloseTo(exact, 12);
      // Run again instead, a failure cut short is replaced by a fresh attempt: the count sees an agent at 0.7 / (1 - 0.3 e).
      const before = binomialTail(5, 4, 0.7 / (1 - 0.3 * e));
      expect(before).toBeGreaterThanOrEqual(exact - 1e-12);
      // And it fails it only when even counted as passes the cut-short failures can't make the count.
      expect(now.fail).toBeCloseTo(count(5, 4, 0.7, e, (passes, done, cut) => decideCount(passes + cut, done, 5, 4)).fail, 12);
    }
    expect(exact).toBeCloseTo(0.52822, 5);
    expect(binomialTail(5, 4, 0.7 / (1 - 0.3 * 0.3))).toBeCloseTo(0.6733, 4);
  });
});

describe('as docs/gating.md states it', { timeout: 600_000 }, () => {
  it('the errors the gate kept before and keeps now, for a run and for a good run against its baseline', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');
    const says = (text: string) => expect(page.includes(text), `docs/gating.md says: ${text}`).toBe(true);
    const gate = sprt();
    const before = [0.1, 0.2, 0.3].map((e) => pct(walk(gate, failingPath(gate.bad, e), false).pass));
    const now = Math.max(...[0.1, 0.2, 0.3, 0.5].map((e) => walk(gate, failingPath(gate.bad, e), true).pass));
    says(`failures that came with a provider error one time in ten, five or three passed an agent at 70% ${before[0]}, ${before[1]} and ${before[2]} of the time under the default gate, whose own risk there is ${pct(gateOdds(gate, gate.bad).pass)}`);
    says(`that agent passes at most ${pct(Math.ceil(1000 * now) / 1000)} of the time`);
    says(`about ${passesPerFailure(gate).toFixed(1)} more passes under the default gate`);
    // A pass after one cut short: 17 of 18, as the CLI's test of it finds.
    expect([decideUnavailable(16, 17, 1, gate), decideUnavailable(17, 18, 1, gate)]).toEqual(['continue', 'pass']);
    says('`passed · 17 of 18 (1 cut short by the provider, counted against either verdict) · rate >= … (95%) · gate: …`');
    const rule: BaselineRule = { ...KEPT_DEFAULTS, risk: 0.05 };
    const answered = (p: number, e: number) => p / (p + (1 - p) * (1 - e));
    const worst = Math.max(...PAIRED.map(([pb, ec, eb]) => keptWithin(KEPT_RULE, pb - KEPT_RULE.margin, ec, pb, eb)));
    says(`errors on a fifth of the change's failing attempts kept a run ${pct(pairedOdds(rule, answered(0.8, 0.2), 0.9).kept)} of the time when they were retried away, and at most ${pct(Math.ceil(1000 * worst) / 1000)} now`);
  });
});

describe('a good run against its paired baseline, when the provider cuts attempts short', { timeout: 600_000 }, () => {
  const rule: BaselineRule = { ...KEPT_DEFAULTS, risk: 0.05 };

  /** What the arms' answered attempts pass at once the provider's errors on failing attempts are retried away, as before. */
  const answered = (p: number, e: number) => p / (p + (1 - p) * (1 - e));

  it('keeps a run that dropped by the margin at most its risk, whatever the errors on either arm, where retrying them away kept it up to 42%', () => {
    const rows: string[] = [];
    for (const pb of [0.95, 0.9]) {
      const pc = pb - rule.margin;
      for (const [ec, eb] of [
        [0.2, 0.2],
        [0.2, 0],
        [0.4, 0],
      ] as const) {
        const now = keptWithin(rule, pc, ec, pb, eb);
        const before = pairedOdds(rule, answered(pc, ec), answered(pb, eb)).kept;
        rows.push(`baseline ${pb}, change ${pc.toFixed(2)}, errors on failing attempts ${ec} / ${eb}: kept at most ${pct(now)}, before ${pct(before)}`);
        expect(now, `${pb} ${ec} ${eb}`).toBeLessThanOrEqual(rule.risk);
        expect(before).toBeGreaterThan(rule.risk);
      }
    }
    console.log(rows.join('\n'));
  });

  it('decides on two tallies, kept on the one against keeping and broken on the one against breaking', () => {
    // A pair whose change attempt the provider cut short: worse against keeping, better against breaking.
    const kept = { better: 0, worse: 0, same: 38 };
    expect(decidePairedAround(kept, kept, rule)).toBe('kept');
    expect(decidePairedAround({ better: 0, worse: 1, same: 38 }, { better: 1, worse: 0, same: 38 }, rule)).toBe('continue');
    expect(() => decidePairedAround({ better: 0, worse: 0, same: 2 }, { better: 0, worse: 0, same: 3 }, rule)).toThrow();
    // At max pairs with neither, inconclusive.
    expect(decidePairedAround({ better: 30, worse: 40, same: 130 }, { better: 40, worse: 30, same: 130 }, rule)).toBe('inconclusive');
  });
});

describe('a good run against its golden’s history, when the provider cuts attempts short', { timeout: 600_000 }, () => {
  const rule: BaselineRule = { ...KEPT_DEFAULTS, risk: 0.05 };
  const history = { passes: 47, attempts: 50 };

  it('keeps a run that dropped by the margin at most its risk, the history’s own share included', () => {
    const b = historyBounds(history, rule.risk);
    // The change at the history's upper bound less the margin: the worst the kept test allows.
    const pc = b.hi - rule.margin;
    for (const e of [0, 0.2, 0.4]) {
      let walking = new Map<string, number>([['0,0,0', 1]]);
      let kept = 0;
      let keptBefore = 0;
      let before = new Map<string, number>([['0,0', 1]]);
      const answeredRate = pc / (pc + (1 - pc) * (1 - e));
      for (let n = 1; n <= rule.max; n++) {
        const next = new Map<string, number>();
        for (const [key, m] of walking) {
          const [s, att, u] = key.split(',').map(Number) as [number, number, number];
          for (const [ds, du, q] of [
            [1, 0, pc],
            [0, 0, (1 - pc) * (1 - e)],
            [0, 1, (1 - pc) * e],
          ] as const) {
            if (q <= 0) continue;
            const d = decideAgainstHistoryAround({ passes: s + ds, attempts: att + 1 }, u + du, history, rule);
            if (d === 'continue') next.set(`${s + ds},${att + 1},${u + du}`, (next.get(`${s + ds},${att + 1},${u + du}`) ?? 0) + m * q);
            else if (d === 'kept') kept += m * q;
          }
        }
        walking = next;
        const nextBefore = new Map<string, number>();
        for (const [key, m] of before) {
          const [s] = key.split(',').map(Number) as [number];
          for (const [ds, q] of [
            [1, answeredRate],
            [0, 1 - answeredRate],
          ] as const) {
            const d = decideAgainstHistory({ passes: s + ds, attempts: n }, history, rule);
            if (d === 'continue') nextBefore.set(`${s + ds},${n}`, (nextBefore.get(`${s + ds},${n}`) ?? 0) + m * q);
            else if (d === 'kept') keptBefore += m * q;
          }
        }
        before = nextBefore;
      }
      // The e-process's own share: the history's bound holding, the change at the worst the test allows.
      expect(kept, `e=${e}`).toBeLessThanOrEqual(rule.risk / 2);
      if (e >= 0.4) expect(keptBefore).toBeGreaterThan(rule.risk / 2);
    }
  });
});
