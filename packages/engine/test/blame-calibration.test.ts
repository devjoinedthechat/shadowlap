import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decidePin, maxProbes, pinRisk, pinRule, probeGate, probeRisk, searchBlame, type BlameProbe, type BlameSearchResult, type PinCheck } from '../src/blame.js';
import { antitonic } from '../src/isotonic.js';
import { addPair, NO_PAIRS, pairedOdds } from '../src/noninferiority.js';
import { attemptsToFail, attemptsToPass, BLAME_DEFAULTS, decide, gateOdds, gateResult, type SprtGate } from '../src/stats.js';

/**
 * Blame's confidence is calibrated: whenever it says high, the run's true boundary is in the range it
 * reports at least 95% of the time. Seeded simulations of the whole search, its probes drawn from
 * known rescue rates, on the cases the review named: sharp drops, gradual decay, and runs no call
 * rescues. The true boundary of rates r_1 >= r_2 >= ... is the calls from the last whose rate is the
 * gate's `good` or more to the one before the first whose rate is `bad` or less; for a sharp drop
 * through both, one call; for a run no call rescues at `good`, "no call" (0). A range [from, to]
 * holds it when the two overlap, and "not rescued from any model call" is the range [0, 0]. Each
 * search checks a call it pins against the next with fresh pairs, as `shadowlap blame` does
 * (`PinCheck`), unless a test says otherwise.
 */

const GATE: SprtGate = { kind: 'sprt', ...BLAME_DEFAULTS };
const SCAN = 2;
const REPS = 1000;

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

/** The true boundary of a run's rescue rates, as steps: [last at good or more, the one before the first at bad or less]. */
function truth(rates: readonly number[]): [number, number] {
  let last = 0;
  rates.forEach((r, i) => {
    if (r >= GATE.good) last = i + 1;
  });
  const lost = rates.findIndex((r) => r <= GATE.bad);
  return [last, (lost < 0 ? rates.length + 1 : lost + 1) - 1];
}

interface Tally {
  high: number;
  highHeld: number;
  held: number;
  notRescuedHigh: number;
  /** Searches that said, with high confidence, the run was lost at one call; and those whose call passes no more often than the next. */
  pinnedHigh: number;
  pinnedFlat: number;
  /** Searches whose range is two calls, the run lost gradually around them, with high confidence. */
  gradualHigh: number;
  probes: number;
  attempts: number;
  /** The fewest and most attempts one search took, its checks' included. */
  least: number;
  most: number;
  labels: Record<'high' | 'medium' | 'low', number>;
}

/** REPS searches of a run with these rescue rates, each probe a gate at `perProbe(budget)`, a call they pin checked unless `check` is false. */
async function simulate(rates: readonly number[], seed: number, perProbe: (budget: number) => SprtGate = (b) => probeGate(GATE, b), o: { check?: boolean } = {}): Promise<Tally> {
  const steps = rates.map((_, i) => i + 1);
  const budget = maxProbes(steps.length, SCAN);
  const each = perProbe(budget);
  const risk = probeRisk({ gate: each });
  const rule = pinRule(each, budget);
  const random = seeded(seed);
  const [lo, hi] = truth(rates);
  const t: Tally = { high: 0, highHeld: 0, held: 0, notRescuedHigh: 0, pinnedHigh: 0, pinnedFlat: 0, gradualHigh: 0, probes: 0, attempts: 0, least: Infinity, most: 0, labels: { high: 0, medium: 0, low: 0 } };
  for (let rep = 0; rep < REPS; rep++) {
    const before = t.attempts;
    // Fresh pairs at the pinned call and the next, drawn at their rates, until the check decides.
    const pin = async (at: BlameProbe, next: BlameProbe): Promise<PinCheck> => {
      let c = NO_PAIRS;
      for (;;) {
        c = addPair(c, random() < rates[next.step - 1], random() < rates[at.step - 1]);
        t.attempts += 2;
        const d = decidePin(c, c, rule);
        if (d !== 'continue') return { callNo: at.callNo, next: next.callNo, verdict: d, dropped: c.worse, rose: c.better, same: c.same, passes: c.basePasses, nextPasses: c.passes, pairs: [], rule, risk: pinRisk(rule, d) };
      }
    };
    const r: BlameSearchResult = await searchBlame({
      steps,
      scan: SCAN,
      risk: GATE.risk,
      ...(o.check === false ? {} : { pin }),
      probe: async (callNo, step) => {
        const outcomes: boolean[] = [];
        let d = decide(0, 0, each);
        while (d === 'continue') {
          outcomes.push(random() < rates[step - 1]);
          d = decide(outcomes.filter(Boolean).length, outcomes.length, each);
        }
        t.probes++;
        t.attempts += outcomes.length;
        const p: BlameProbe = { callNo, step, passes: outcomes.filter(Boolean).length, rescued: d === 'pass', decision: d, gate: gateResult(each, outcomes, { decision: d }), attempts: outcomes.map((passed) => ({ runId: 'r', passed, exitCode: 0, failures: [], spent: 0, upstreamRequests: 1 })), risk };
        return p;
      },
    });
    t.labels[r.confidence]++;
    t.least = Math.min(t.least, t.attempts - before);
    t.most = Math.max(t.most, t.attempts - before);
    const [from, to] = r.outcome === 'unrescuable' ? [0, 0] : [r.range?.fromStep ?? -1, r.range?.toStep ?? -1];
    const held = from >= 0 && from <= hi && to >= lo;
    if (held) t.held++;
    if (r.confidence === 'high') {
      t.high++;
      if (held) t.highHeld++;
      if (r.outcome === 'unrescuable') t.notRescuedHigh++;
      if (r.outcome === 'blamed' && from === to) {
        t.pinnedHigh++;
        if (from < rates.length && rates[from - 1] <= rates[from]) t.pinnedFlat++;
      }
      if (r.outcome === 'blamed' && r.range?.gradual) t.gradualHigh++;
    }
  }
  return t;
}

