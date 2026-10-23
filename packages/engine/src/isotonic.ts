/**
 * Monotone fits by pool-adjacent-violators (PAVA): the weighted least-squares fit to `values` among
 * all sequences that never rise (antitonic), in one pass. Blame fits its probes' rescue rates this
 * way, because rescue gets harder the later it starts: a probe whose rate is above an earlier one's
 * is pooled with it, and the pooled rate is what both are read as.
 */

export interface Fitted {
  /** The fitted value at each point, in order; null for a point with no weight. */
  values: Array<number | null>;
  /**
   * The pooled blocks: points `from` to `to` (indexes, inclusive) fitted to one value. A block of
   * more than one weighted point is where the raw values rose and were pooled.
   */
  blocks: Array<{ from: number; to: number; value: number; weight: number }>;
}

/**
 * The non-increasing fit to `values` with `weights` (an attempt count each): the weighted mean of
 * each pooled block. Points with no weight take no part, and are left null; the blocks span them.
 */
export function antitonic(values: readonly number[], weights: readonly number[]): Fitted {
  if (values.length !== weights.length) throw new RangeError('values and weights must be as many');
  const blocks: Array<{ from: number; to: number; value: number; weight: number }> = [];
  for (let i = 0; i < values.length; i++) {
    const w = weights[i]!;
    const v = values[i]!;
    if (!(w >= 0) || !Number.isFinite(v)) throw new RangeError(`point ${i}: a weight of 0 or more and a finite value are needed`);
    if (w === 0) {
      // No evidence here: it joins the block before it, if any, without moving its value.
      if (blocks.length) blocks[blocks.length - 1]!.to = i;
      else blocks.push({ from: i, to: i, value: Number.NaN, weight: 0 });
      continue;
    }
    blocks.push({ from: i, to: i, value: v, weight: w });
    // Pool while the newest block rises above the one before it (a block with no weight yet takes the newest).
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      if (prev.weight > 0 && prev.value >= last.value) break;
      const weight = prev.weight + last.weight;
      const value = prev.weight === 0 ? last.value : (prev.value * prev.weight + last.value * last.weight) / weight;
      blocks.splice(blocks.length - 2, 2, { from: prev.from, to: last.to, value, weight });
    }
  }
  const out: Array<number | null> = values.map(() => null);
  for (const b of blocks) for (let i = b.from; i <= b.to; i++) out[i] = weights[i]! > 0 ? b.value : null;
  return { values: out, blocks: blocks.filter((b) => b.weight > 0) };
}
