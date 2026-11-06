import { permutationGreater } from './exact-tests.js';
import type { DecisionRank } from './decisions.js';

/**
 * Whether a change decides a step differently beyond the model's own variation. `decisions --samples
 * n` asks each step n times with the change swapped in, and n times exactly as recorded: the control.
 * A model asked the same request twice can answer otherwise, and the control says how often it does,
 * here, with these tools and this conversation. Each sample's decision is compared with the recorded
 * one and ranked (1, a write, to 5, text only; 0, the same), and scored by consequence, 5 for rank 1
 * down to 1 for text, 0 for the same.
 *
 * A step is ranked only when the change's scores run higher than the control's by more than chance
 * explains: an exact one-sided permutation test, over every way the 2n scores could have been split
 * between the arms (exact-tests.ts). When the change makes no difference to the step, both arms draw
 * from one distribution, and the test ranks the step at most `CONTROL_RISK` of the time, whatever that
 * distribution is. Each step is tested on its own: across many steps, one may be ranked by chance,
 * which is what `verify` settles. A ranked step takes the most consequential rank its changed samples
 * show more often than the unchanged ones do.
 *
 * With 3 samples a side, the least a split can come out is 1 in 20 (5%): a change is ranked when every
 * changed sample is more consequential than every unchanged one. Fewer samples can never reach 5%, so
 * the control is asked only from 3 on (`CONTROL_MIN_SAMPLES`).
 */

/** The most often a step a change doesn't affect is ranked. */
export const CONTROL_RISK = 0.05;

/** The fewest samples a side for which any split of the scores can reach `CONTROL_RISK`: 3, where the least is 1/20. */
export const CONTROL_MIN_SAMPLES = 3;

/**
 * The chance a step is ranked when the change has it decide otherwise `rate` of the time and it never
 * does as recorded, the easiest case there is: what a step that reads the same is worth. With fewer than
 * `CONTROL_MIN_SAMPLES` no control is asked, and more than half its samples must show the change.
 * More samples are not always better: the control's test is built against false alarms, so at 3 a side
 * every changed sample must show it.
 */
export function chanceRanked(samples: number, rate: number): number {
  const none: number[] = new Array<number>(samples).fill(0);
  let chance = 0;
  let ways = 1;
  for (let k = 0; k <= samples; k++) {
    const ranked = samples < CONTROL_MIN_SAMPLES ? k > samples / 2 : rankBeyondNoise(none.map((_, i) => (i < k ? 1 : 0)), none).rank !== null;
    if (ranked) chance += ways * rate ** k * (1 - rate) ** (samples - k);
    ways = (ways * (samples - k)) / (k + 1);
  }
  return chance;
}

/** A decision's consequence as a score: 5 for a write (rank 1) down to 1 for text only (rank 5); 0 when it decided as recorded. */
export const consequence = (rank: number): number => (rank >= 1 && rank <= 5 ? 6 - rank : 0);

/**
 * What the control says of a step: the one-sided exact p-value that the change's decisions are more
 * consequential than re-asking the recorded request makes them, and the rank it earns, null when that
 * is within the model's own variation. `changed` and `control` are each sample's rank (0: the same).
 */
export function rankBeyondNoise(changed: readonly number[], control: readonly number[], risk: number = CONTROL_RISK): { rank: DecisionRank | null; p: number } {
  if (!changed.length || !control.length) return { rank: null, p: 1 };
  const p = permutationGreater(changed.map(consequence), control.map(consequence));
  if (p > risk) return { rank: null, p };
  // The most consequential rank the changed samples show more often than the unchanged ones do.
  const atOrAbove = (ranks: readonly number[], t: number) => ranks.filter((r) => r >= 1 && r <= t).length / ranks.length;
  for (const t of [1, 2, 3, 4, 5] as const) if (atOrAbove(changed, t) > atOrAbove(control, t)) return { rank: t, p };
  return { rank: null, p };
}
