import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decideAgainstHistory, gateOdds, KEPT_DEFAULTS, SPRT_DEFAULTS, type BaselineRule, type SprtGate, type Tally } from '@shadowlap/engine';
import { describe, expect, it } from 'vitest';
import { CandidatePicker, mostDecided } from '../src/repair-pick.js';

/**
 * The chance a repair keeps a candidate that falls short, worked out exactly: every answer verify can
 * give, in the order the picker asks for them, each weighed by its chance. One verify of a candidate
 * passes as often as its gate passes a run at the candidate's rate (`gateOdds`, the gate's own exact
 * odds); each verify runs fresh attempts, so the answers are independent. The picker is the code under
 * test, as a black box; the tree, the weights and the measure are this test's.
 */

const GATE: SprtGate = { kind: 'sprt', ...SPRT_DEFAULTS };
const pass = (gate: SprtGate, rate: number) => gateOdds(gate, rate).pass;
const kind = (gate: SprtGate, rate: number): 'bad' | 'good' | 'between' => (rate <= gate.bad ? 'bad' : rate >= gate.good ? 'good' : 'between');

interface Kept {
  bad: number;
  good: number;
  none: number;
  /** The candidates decided, on average, and at most. */
  decided: number;
  most: number;
}

/** Thrown when the picker asks for an answer the path doesn't hold yet: the candidate it asked about. */
class More extends Error {
  constructor(readonly candidate: number) {
    super(`an answer for candidate ${candidate}`);
  }
}

/** Every path through the picker for candidates at `rates`, tried in that order at `gate`. */
async function exactly(gate: SprtGate, rates: readonly number[], o: { undecided?: ReadonlySet<number> } = {}): Promise<Kept> {
  const odds = rates.map((r) => pass(gate, r));
  const out: Kept = { bad: 0, good: 0, none: 0, decided: 0, most: 0 };
  const walk = async (answers: boolean[], weight: number): Promise<void> => {
    if (weight === 0) return;
    const picker = new CandidatePicker<number>(gate.risk);
    let asked = 0;
    try {
      await picker.pick(rates.map((_, i) => i), {
        stopped: () => false,
        verify: (i) => {
          if (o.undecided?.has(i)) return Promise.resolve('undecided');
          if (asked < answers.length) return Promise.resolve(answers[asked++] ? 'accepted' : 'rejected');
          throw new More(i);
        },
      });
    } catch (err) {
      if (!(err instanceof More)) throw err;
      const a = odds[err.candidate] ?? 0;
      await walk([...answers, true], weight * a);
      await walk([...answers, false], weight * (1 - a));
      return;
    }
    const k = picker.kept === null ? null : kind(gate, rates[picker.kept] ?? 0);
    if (k === 'bad') out.bad += weight;
    else if (k === 'good') out.good += weight;
    else if (k === null) out.none += weight;
    out.decided += weight * picker.decided;
    out.most = Math.max(out.most, picker.decided);
  };
  await walk([], 1);
  return out;
}

/** What the repair kept before: the first candidate the gate accepted once, each tried at full risk. */
function once(gate: SprtGate, rates: readonly number[]): { bad: number; good: number } {
  let reach = 1;
  const out = { bad: 0, good: 0 };
  for (const r of rates) {
    const a = pass(gate, r);
    const k = kind(gate, r);
    if (k !== 'between') out[k] += reach * a;
    reach *= 1 - a;
  }
  return out;
}

/** Every list of `k` rates drawn from `from`, in every order. */
function lists(from: readonly number[], k: number): number[][] {
  if (k === 0) return [[]];
  return lists(from, k - 1).flatMap((l) => from.map((r) => [...l, r]));
}

const pct = (x: number, places = 2) => `${(100 * x).toFixed(places)}%`;
const table: string[] = [];

