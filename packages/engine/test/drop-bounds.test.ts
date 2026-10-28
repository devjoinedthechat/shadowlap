import { describe, expect, it } from 'vitest';
import { decidePaired, dropBound, dropEndsRisk, KEPT_DEFAULTS, pairedDrop, type BaselineDecision, type BaselineRule, type DropBound } from '../src/noninferiority.js';

/**
 * The bound on a good run's drop as its line prints it: each end rounded away from what it bounds,
 * so the line never says more than was worked out, and an undecided run's two ends each built at
 * half the risk, so its "(95%)" holds for the two together. Both worked out exactly: every tally the
 * paired test can stop on, and every way its pairs can come at a few pairs of pass rates.
 */

const RULE: BaselineRule = { ...KEPT_DEFAULTS, risk: 0.05 };

/** What a printed line claims: the ends it states, as numbers. */
function claims(line: string): { lo: number | null; hi: number | null } {
  const one = /^drop (<=|>=) (-?\d+\.\d\d) /.exec(line);
  if (one) return one[1] === '<=' ? { lo: null, hi: Number(one[2]) } : { lo: Number(one[2]), hi: null };
  const two = /^drop (\?|-?\d+\.\d\d) to (\?|-?\d+\.\d\d) /.exec(line)!;
  return { lo: two[1] === '?' ? null : Number(two[1]), hi: two[2] === '?' ? null : Number(two[2]) };
}

describe("a drop bound's line", () => {
  it('never says more than was worked out: an upper end rounds up, a lower one down, on every tally the paired test stops on to 80 pairs', () => {
    let lines = 0;
    for (let n = 1; n <= 80; n++)
      for (let a = 0; a <= n; a++)
        for (let b = 0; a + b <= n; b++) {
          const c = { better: a, worse: b, same: n - a - b };
          const d = decidePaired(c, RULE);
          if (d === 'continue') continue;
          const bound = pairedDrop(c, dropEndsRisk(d, RULE.risk));
          const line = dropBound(bound, d);
          if (!line) continue;
          lines++;
          const said = claims(line);
          if (said.hi !== null) expect(said.hi, line).toBeGreaterThanOrEqual(bound.hi! - 1e-12);
          if (said.lo !== null) expect(said.lo, line).toBeLessThanOrEqual(bound.lo! + 1e-12);
        }
    expect(lines).toBeGreaterThan(10_000);
  });

  it('rounds both ends of an undecided one away from what they bound, whatever they are', () => {
    for (let i = -1000; i <= 1000; i++) {
      const lo = i / 997;
      const hi = lo + 0.123;
      const said = claims(dropBound({ lo, hi, confidence: 0.95, method: 'betting' }, 'inconclusive')!);
      expect(said.lo!).toBeLessThanOrEqual(lo + 1e-12);
      expect(said.hi!).toBeGreaterThanOrEqual(hi - 1e-12);
      // And no further than the next hundredth.
      expect(lo - said.lo!).toBeLessThan(0.01 + 1e-12);
      expect(said.hi! - hi).toBeLessThan(0.01 + 1e-12);
    }
    expect(dropBound({ lo: -0.0001, hi: 0.07, confidence: 0.95, method: 'betting' }, 'inconclusive')).toBe('drop -0.01 to 0.07 (95%)');
    expect(dropBound({ lo: 0.12, hi: 0.5, confidence: 0.95, method: 'betting' }, 'broken')).toBe('drop >= 0.12 (95%)');
    expect(dropBound({ lo: 0, hi: 0.0700001, confidence: 0.95, method: 'betting' }, 'kept')).toBe('drop <= 0.08 (95%)');
  });
});

/**
 * Every way the pairs can come at a change passing `pc` and a baseline `pb` of the time, each pair's
 * two attempts independent: the chance the run ends undecided, and of those, how often the two ends
 * its line states miss the true drop, built as the line builds them (`each`: the risk each end is
 * built at), and how often any line the run ends with is false.
 */
function coverage(pc: number, pb: number, each: (d: BaselineDecision) => number): { undecided: number; twoFalse: number; anyFalse: number } {
  const up = pc * (1 - pb);
  const down = (1 - pc) * pb;
  const same = 1 - up - down;
  const drop = pb - pc;
  const wrong = (c: { better: number; worse: number; same: number }, d: BaselineDecision): boolean => {
    const b: DropBound = pairedDrop(c, each(d));
    if (d === 'kept') return b.hi !== null && drop > b.hi + 1e-12;
    if (d === 'broken') return b.lo !== null && drop < b.lo - 1e-12;
    return (b.lo !== null && drop < b.lo - 1e-12) || (b.hi !== null && drop > b.hi + 1e-12);
  };
  const out = { undecided: 0, twoFalse: 0, anyFalse: 0 };
  // Mass by (better, worse) after n pairs, still undecided.
  let walking = new Map<number, number>([[0, 1]]);
  const span = RULE.max + 2;
  for (let n = 1; n <= RULE.max; n++) {
    const next = new Map<number, number>();
    for (const [key, mass] of walking) {
      const a = Math.floor(key / span);
      const b = key % span;
      for (const [da, db, q] of [
        [1, 0, up],
        [0, 1, down],
        [0, 0, same],
      ] as const) {
        if (q <= 0) continue;
        const c = { better: a + da, worse: b + db, same: n - a - da - b - db };
        const d = decidePaired(c, RULE);
        const m = mass * q;
        if (d === 'continue') next.set(c.better * span + c.worse, (next.get(c.better * span + c.worse) ?? 0) + m);
        else {
          const no = wrong(c, d);
          if (no) out.anyFalse += m;
          if (d === 'inconclusive') {
            out.undecided += m;
            if (no) out.twoFalse += m;
          }
        }
      }
    }
    walking = next;
  }
  return out;
}

describe('an undecided run’s two-ended bound', { timeout: 180_000 }, () => {
  // Each end misses at most half the risk, by Ville's inequality on its e-process, so the two together
  // at most the risk: built at the whole risk each, the pair was only sure to hold at 90%.
  it('holds for its two ends together at its 95%, each built at half the risk, and every line its run ends with holds', () => {
    const rows: string[] = [];
    for (const [pb, pc] of [
      [0.8, 0.75],
      [0.6, 0.55],
      [0.9, 0.85],
    ] as const) {
      const now = coverage(pc, pb, (d) => dropEndsRisk(d, RULE.risk));
      const before = coverage(pc, pb, () => RULE.risk);
      rows.push(`pb ${pb}, pc ${pc}: undecided ${(100 * now.undecided).toFixed(1)}%; its two ends miss ${(100 * now.twoFalse / now.undecided).toFixed(3)}% of those, ${(100 * before.twoFalse / before.undecided).toFixed(3)}% built at the whole risk; any line false ${(100 * now.anyFalse).toFixed(3)}%`);
      expect(now.twoFalse / now.undecided).toBeLessThanOrEqual(RULE.risk);
      expect(now.anyFalse).toBeLessThanOrEqual(RULE.risk);
      expect(now.twoFalse).toBeLessThanOrEqual(before.twoFalse + 1e-15);
    }
    console.log(rows.join('\n'));
  });
});
