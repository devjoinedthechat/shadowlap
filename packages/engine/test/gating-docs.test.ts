import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_DEFAULTS,
  BLAME_DEFAULTS,
  SPRT_DEFAULTS,
  attemptsToFail,
  attemptsToPass,
  binomialTail,
  confidenceSequence,
  countOdds,
  decide,
  describeGate,
  formatTally,
  gateOdds,
  gateResult,
  passHatK,
  passesPerFailure,
  riskPercent,
  runsRed,
  sprtBounds,
  verdictLine,
  type BaselineGate,
  type Gate,
  type GateHistory,
  type GateOdds,
  type SprtGate,
  type Tally,
} from '../src/stats.js';
import { planSuite } from '../src/suite.js';

/**
 * docs/gating.md, figure by figure: each worked out here exactly, from the engine, and then found in
 * the page as the page writes it. A figure that drifts from what the code does fails this test, and
 * so does a page that rounds one another way. The printed bound's coverage is proven in
 * stats-bounds.test.ts, and the seeded simulations' figures in stats-simulation.test.ts and
 * gate-history-simulation.test.ts, each held to the page there.
 */
const PAGE = readFileSync(fileURLToPath(new URL('../../../docs/gating.md', import.meta.url)), 'utf8');

/** The page says this, word for word. */
const says = (text: string) => expect(PAGE.includes(text), `docs/gating.md says: ${text}`).toBe(true);
/** A share to a tenth of a point, as the page's tables write it: 97.7%. */
const pct = (x: number, places = 1) => `${(100 * x).toFixed(places)}%`;
/** A share to a whole point: 16%. */
const whole = (x: number) => `${Math.round(100 * x)}%`;

const sprt = (o: Partial<Omit<SprtGate, 'kind'>> = {}): SprtGate => ({ kind: 'sprt', ...SPRT_DEFAULTS, ...o });
const history = (o: Partial<Omit<BaselineGate, 'kind'>> = {}): BaselineGate => ({ kind: 'baseline', ...BASELINE_DEFAULTS, ...o });
const BLAME: SprtGate = { kind: 'sprt', ...BLAME_DEFAULTS };
const H47: GateHistory = { passes: 47, attempts: 50, sessions: 10 };

/** Attempts in an order a gate ends on at the last of them with `decision`, for a tally that order makes: the first such order. */
function endingAt(gate: Gate, passes: number, attempts: number, decision: 'pass' | 'fail' | 'inconclusive', h: Tally | null = null): boolean[] {
  for (let mask = 0; mask < 2 ** attempts; mask++) {
    const order = Array.from({ length: attempts }, (_, i) => ((mask >> i) & 1) === 1);
    if (order.filter(Boolean).length !== passes) continue;
    let seen = 0;
    let stop = -1;
    for (let n = 0; n < attempts; n++) {
      if (order[n]) seen++;
      if (decide(seen, n + 1, gate, h) !== 'continue') {
        stop = n;
        break;
      }
    }
    if (stop === attempts - 1 && decide(passes, attempts, gate, h) === decision) return order;
  }
  throw new Error(`no order of ${passes} of ${attempts} ends there`);
}