const sharp = (m: number, k: number, top: number, bottom: number) => Array.from({ length: m }, (_, i) => (i + 1 <= k ? top : bottom));
const gradual = (m: number, flatTo: number, zeroAt: number, top: number) =>
  Array.from({ length: m }, (_, i) => {
    const k = i + 1;
    return k <= flatTo ? top : k >= zeroAt ? 0 : (top * (zeroAt - k)) / (zeroAt - flatTo);
  });

const CASES: Array<{ name: string; rates: number[] }> = [
  ...[3, 17, 29].flatMap((k) => [
    { name: `sharp at ${k} of 30, 0.95 to 0`, rates: sharp(30, k, 0.95, 0) },
    { name: `sharp at ${k} of 30, 0.8 to 0.05`, rates: sharp(30, k, 0.8, 0.05) },
    // Both sides on the gate's own rates: the hardest sharp drop it promises anything for.
    { name: `sharp at ${k} of 30, 0.6 to 0.1`, rates: sharp(30, k, 0.6, 0.1) },
  ]),
  { name: 'gradual, 0.9 to 0 over calls 15 to 25 of 30', rates: gradual(30, 15, 25, 0.9) },
  { name: 'gradual, 0.95 to 0 over calls 5 to 28 of 30', rates: gradual(30, 5, 28, 0.95) },
  { name: 'gradual, 1 to 0 over calls 2 to 12 of 12', rates: gradual(12, 2, 12, 1) },
  { name: 'no rescue, 0 from every call of 30', rates: Array(30).fill(0) },
  { name: 'no rescue, 0.05 from every call of 30', rates: Array(30).fill(0.05) },
  { name: 'no rescue, 0.1 from every call of 30', rates: Array(30).fill(0.1) },
];

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

/** What the simulations found, by case, for docs/blame.md's figures. */
const found = new Map<string, Tally>();
const figures: Record<string, number> = {};

describe("blame's confidence, by simulation", () => {
  it('holds the true boundary at least 95% of the time whenever it says high, on sharp, gradual and no-rescue runs, and says what it costs', async () => {
    const rows: string[] = [];
    for (const [i, c] of CASES.entries()) {
      const t = await simulate(c.rates, 1000 + i);
      found.set(c.name, t);
      const held = t.highHeld / Math.max(1, t.high);
      rows.push(`${c.name.padEnd(46)} high ${pct(t.high / REPS).padStart(6)} · held when high ${pct(held).padStart(6)} · held ${pct(t.held / REPS).padStart(6)} · ${(t.probes / REPS).toFixed(1)} probes, ${(t.attempts / REPS).toFixed(1)} attempts`);
      expect(t.high, c.name).toBeGreaterThan(REPS / 2);
      expect(held, c.name).toBeGreaterThanOrEqual(0.95);
    }
    console.log(`blame, gate ${JSON.stringify({ good: GATE.good, bad: GATE.bad, risk: GATE.risk, max: GATE.max })}, scan ${SCAN}, ${REPS} runs each\n${rows.join('\n')}`);
    // About 12 s of work alone, four times that beside the suite's other workers.
  }, 180_000);

  it('rarely calls a run rescued 45% of the time "not rescued from any model call" with high confidence, where 5% a probe did so 18% of the time', async () => {
    // The review's case: the first calls rescue the run 45% of the time, between the gate's two
    // rates, then nothing does. "No call rescues it 60%+ of the time" is true there, yet read plainly
    // it is the wrong lead. Splitting the risk across the probes makes each loss need more evidence.
    const rates = sharp(30, 17, 0.45, 0);
    const now = await simulate(rates, 45);
    const before = await simulate(rates, 45, () => GATE);
    console.log(`rescued 45% up to call 17 of 30: "not rescued" at high confidence ${pct(now.notRescuedHigh / REPS)} now, ${pct(before.notRescuedHigh / REPS)} at 5% a probe`);
    expect(before.notRescuedHigh / REPS).toBeGreaterThan(0.12);
    expect(now.notRescuedHigh / REPS).toBeLessThan(0.1);
    expect(now.notRescuedHigh).toBeLessThan(before.notRescuedHigh / 2);
  });
});

