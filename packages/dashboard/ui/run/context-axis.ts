/**
 * Context's two axes, as the mock draws them. Input and output each get one with its labels: on the
 * input's scale, an output of 40 tokens beside a 1,000-token input would be a sliver, so the output's
 * axis runs down from the baseline on a scale of its own. No DOM here: the tests import it.
 */

const STEPS = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000] as const;

/** A tick's label: `1000` reads `1k`, `2500` reads `2.5k`. */
export const tickLabel = (v: number): string => (v >= 1000 ? `${v / 1000}k` : String(v));

/**
 * The input axis's ticks for the largest context `max`, from 0: by the first step of 100, 200, 500,
 * 1000 and on to 50000 that gives at most four above 0, else by 100000.
 */
export function inputTicks(max: number): number[] {
  const step = STEPS.find((x) => max / x <= 4) ?? 100_000;
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  return ticks;
}

/** The output axis's top for the largest output `most`: the next 50 up, at least 50. Its labels are the half and the top. */
export function outputTop(most: number): number {
  return Math.ceil(Math.max(0, most) / 50) * 50 || 50;
}
