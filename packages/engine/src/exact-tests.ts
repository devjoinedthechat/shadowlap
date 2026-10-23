/**
 * Exact tests for the small samples blame and decisions compare: no normal approximation, no
 * nuisance parameter. Both condition on what the two samples hold together, so they are exact for any
 * common rate or distribution, and only conservative when one side is less likely than the other.
 */

/** ln C(n, k). */
function lnChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let s = 0;
  for (let i = 1; i <= Math.min(k, n - k); i++) s += Math.log((n - Math.min(k, n - k) + i) / i);
  return s;
}

/**
 * Fisher's exact test, one-sided: the chance that `x1` or more of the `x1 + x2` successes fall in the
 * first sample (`n1` draws) when both samples share one rate. A small value says the first sample's
 * rate is above the second's. For any rates with the first's at most the second's, the chance of a
 * value this small is at most the value itself.
 */
export function fisherGreater(x1: number, n1: number, x2: number, n2: number): number {
  for (const [x, n] of [
    [x1, n1],
    [x2, n2],
  ] as const) {
    if (!Number.isInteger(x) || !Number.isInteger(n) || x < 0 || n < 0 || x > n) throw new RangeError(`successes (${x}) and draws (${n}) must be whole numbers with 0 <= successes <= draws`);
  }
  const total = x1 + x2;
  const all = n1 + n2;
  if (all === 0 || total === 0) return 1;
  const denom = lnChoose(all, total);
  let p = 0;
  for (let k = x1; k <= Math.min(n1, total); k++) p += Math.exp(lnChoose(n1, k) + lnChoose(n2, total - k) - denom);
  return Math.min(1, p);
}

/**
 * An exact one-sided permutation test: the chance that `first`, drawn at random from the pooled
 * values as a sample of its size, sums to at least what it does. Every split of the pooled values is
 * counted once (by sizes and sums, not one by one), so it is exact for samples of whole-number scores
 * up to a few dozen. A small value says the first sample's scores run higher than the second's;
 * when both come from one distribution, a value this small comes at most that often.
 */
export function permutationGreater(first: readonly number[], second: readonly number[]): number {
  const pooled = [...first, ...second];
  if (!pooled.every((v) => Number.isInteger(v) && v >= 0 && v <= 1000)) throw new RangeError('scores must be whole numbers from 0 to 1000');
  const n = first.length;
  if (n === 0 || second.length === 0) return 1;
  const observed = first.reduce((s, v) => s + v, 0);
  const max = pooled.reduce((s, v) => s + v, 0);
  // ways[k][s]: subsets of the values seen so far with k members summing to s.
  let ways: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(max + 1));
  ways[0]![0] = 1;
  for (const v of pooled) {
    const next = ways.map((row) => Float64Array.from(row));
    for (let k = 0; k < n; k++) {
      const row = ways[k]!;
      const target = next[k + 1]!;
      for (let s = 0; s + v <= max; s++) if (row[s]) target[s + v] = target[s + v]! + row[s]!;
    }
    ways = next;
  }
  let atLeast = 0;
  let total = 0;
  for (let s = 0; s <= max; s++) {
    total += ways[n]![s]!;
    if (s >= observed) atLeast += ways[n]![s]!;
  }
  return Math.min(1, atLeast / total);
}