describe('the candidate a repair keeps', { timeout: 120_000 }, () => {
  it('falls short within the gate’s 5% however the candidates tried fall, on a grid of up to 7 of them in every order', async () => {
    const grid = [...[1, 2, 3, 4].flatMap((k) => lists([0.6, 0.7, 0.8, 0.9, 1], k)), ...[5, 6, 7].flatMap((k) => [0.5, 0.6, 0.65, 0.68, 0.7, 0.8, 0.9].map((r) => Array<number>(k).fill(r)))];
    let worst = { bad: 0, rates: [] as number[] };
    for (const rates of grid) {
      const e = await exactly(GATE, rates);
      expect(e.bad, rates.join(' ')).toBeLessThanOrEqual(GATE.risk);
      // Each bad candidate verify decides passes both at most risk² of the time.
      expect(e.bad, rates.join(' ')).toBeLessThanOrEqual(e.decided * GATE.risk ** 2 + 1e-15);
      if (e.bad > worst.bad) worst = { bad: e.bad, rates };
    }
    // The worst is the most candidates, each just short.
    expect(worst.rates).toEqual(Array<number>(7).fill(0.7));
    table.push(`worst on the grid at 5%: ${pct(worst.bad, 3)} (${worst.rates.join(', ')})`);
  });

  it('keeps one of two, three or four candidates that each leave the run at 70% about 0.4–0.7% of the time, where keeping the first to pass kept one 8.4–16.1% of the time', async () => {
    for (const k of [2, 3, 4]) {
      const rates = Array<number>(k).fill(0.7);
      const before = once(GATE, rates).bad;
      const now = (await exactly(GATE, rates)).bad;
      expect(before).toBeGreaterThan(GATE.risk);
      expect(now).toBeLessThan(GATE.risk / 5);
      expect(now).toBeCloseTo(1 - (1 - pass(GATE, 0.7) ** 2) ** k, 12);
      table.push(`${k} candidates at 70%: kept ${pct(before)} before, ${pct(now, 3)} now`);
    }
  });

  it('pays for it in a good candidate’s attempts: one at 90% is kept 91.8% of the time, not 95.8%', async () => {
    const one = pass(GATE, 0.9);
    const e = await exactly(GATE, [0.9]);
    expect(e.good).toBeCloseTo(one * one, 12);
    table.push(`a candidate at 90%: kept ${pct(one, 1)} of the time verified once, ${pct(e.good, 1)} verified twice`);
    // Behind three that fall short, still nearly as often.
    const behind = await exactly(GATE, [0.7, 0.7, 0.7, 0.9]);
    expect(behind.good).toBeGreaterThan(0.9);
  });

  it('decides at most ⌊1/risk⌋ candidates, which a looser gate needs to keep its risk: at 20%, 10 just short would be kept 21.7% of the time', async () => {
    expect([0.05, 0.1, 0.2, 0.3, 0.01].map(mostDecided)).toEqual([20, 10, 5, 3, 100]);
    expect(mostDecided(null)).toBe(Infinity);
    const loose: SprtGate = { ...GATE, risk: 0.2 };
    const rates = Array<number>(10).fill(0.7);
    const e = await exactly(loose, rates);
    expect(e.most).toBe(5);
    expect(e.bad).toBeLessThanOrEqual(loose.risk);
    const a = pass(loose, 0.7);
    const unlimited = 1 - (1 - a * a) ** rates.length;
    expect(unlimited).toBeGreaterThan(loose.risk);
    table.push(`10 candidates at 70% at 20% risk: kept ${pct(e.bad)} deciding 5 at most, ${pct(unlimited)} deciding all 10`);
  });

  it('counts toward the limit only the candidates a gate decided', async () => {
    const loose: SprtGate = { ...GATE, risk: 0.3 };
    // Candidates 0 and 2 never reach a gate (an edit that won't apply, a build that fails).
    const e = await exactly(loose, [0.7, 0.7, 0.7, 0.7, 0.7], { undecided: new Set([0, 2]) });
    expect(e.most).toBe(3);
    expect(e.bad).toBeCloseTo(1 - (1 - pass(loose, 0.7) ** 2) ** 3, 12);
  });

  it('keeps none whose second verify could not run, such as a write the worktree refused, and tries the next', async () => {
    const picker = new CandidatePicker<string>(0.05);
    const kept = await picker.pick(['a', 'b'], { stopped: () => false, verify: (c, again) => Promise.resolve(c === 'a' && again ? 'undecided' : 'accepted') });
    expect(kept).toBe('b');
    expect(picker.decided).toBe(2);
  });

  it('keeps none the gate accepted once when the repair stops before the second verify', async () => {
    const picker = new CandidatePicker<string>(0.05);
    let stop = false;
    const asked: string[] = [];
    const kept = await picker.pick(['a', 'b'], {
      stopped: () => stop,
      verify: (c, again) => {
        asked.push(`${c}${again ? ' again' : ''}`);
        stop = true;
        return Promise.resolve('accepted');
      },
    });
    expect(kept).toBeNull();
    expect(picker.unconfirmed).toBe('a');
    expect(asked).toEqual(['a']);
  });

  it('as docs/repair.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/repair.md', import.meta.url)), 'utf8');
    const four = Array<number>(4).fill(0.7);
    const a = pass(GATE, 0.7);
    const good = pass(GATE, 0.9);
    const text = `of four candidates that each leave a failing run at 70%, one passes ${pct(once(GATE, four).bad, 1)} of the time. So the first the gate accepts is verified once more, with fresh attempts in a worktree of its own, and kept only if it passes again; one that doesn't is rejected, and the next is tried. Of those four, one is then kept ${pct(Math.ceil(10_000 * (1 - (1 - a * a) ** 4)) / 10_000)} of the time`;
    expect(page.includes(text), `docs/repair.md says: ${text}`).toBe(true);
    const cost = `one at 90% is kept ${pct(Math.floor(1000 * good * good) / 1000, 1)} of the time rather than ${pct(Math.floor(1000 * good) / 1000, 1)}`;
    expect(page.includes(cost), `docs/repair.md says: ${cost}`).toBe(true);
    console.log(table.join('\n'));
  });
});