describe('the check of a pinned call, by simulation', { timeout: 180_000 }, () => {
  it('says a run whose rescue falls from 95% to 0 over calls 5 to 28 of 30 was lost at one call rarely, where without it 7 searches in 10 did', async () => {
    // The review's case: calls 13 to 25 sit between the gate's two rates, so every claim holds for any
    // neighbours there, and the binary search ends on two of them.
    const rates = gradual(30, 5, 28, 0.95);
    const now = await simulate(rates, 528);
    const before = await simulate(rates, 528, undefined, { check: false });
    console.log(`rescue 0.95 to 0 over calls 5 to 28 of 30: lost at one call with high confidence ${pct(now.pinnedHigh / REPS)} now, ${pct(before.pinnedHigh / REPS)} unchecked; lost gradually around two ${pct(now.gradualHigh / REPS)}; held when high ${pct(now.highHeld / now.high)}`);
    figures.gradualPinned = now.pinnedHigh / REPS;
    figures.gradualPinnedUnchecked = before.pinnedHigh / REPS;
    expect(before.pinnedHigh / REPS).toBeGreaterThan(0.6);
    expect(now.pinnedHigh / REPS).toBeLessThan(0.05);
    expect(now.gradualHigh / REPS).toBeGreaterThan(0.6);
    expect(now.highHeld / now.high).toBeGreaterThanOrEqual(0.95);
  });

  it('still pins sharp drops, and pins a call no more rescued than the next only about as often as the check may be wrong', async () => {
    for (const [name, rates, seed] of [
      ['0.95 to 0 at 17 of 30', sharp(30, 17, 0.95, 0), 17],
      ['0.6 to 0.1 at 17 of 30', sharp(30, 17, 0.6, 0.1), 61],
    ] as const) {
      const t = await simulate(rates, seed);
      console.log(`sharp ${name}: lost at one call with high confidence ${pct(t.pinnedHigh / REPS)}`);
      figures[`sharp ${name}`] = t.pinnedHigh / REPS;
      expect(t.pinnedHigh / REPS, name).toBeGreaterThan(0.85);
    }
    // Rescued 45% of the time up to call 17, then never: a pin inside the flat stretch is wrong.
    const rates = sharp(30, 17, 0.45, 0);
    const now = await simulate(rates, 4517);
    const before = await simulate(rates, 4517, undefined, { check: false });
    console.log(`rescued 45% up to call 17 of 30: a pin inside the flat stretch ${pct(now.pinnedFlat / REPS)} now, ${pct(before.pinnedFlat / REPS)} unchecked`);
    expect(before.pinnedFlat / REPS).toBeGreaterThan(0.05);
    expect(now.pinnedFlat / REPS).toBeLessThan(0.01);
  });
});

