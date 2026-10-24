import { describe, expect, it } from 'vitest';
import { maxProbes, probeGate, probeRisk, searchBlame, type BlameProbe, type BlameSearchResult } from '../src/blame.js';
import { antitonic } from '../src/isotonic.js';
import { BLAME_DEFAULTS, decide, gateResult, type SprtGate } from '../src/stats.js';

/**
 * Blame's confidence is calibrated: whenever it says high, the run's true boundary is in the range it
 * reports at least 95% of the time. Seeded simulations of the whole search, its probes drawn from
 * known rescue rates, on the cases the review named: sharp drops, gradual decay, and runs no call
 * rescues. The true boundary of rates r_1 >= r_2 >= ... is the calls from the last whose rate is the
 * gate's `good` or more to the one before the first whose rate is `bad` or less; for a sharp drop
 * through both, one call; for a run no call rescues at `good`, "no call" (0). A range [from, to]
 * holds it when the two overlap, and "not rescued from any model call" is the range [0, 0].
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
  probes: number;
  attempts: number;
  labels: Record<'high' | 'medium' | 'low', number>;
}

/** REPS searches of a run with these rescue rates, each probe a gate at `perProbe(budget)`. */
async function simulate(rates: readonly number[], seed: number, perProbe: (budget: number) => SprtGate = (b) => probeGate(GATE, b)): Promise<Tally> {
  const steps = rates.map((_, i) => i + 1);
  const each = perProbe(maxProbes(steps.length, SCAN));
  const risk = probeRisk({ gate: each });
  const random = seeded(seed);
  const [lo, hi] = truth(rates);
  const t: Tally = { high: 0, highHeld: 0, held: 0, notRescuedHigh: 0, probes: 0, attempts: 0, labels: { high: 0, medium: 0, low: 0 } };
  for (let rep = 0; rep < REPS; rep++) {
    const r: BlameSearchResult = await searchBlame({
      steps,
      scan: SCAN,
      risk: GATE.risk,
      probe: async (callNo, step) => {
        const outcomes: boolean[] = [];
        let d = decide(0, 0, each);
        while (d === 'continue') {
          outcomes.push(random() < rates[step - 1]!);
          d = decide(outcomes.filter(Boolean).length, outcomes.length, each);
        }
        t.probes++;
        t.attempts += outcomes.length;
        const p: BlameProbe = { callNo, step, passes: outcomes.filter(Boolean).length, rescued: d === 'pass', decision: d, gate: gateResult(each, outcomes, { decision: d }), attempts: outcomes.map((passed) => ({ runId: 'r', passed, exitCode: 0, failures: [], spent: 0, upstreamRequests: 1 })), risk };
        return p;
      },
    });
    t.labels[r.confidence]++;
    const [from, to] = r.outcome === 'unrescuable' ? [0, 0] : [r.range?.fromStep ?? -1, r.range?.toStep ?? -1];
    const held = from >= 0 && from <= hi && to >= lo;
    if (held) t.held++;
    if (r.confidence === 'high') {
      t.high++;
      if (held) t.highHeld++;
      if (r.outcome === 'unrescuable') t.notRescuedHigh++;
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

describe("blame's confidence, by simulation", () => {
  it('holds the true boundary at least 95% of the time whenever it says high, on sharp, gradual and no-rescue runs, and says what it costs', async () => {
    const rows: string[] = [];
    for (const [i, c] of CASES.entries()) {
      const t = await simulate(c.rates, 1000 + i);
      const held = t.highHeld / Math.max(1, t.high);
      rows.push(`${c.name.padEnd(46)} high ${pct(t.high / REPS).padStart(6)} · held when high ${pct(held).padStart(6)} · held ${pct(t.held / REPS).padStart(6)} · ${(t.probes / REPS).toFixed(1)} probes, ${(t.attempts / REPS).toFixed(1)} attempts`);
      expect(t.high, c.name).toBeGreaterThan(REPS / 2);
      expect(held, c.name).toBeGreaterThanOrEqual(0.95);
    }
    console.log(`blame, gate ${JSON.stringify({ good: GATE.good, bad: GATE.bad, risk: GATE.risk, max: GATE.max })}, scan ${SCAN}, ${REPS} runs each\n${rows.join('\n')}`);
  });

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