/**
 * Under `verify.baseline: history`, a good run's two verifies compare it with the same history, so a
 * candidate that broke it is kept twice more often than two independent verifies would allow. Worked
 * out exactly: every history of `size` attempts the baseline could have left, and for each, every way
 * the change's attempts can come, decided by the engine's test against history (a black box).
 */
describe('the fix kept twice, when both verifies share a good run’s history', () => {
  const rule: BaselineRule = { ...KEPT_DEFAULTS, risk: 0.05 };
  const lnChoose = (n: number, k: number) => {
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
    return s;
  };
  /** The chance the change is kept against history `h` when it passes `pc` of the time. */
  const keptGiven = (h: Tally, pc: number): number => {
    let walking = new Map<number, number>([[0, 1]]);
    let kept = 0;
    for (let n = 1; n <= rule.max; n++) {
      const next = new Map<number, number>();
      for (const [s, m] of walking)
        for (const [s2, q] of [
          [s + 1, pc],
          [s, 1 - pc],
        ] as const) {
          const d = decideAgainstHistory({ passes: s2, attempts: n }, h, rule);
          if (d === 'continue') next.set(s2, (next.get(s2) ?? 0) + m * q);
          else if (d === 'kept') kept += m * q;
        }
      walking = next;
    }
    return kept;
  };

  it('is kept by both at most 0.0184% of the time, one of four such candidates at most 0.060%, as docs/repair.md states it', () => {
    let twice = 0;
    let ratio = 0;
    let four = 0;
    for (const pb of [0.95, 0.9, 0.8]) {
      const size = 50;
      const pc = pb - rule.margin;
      let once = 0;
      let same = 0;
      let any = 0;
      for (let s = 0; s <= size; s++) {
        const w = Math.exp(lnChoose(size, s) + s * Math.log(pb) + (size - s) * Math.log(1 - pb));
        if (w < 1e-14) continue;
        const k = keptGiven({ passes: s, attempts: size }, pc);
        once += w * k;
        same += w * k * k;
        any += w * (1 - (1 - k * k) ** 4);
      }
      // Kept once within the test's own risk; twice, more than independent verifies would give.
      expect(once).toBeLessThanOrEqual(rule.risk);
      expect(same).toBeGreaterThan(once * once);
      twice = Math.max(twice, same);
      ratio = Math.max(ratio, same / (once * once));
      four = Math.max(four, any);
    }
    const page = readFileSync(fileURLToPath(new URL('../../../docs/repair.md', import.meta.url)), 'utf8');
    const text = `is kept by both at most ${(Math.ceil(1e6 * twice) / 1e4).toFixed(4)}% of the time, up to ${Math.ceil(ratio)} times what two independent verifies allow, and one of four such candidates at most ${(Math.ceil(1e5 * four) / 1e3).toFixed(3)}%: still far within the 5%`;
    expect(page.includes(text), `docs/repair.md says: ${text}`).toBe(true);
  });
});