describe('docs/blame.md', () => {
  const page = () => readFileSync(fileURLToPath(new URL('../../../docs/blame.md', import.meta.url)), 'utf8');
  const says = (text: string) => expect(page().includes(text), `docs/blame.md says: ${text}`).toBe(true);
  const floor = (x: number) => `${(Math.floor(1000 * x + 1e-9) / 10).toFixed(1)}%`;

  it('states what the simulations found', { timeout: 180_000 }, async () => {
    // Each figure comes from a test above; run on its own, this one has nothing to check.
    if (!found.size || figures.gradualPinned === undefined || figures['sharp 0.6 to 0.1 at 17 of 30'] === undefined) return;
    const held = Math.min(...[...found.values()].map((t) => t.highHeld / Math.max(1, t.high)));
    says(`whenever blame says high, the range holds the true boundary at least ${floor(held)} of the time`);
    says(`blame says with high confidence that the run was lost at one call ${pct(figures.gradualPinned)} of the time, where unchecked it said so ${pct(figures.gradualPinnedUnchecked)} of the time; sharp drops from 95% to 0 and from 60% to 10% are still pinned ${Math.round(100 * figures['sharp 0.95 to 0 at 17 of 30'])}% and ${pct(figures['sharp 0.6 to 0.1 at 17 of 30'])} of the time`);
    // A search of 30 calls that blames one, on average: as blame runs it, and at the full 5% a probe with no check.
    const blamed = CASES.filter((c) => c.rates.length === 30 && !c.name.startsWith('no rescue'));
    const now = blamed.map((c) => found.get(c.name)!.attempts / REPS);
    const then: number[] = [];
    for (const [i, c] of blamed.entries()) then.push((await simulate(c.rates, 2000 + i, () => GATE, { check: false })).attempts / REPS);
    says(`a search of 30 calls takes ${Math.round(Math.min(...now))} to ${Math.round(Math.max(...now))} attempts on average where, at the full 5% a probe and unchecked, it took ${Math.round(Math.min(...then))} to ${Math.round(Math.max(...then))}, about three times as many`);
    expect(Math.min(...now) / Math.min(...then)).toBeGreaterThan(2.5);
    expect(Math.max(...now) / Math.max(...then)).toBeLessThan(3.5);
  });

  it('states what the check of a pinned call costs and risks, exactly', () => {
    const budget = maxProbes(30, SCAN);
    const each = probeGate(GATE, budget);
    const rule = pinRule(each, budget);
    const pairs = (at: number, next: number) => Math.round(pairedOdds(rule, next, at).attempts);
    says(`A sharp drop from 95% to 0 takes about ${pairs(0.95, 0)} pairs, one from 60% to 10% about ${pairs(0.6, 0.1)}, and two neighbours both near 40% about ${pairs(0.41, 0.37)}.`);
    // The probes' risks and the check's, all claimed at once, within the search's 5% at every budget a run of up to 2^20 model calls makes.
    for (let budget = maxProbes(2, SCAN); budget <= maxProbes(2 ** 20, SCAN); budget++) {
      const e = probeGate(GATE, budget);
      const r = pinRule(e, budget);
      expect(budget * probeRisk({ gate: e }) + Math.max(pinRisk(r, 'pinned'), pinRisk(r, 'gradual')), `${budget} probes`).toBeLessThanOrEqual(GATE.risk);
    }
    says('at the defaults the bound still keeps within 5% for a run of up to a million model calls');
    // A run rescued 45% of the time from its first calls, then never: the first probe loses it this often, and blame says not rescued, high.
    says(`with high confidence, about ${Math.round(100 * gateOdds(each, 0.45).fail)}% of the time`);
  });

  it('states what a probe takes and risks at its share, exactly', () => {
    // The shares of searches of 5 to 10 probes, runs of 3 to 128 model calls.
    const shares = [5, 6, 7, 8, 9, 10].map((p) => probeGate(GATE, p));
    expect([maxProbes(3, SCAN), maxProbes(128, SCAN)]).toEqual([5, 10]);
    expect(shares.map(attemptsToPass)).toEqual([3, 3, 3, 3, 3, 3]);
    expect(new Set(shares.map(attemptsToFail))).toEqual(new Set([6, 7]));
    says(`At a share of ${Math.round(100 * shares[0].risk)}% to ${+(100 * shares[5].risk).toFixed(1)}% (a search of 5 to 10 probes), three straight passes rescue and six or seven straight failures lose`);
    says(`(${GATE.max} at 5% becomes ${shares[0].max} to ${shares[5].max}: as far into the evidence)`);
    // A fixed count's probe, 2 of 5, at the gate's two rates.
    says(`(2 of 5: ${(Math.ceil(1000 * probeRisk({ attempts: 5, needed: 2 })) / 10).toFixed(1)}% a probe)`);
    // Between the two rates, at the share of 8 probes, a search of 17 to 32 model calls.
    const between = gateOdds(probeGate(GATE, 8), 0.3);
    says(`at a search's usual share of the risk is rescued ${Math.round(100 * between.pass)}% of the time, lost ${Math.round(100 * between.fail)}%, and left inconclusive ${Math.round(100 * between.inconclusive)}%`);
  });
});

describe('the isotonic fit', () => {
  it('pools a rise with the fall before it, weighted by attempts, and leaves falling rates alone', () => {
    expect(antitonic([0.9, 0.5, 0.1], [4, 4, 4]).values).toEqual([0.9, 0.5, 0.1]);
    // 0/5 then 4/5: one block at 4/10.
    const f = antitonic([1, 0, 0.8, 0], [5, 5, 5, 5]);
    expect(f.values).toEqual([1, 0.4, 0.4, 0]);
    expect(f.blocks.map((b) => [b.from, b.to])).toEqual([
      [0, 0],
      [1, 2],
      [3, 3],
    ]);
    // Weighted: 1 of 10 then 3 of 3 pool to 4 of 13.
    expect(antitonic([0.1, 1], [10, 3]).values[0]).toBeCloseTo(4 / 13, 12);
    // A point with no attempts takes no part.
    expect(antitonic([0.5, 0, 0.7], [2, 0, 2]).values).toEqual([0.6, null, 0.6]);
  });
});
