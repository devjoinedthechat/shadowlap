import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTROL_RISK, rankBeyondNoise } from '../src/control-arm.js';
import { fisherGreater } from '../src/exact-tests.js';

/**
 * The two small-sample tests blame and decisions lean on hold their size, worked out exactly on a
 * grid rather than taken from their proofs: Fisher's one-sided test, which says whether rescue rose
 * past a call found lost by more than chance explains (blame.ts), and the control arm's permutation
 * test, which ranks a decisions step only beyond the model's own variation (control-arm.ts). Each is
 * the chance, under the null, that the test says "beyond chance", summed over every outcome.
 */

/** ln C(n, k). */
function lnChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i);
  return s;
}
const binomial = (n: number, k: number, p: number) => Math.exp(lnChoose(n, k) + (k ? k * Math.log(p) : 0) + (n - k ? (n - k) * Math.log(1 - p) : 0));

describe("Fisher's exact test, one-sided", () => {
  it('says the first rate is above the second at most alpha of the time when they are equal, on a grid of sizes, rates and levels', () => {
    let worst = 0;
    for (const alpha of [0.05, 0.01, 0.00625])
      for (let n1 = 1; n1 <= 24; n1 += n1 < 8 ? 1 : 4)
        for (let n2 = 1; n2 <= 24; n2 += n2 < 8 ? 1 : 4)
          for (const p of [0.02, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 0.98]) {
            let size = 0;
            for (let x1 = 0; x1 <= n1; x1++) for (let x2 = 0; x2 <= n2; x2++) if (fisherGreater(x1, n1, x2, n2) <= alpha) size += binomial(n1, x1, p) * binomial(n2, x2, p);
            expect(size, `n1 ${n1}, n2 ${n2}, p ${p}, alpha ${alpha}`).toBeLessThanOrEqual(alpha + 1e-12);
            worst = Math.max(worst, size / alpha);
          }
    // Conservative, as an exact conditional test of discrete counts is: never at its level, here.
    expect(worst).toBeLessThan(1);
    console.log(`Fisher's one-sided test, worst size on the grid: ${(100 * worst).toFixed(1)}% of its level`);
  });

  it('and less often still when the first rate is below the second', () => {
    for (const [n1, n2, p1, p2] of [
      [6, 6, 0.3, 0.5],
      [10, 4, 0.2, 0.6],
      [4, 12, 0.45, 0.5],
    ] as const) {
      let size = 0;
      for (let x1 = 0; x1 <= n1; x1++) for (let x2 = 0; x2 <= n2; x2++) if (fisherGreater(x1, n1, x2, n2) <= 0.05) size += binomial(n1, x1, p1) * binomial(n2, x2, p2);
      expect(size).toBeLessThanOrEqual(0.05);
    }
  });
});

/** Every multiset of `n` draws from `k` kinds, as counts, with its chance under `probs`. */
function multisets(n: number, probs: readonly number[]): Array<{ counts: number[]; p: number }> {
  const out: Array<{ counts: number[]; p: number }> = [];
  const lnFact = (m: number) => {
    let s = 0;
    for (let i = 2; i <= m; i++) s += Math.log(i);
    return s;
  };
  const walk = (i: number, left: number, counts: number[]) => {
    if (i === probs.length - 1) {
      const c = [...counts, left];
      let ln = lnFact(n);
      for (let j = 0; j < c.length; j++) {
        if (c[j] > 0 && probs[j] === 0) return;
        ln += (c[j] ? c[j] * Math.log(probs[j]) : 0) - lnFact(c[j]);
      }
      out.push({ counts: c, p: Math.exp(ln) });
      return;
    }
    for (let k = 0; k <= left; k++) walk(i + 1, left - k, [...counts, k]);
  };
  walk(0, n, []);
  return out;
}
const ranksOf = (counts: readonly number[]) => counts.flatMap((c, rank) => Array<number>(c).fill(rank));

/** Whether the control ranks a step, by both arms' counts: worked out once for every variation that can show them. */
const ranked = new Map<string, boolean>();

/** The chance the control ranks a step the change leaves alone: both arms' ranks drawn from `probs` (rank 0, the same, to rank 5). */
function controlSize(probs: readonly number[], changed: number, control: number): number {
  const a = multisets(changed, probs);
  const b = multisets(control, probs);
  let size = 0;
  for (const x of a)
    for (const y of b) {
      const key = `${x.counts.join('')}|${y.counts.join('')}`;
      let r = ranked.get(key);
      if (r === undefined) ranked.set(key, (r = rankBeyondNoise(ranksOf(x.counts), ranksOf(y.counts)).rank !== null));
      if (r) size += x.p * y.p;
    }
  return size;
}

describe("the control arm's permutation test", () => {
  // The model's own variation, rank 0 (decided as recorded) to rank 5 (text only).
  const variations: Array<[string, number[]]> = [
    ['writes otherwise half the time', [0.5, 0.5, 0, 0, 0, 0]],
    ['nearly always the same', [0.9, 0.04, 0.02, 0.02, 0.01, 0.01]],
    ['every rank alike', [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6]],
    ['text that varies', [0.3, 0, 0, 0, 0.1, 0.6]],
    ['a write or a stop now and then', [0.7, 0.15, 0.15, 0, 0, 0]],
  ];

  it('ranks a step the change leaves alone at most 5% of the time, for every variation on the grid, 3 to 6 samples a side (to 5 where every rank can come), equal or not', { timeout: 180_000 }, () => {
    let worst = 0;
    for (const [name, probs] of variations)
      for (let changed = 3; changed <= 6; changed++)
        for (let control = 3; control <= 6; control++) {
          // Where every rank can come, up to 5 a side: the rest of the grid is the variations with fewer ranks.
          if (probs.every((x) => x > 0) && (changed > 5 || control > 5)) continue;
          const size = controlSize(probs, changed, control);
          expect(size, `${name}, ${changed} and ${control}`).toBeLessThanOrEqual(CONTROL_RISK + 1e-12);
          worst = Math.max(worst, size);
        }
    expect(worst).toBeLessThan(CONTROL_RISK);
    console.log(`the control's size, worst on the grid: ${(100 * worst).toFixed(2)}%`);
  });

  it('as docs/decisions.md states it', () => {
    const page = readFileSync(fileURLToPath(new URL('../../../docs/decisions.md', import.meta.url)), 'utf8');
    const half = controlSize(variations[0][1], 3, 3);
    const text = `one that writes otherwise half the time unasked is ranked ${(Math.ceil(1000 * half) / 10).toFixed(1)}% of the time at 3 samples`;
    expect(page.includes(text), `docs/decisions.md says: ${text}`).toBe(true);
  });
});
