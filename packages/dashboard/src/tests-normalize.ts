import { sameRule, volatileValues, type CallKind, type DivergenceReport, type Normalizer, type TestResult, type VolatileValues } from '@shadowlap/engine';

/**
 * A golden's stored divergence and the values in it made anew on every run, which a normalizer
 * masks: as a report, as the values it was judged on, and the rules Add normalizer and update adds
 * for several goldens at once before the update re-records them all. Beside tests.ts, which is at
 * its length: GET /api/tests says the rules for each diverged golden, and the job (routes/tests.ts)
 * adds them.
 */

/** A result's stored divergence as the report it was made from; null for a result that didn't diverge. */
export function divergenceOf(r: TestResult): DivergenceReport | null {
  const d = r.data?.divergence;
  if (!d) return null;
  const report: DivergenceReport = { type: d.type as DivergenceReport['type'], callNo: d.callNo, kind: d.kind as CallKind, name: d.name, replayedBefore: d.replayedBefore };
  if (d.diff) report.diff = d.diff as NonNullable<DivergenceReport['diff']>;
  if (d.hints) report.hints = d.hints;
  return report;
}

/** What volatileValues() made of a stored divergence: judged on all its changes when it was recorded. */
export function volatileOf(r: TestResult, d: DivergenceReport): VolatileValues {
  const kept = r.data?.divergence?.volatile;
  return kept ? storedVolatile(kept) : volatileValues(d);
}

/** Stored values, with what a result kept before ids were told apart read as it was meant then. */
export function storedVolatile(kept: NonNullable<NonNullable<NonNullable<TestResult['data']>['divergence']>['volatile']>): VolatileValues {
  return { values: kept.values.map((v) => ({ ...v, certain: v.certain ?? true })), explainsAll: kept.explainsAll, coversAll: kept.coversAll ?? kept.explainsAll };
}

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