describe('docs/gating.md, figure by figure', () => {
  it('why a fixed count misleads: the binomial table, and what 4 of 5 does to a healthy suite', () => {
    for (const p of [0.95, 0.8, 0.7]) says(`| ${Math.round(100 * p)}% of the time | ${pct(binomialTail(5, 4, p))} of the time |`);
    // Through about half the time: 52.8%.
    expect(Math.round(2 * binomialTail(5, 4, 0.7))).toBe(1);
    const fails = 1 - binomialTail(5, 4, 0.95);
    says(`an agent that passes 95% of the time fails it ${pct(fails)} of the time, which across 100 forked goldens is about ${Math.round(100 * fails)} spurious failures per CI run, and at least one in about ${whole(runsRed(countOdds(5, 4, 0.95), 100))} of runs`);
  });

  it('a gate on a golden: its verdict lines, inconclusive at its limit, and either verdict between its rates', () => {
    const g = sprt();
    says(`✓ reference-agent: ${gateResult(g, Array(12).fill(true)).sentence}\n`);
    const failed = gateResult(g, [false, false, false]);
    says(`✗ reference-agent: ${failed.sentence}. Attempt 1:`);
    says(`    ${formatTally(failed)}\n`);
    // Four passes and a failure, sixteen times: never far enough either way, so inconclusive at 80.
    const sixtyFour = Array.from({ length: 16 }, () => [true, true, true, true, false]).flat();
    const unsure = gateResult(g, sixtyFour);
    expect(unsure).toMatchObject({ decision: 'inconclusive', passes: 64, attempts: 80, bound: { method: 'stagewise' } });
    says(`\`${unsure.sentence}\``);
    says(`an agent that passes 80% of the time is passed ${whole(gateOdds(g, 0.8).pass)} of the time`);
  });

  it('the sequential test: its steps, its bounds, and the errors Wald bounds', () => {
    const g = sprt();
    const b = sprtBounds(g);
    says(`a pass adds ln(9/7) ≈ ${b.pass.toFixed(4)}, a failure adds ln(1/3) ≈ ${b.fail.toFixed(4).replace('-', '−')}, and the bounds are ±ln 19 ≈ ±${b.upper.toFixed(3)}`);
    says(`accepted after ${attemptsToPass(g)} (11 × ${b.pass.toFixed(4)} is ${(11 * b.pass).toFixed(3)}, still short of ${b.upper.toFixed(3)})`);
    says(`rejected after ${attemptsToFail(g)};`);
    says(`each failure takes about ${passesPerFailure(g).toFixed(1)} more passes to make up for`);
    // One failure: 17 passes, 18 attempts; two: 21 passes.
    expect([decide(16, 17, g), decide(17, 18, g), decide(20, 22, g), decide(21, 23, g)]).toEqual(['continue', 'pass', 'continue', 'pass']);
    says('with one failure anywhere, it passes after 17 of 18; with two, it needs 21 passes');
    says(`passed at most α / (1 − β) of the time (${pct(g.risk / (1 - g.risk))} here)`);
    // And it keeps it, exactly, every look counted: at bad, passed at most that; at good, failed at most β / (1 − α).
    expect(gateOdds(g, g.bad).pass).toBeLessThanOrEqual(g.risk / (1 - g.risk));
    expect(gateOdds(g, g.good).fail).toBeLessThanOrEqual(g.risk / (1 - g.risk));
  });

  it('what a gate costs: the exact odds of each verdict, row by row', () => {
    const cells = (o: GateOdds) => `${pct(o.pass)} · ${pct(o.fail)} · ${pct(o.inconclusive)} · ${o.attempts.toFixed(1)}`;
    for (const p of [0.99, 0.95, 0.9, 0.8, 0.7, 0.5]) says(`| ${Math.round(100 * p)}% | ${pct(countOdds(5, 4, p).pass)} | ${cells(gateOdds(sprt(), p))} | ${cells(gateOdds(sprt({ max: 20 }), p))} |`);
    expect(gateOdds(sprt({ max: 20 }), 1).attempts).toBe(12);
    // A fifth of 95% agents run out at 20.
    expect(Math.round(1 / gateOdds(sprt({ max: 20 }), 0.95).inconclusive)).toBe(5);
    says(`An agent that always passes needs ${gateOdds(sprt(), 1).attempts} attempts whatever the limit, and one that passes 95% of the time ${gateOdds(sprt(), 0.95).attempts.toFixed(1)} on average at 80 (${gateOdds(sprt({ max: 20 }), 0.95).attempts.toFixed(1)} at 20, where a fifth of them run out)`);
    says(`up to ${Math.round(gateOdds(sprt(), 0.8).attempts)} on average for one at 80%`);
  });

  it('what a CI run sees: 100 goldens of a healthy agent, by how they are gated', () => {
    const goldens = 100;
    const perRun = (x: number) => (x >= 1 ? x.toFixed(1) : String(+x.toPrecision(2)));
    const four = countOdds(5, 4, 0.95);
    says(`| 4 of 5 | ${(goldens * four.fail).toFixed(2)} | 0 | ${whole(runsRed(four, goldens, 'fail'))} | ${whole(runsRed(four, goldens, 'warn'))} | ${four.attempts.toFixed(1)} |`);
    for (const max of [80, 40, 20]) {
      const o = gateOdds(sprt({ max }), 0.95);
      says(`| A gate per golden at its own 5%, \`max\` ${max} | ${(goldens * o.fail).toFixed(2)} | ${perRun(goldens * o.inconclusive)} | ${whole(runsRed(o, goldens, 'fail'))} | ${whole(runsRed(o, goldens, 'warn'))} | ${o.attempts.toFixed(1)} |`);
    }
    const plan = planSuite(Array.from({ length: goldens }, (_, i) => ({ golden: `goldens/g${i}`, gate: sprt(), maxGiven: false })))!;
    const split = gateOdds(plan.planned[0]!.gate, 0.95);
    expect(goldens * split.inconclusive).toBeLessThan(0.0001);
    const red = runsRed(split, goldens, 'fail');
    says(`| The default: 5% for the suite, split 100 ways | ${String(+(goldens * split.fail).toPrecision(1))} | under 0.0001 | ${(100 * red).toPrecision(2)}% | ${(100 * runsRed(split, goldens, 'warn')).toPrecision(2)}% | ${split.attempts.toFixed(2)} |`);
    const one = gateOdds(sprt(), 0.95);
    expect(Math.round(1 / runsRed(one, goldens, 'fail'))).toBe(6);
    says(`${pct(one.fail, 2)} of a healthy agent's goldens fail, and one in six runs goes red`);
    says(`a healthy suite then goes red about once in ${(Math.floor(1 / red / 1000) * 1000).toLocaleString('en-US')} runs, at ${split.attempts.toFixed(2)} attempts a golden instead of ${one.attempts.toFixed(1)}`);
  });

  it('one risk for the whole suite: the split, each gate’s share and limit, and what it costs', () => {
    const plan = planSuite(Array.from({ length: 100 }, (_, i) => ({ golden: `goldens/g${i}`, gate: sprt(), maxGiven: false, rate: 0.95, costPerAttempt: 0.025 })))!;
    const g = plan.planned[0]!.gate as SprtGate;
    says(`with 100, ${riskPercent(plan.perGoldenRisk)} each`);
    says(`With 100 goldens of \`"gate": {}\`, that is ${riskPercent(g.failRisk!)}: the gate fails only after about ${attemptsToFail(g)} straight failures, where it took ${attemptsToFail(sprt())}.`);
    // Its max: the fewest from 80 that leave at most half the share inconclusive at good.
    const room = Math.min(0.01, plan.perGoldenRisk / 2);
    expect(gateOdds(g, 0.9).inconclusive).toBeLessThanOrEqual(room);
    expect(gateOdds({ ...g, max: g.max - 1 }, 0.9).inconclusive).toBeGreaterThan(room);
    says(`With 100 goldens, ${g.max}.`);
    // Red at good: independent goldens exactly, and the split's bound whatever they share; better agents less.
    const atGood = gateOdds(g, 0.9);
    expect(plan.red).toBeCloseTo(100 * (atGood.fail + atGood.inconclusive), 12);
    says(`the default suite goes red ${pct(runsRed(atGood, 100))} of the time when its goldens are independent, and at most ${pct(plan.red, 2)} whatever they share; at 95%, ${(100 * runsRed(gateOdds(g, 0.95), 100)).toPrecision(2)}%.`);
    // A single golden keeps the default gate whole.
    expect(planSuite([{ golden: 'goldens/one', gate: sprt(), maxGiven: false }])!.planned[0]!.gate).toEqual(sprt());
    const single = gateOdds(sprt(), 0.9);
    expect(single.fail + single.inconclusive).toBeLessThanOrEqual(0.05);
    says(`the default gate, at ${pct(single.fail)} failed and ${pct(single.inconclusive)} inconclusive at its \`good\` rate, already fits the whole 5%`);
    says(`\`gate: ${describeGate(g)}\``);
    // What it costs.
    expect(attemptsToPass(g)).toBe(12);
    says(`from ln 19 to ln ${Math.exp(sprtBounds(g).upper).toFixed(2)} (ln((1 − β) / α)), so an agent that always passes still needs 12 attempts, and one at 95% takes ${gateOdds(g, 0.95).attempts.toFixed(2)} on average instead of ${gateOdds(sprt(), 0.95).attempts.toFixed(1)}`);
    const bad = gateOdds(g, 0.7);
    says(`still goes red ${whole(bad.fail + bad.inconclusive)} of the time, after ${bad.attempts.toFixed(1)} attempts on average instead of ${Math.round(gateOdds(sprt(), 0.7).attempts)}; one at 80% after ${gateOdds(g, 0.8).attempts.toFixed(1)}`);
    expect(runsRed(gateOdds(g, 0.8), 100)).toBeGreaterThan(0.9999);
    // The forecast's figures; the CLI's lines are held to the page in suite-plan.test.ts.
    expect(Math.round(plan.forecast.attempts)).toBe(1675);
    expect(plan.forecast.most).toBe(17_900);
    expect(plan.forecast.cost!).toBeCloseTo(41.87, 2);
  });

  it('a gate against history: its verdict lines, its false failures, the table of what it catches, and what a short history knows', () => {
    const g = history();
    const healthy = gateOdds(g, 0.95, H47);
    expect(Math.round(4 * 0.95 ** 5)).toBe(3);
    says(`one that passes 95% of the time passes after 5 in about three sessions of four (all 5 passed), and after ${healthy.attempts.toFixed(1)} attempts on average`);
    says(`\`${gateResult(g, Array(5).fill(true), { history: H47 }).sentence}\``);
    says(`\`${verdictLine(gateResult(g, endingAt(g, 4, 8, 'fail', H47), { history: H47 }))} · gate: …\``);
    // At the rate its history shows: failed as rarely as that, and most often against the weakest history.
    const own = ([[0.94, { passes: 47, attempts: 50 }], [0.95, { passes: 95, attempts: 100 }], [0.8, { passes: 40, attempts: 50 }], [0.6, { passes: 30, attempts: 50 }]] as const).map(([p, h]) => gateOdds(g, p, h).fail);
    expect(Math.max(...own)).toBe(own[3]);
    says(`an agent that passes as often as its history says is failed ${pct(own[0]!)} of the time against 47 of 50, and at most ${pct(own[3]!)} against a history that passes far less often (30 of 50)`);
    // The chance it fails a golden, inconclusive in brackets where it rounds to a tenth of a point or more.
    const cell = (o: GateOdds) => `${pct(o.fail)}${o.inconclusive >= 0.0005 ? ` (+${pct(o.inconclusive)})` : ''}`;
    for (const [name, h] of [['47 of 50', H47], ['95 of 100', { passes: 95, attempts: 100 }], ['50 of 50', { passes: 50, attempts: 50 }], ['5 of 5', { passes: 5, attempts: 5 }], ['none: its recording', null]] as const) {
      const cells = [0.95, 0.85, 0.75, 0.6, 0.5, 0.2].map((p) => cell(gateOdds(g, p, h)));
      says(`| ${name} | ${cells.join(' | ')} | ${gateOdds(g, 0.95, h).attempts.toFixed(1)} / ${gateOdds(g, 0.75, h).attempts.toFixed(1)} |`);
    }
    const now = (p: number) => gateOdds(g, p, H47).fail;
    // Three times in four, nine in ten; once at 5 attempts, a third and a half; 4 of 5, sixteen times the false failures.
    expect([Math.round(4 * now(0.6)), Math.round(10 * now(0.5))]).toEqual([3, 9]);
    const once = history({ max: 5 });
    says(`where deciding once at 5 attempts caught them ${whole(gateOdds(once, 0.6, H47).fail)} and ${whole(gateOdds(once, 0.5, H47).fail)} of the time, and 4 of 5, which fails a healthy agent ${Math.round(countOdds(5, 4, 0.95).fail / now(0.95))} times as often, ${whole(countOdds(5, 4, 0.6).fail)} and ${whole(countOdds(5, 4, 0.5).fail)}`);
    // 75% against 94%: a 19-point drop, failed a quarter of the time.
    expect(Math.round(4 * now(0.75))).toBe(1);
    says('75% against 94% is a 19-point drop, failed a quarter of the time');
    // After one session of 5: the baseline's 5% quantile (Beta(6, 1)) about 60%; a golden at 50% failed half the time, at 20% nearly always.
    expect(Math.round(10 * 0.05 ** (1 / 6))).toBe(6);
    const short = { passes: 5, attempts: 5 };
    expect(Math.round(2 * gateOdds(g, 0.5, short).fail)).toBe(1);
    expect(gateOdds(g, 0.2, short).fail).toBeGreaterThan(0.99);
    says('its baseline could still be anywhere from about 60% up, so it fails a golden now at 50% only half the time, and one at 20% nearly always');
    // No history: one at 20% mostly ends inconclusive.
    expect(gateOdds(g, 0.2, null).inconclusive).toBeGreaterThan(0.5);
    // 5 to 6 attempts for an unchanged agent.
    expect([gateOdds(g, 1, H47).attempts, Math.ceil(healthy.attempts)]).toEqual([5, 6]);
    says('costs 5 to 6 attempts for an unchanged agent');
  });

  it('reading the evidence: the closed form of 12 of 12, the anytime bound, the JSON, and pass^k', () => {
    const r = gateResult(sprt(), Array(12).fill(true));
    expect(r.interval.lo).toBeCloseTo(0.025 ** (1 / 12), 10);
    says(`its low end is the rate whose twelfth power is 2.5%: ${(0.025 ** (1 / 12)).toFixed(3)}`);
    says(`12 of 12 reads \`rate >= ${(Math.floor(100 * confidenceSequence(12, 12, 0.95).lo) / 100).toFixed(2)}\``);
    says(`\`{ "lo": ${Math.floor(1e5 * r.bound!.lo!) / 1e5}, "confidence": 0.95, "method": "stagewise" }\``);
    says(`18 of 20 gives pass^5 = 8,568 / 15,504 ≈ ${passHatK(18, 20, 5)!.toFixed(2)}, where 0.9⁵ would overstate it at ${(0.9 ** 5).toFixed(2)}`);
    says(`12 of 12 reads pass^5 ${passHatK(12, 12, 5)!.toFixed(2)} whatever the agent's rate`);
    says(`means pass^5 is at least 0.73⁵ = ${(Math.floor(1000 * 0.73 ** 5) / 1000).toFixed(3)}, at the same confidence`);
  });

  it('verify and blame: the default gate on a run, and blame’s on a probe', () => {
    says(`A run that passes 90% of the time ends inconclusive ${pct(gateOdds(sprt(), 0.9).inconclusive)} of the time at 80 attempts, where 40 left it so ${whole(gateOdds(sprt({ max: 40 }), 0.9).inconclusive)}.`);
    says(`a call the model gets right 30% of the time is rescued ${whole(gateOdds(BLAME, 0.3).pass)} of the time`);
    says(`A call the model gets right 30% of the time ends inconclusive ${pct(gateOdds(BLAME, 0.3).inconclusive)} of the time, where 10 attempts left it so ${whole(gateOdds({ ...BLAME, max: 10 }, 0.3).inconclusive)}.`);
    expect([attemptsToPass(BLAME), attemptsToFail(BLAME)]).toEqual([2, 4]);
    says('Two straight passes rescue and four straight failures lose');
  });
});
