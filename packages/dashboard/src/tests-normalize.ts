import { sameRule, type Normalizer, type VolatileValues } from '@shadowlap/engine';

/**
 * Add normalizer and update, for several goldens at once: the rules it adds for one of them, before
 * the update re-records them all. Beside tests.ts, which is at its length: GET /api/tests says them
 * for each diverged golden, and the job (routes/tests.ts) adds them.
 */

/**
 * The rules Add normalizer and update adds for a golden among several: one for each value its last
 * replay diverged on that is made anew on every run, never an id that may be a real change (the
 * person names no value here, as one golden's Add normalizer has them do), and none `there` already:
 * the config's rules, and those added for the goldens before it, so each rule is added once.
 */
export function rulesToAdd(volatile: VolatileValues, there: readonly Normalizer[]): Normalizer[] {
  const out: Normalizer[] = [];
  for (const v of volatile.values) if (v.certain && ![...there, ...out].some((r) => sameRule(r, v.normalizer))) out.push(v.normalizer);
  return out;
}
