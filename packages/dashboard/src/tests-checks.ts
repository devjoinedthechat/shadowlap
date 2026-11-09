import { checkStatus, type CheckStatus, type StoreOf, type StoredCheck, type TestResult } from '@shadowlap/engine';

/*
 * A golden's checks on Tests: how its last result came out on each, and what changed in its entry
 * since. The tests read model (tests.ts) puts them on each row.
 */

/**
 * One of a golden's checks, with how its last result came out on it: what the table marks it by
 * (✓ passed, ✗ failed, ? inconclusive, – not applicable, and no mark without one).
 */
export interface GoldenCheck {
  /** As the CLI labels it. */
  label: string;
  /**
   * Its status in the last result, in the attempt that result shows; null when the golden hasn't run
   * yet, when its last test couldn't run it, or when the check was `added` since.
   */
  status: CheckStatus | null;
  /**
   * No status because the check is newer than the last result: that result judged the checks the
   * golden had then, and this one wasn't among them (added to the config since, or changed, which
   * reads as a new check). Its next test judges it.
   */
  added: boolean;
  /** The result's words for it: what it found when it failed, why it couldn't be decided or didn't apply. */
  detail: string | null;
  /** A judge check: its reason for the verdict, and where the verdict came from (the recording, or the judge asked live). */
  reason: string | null;
  source: 'recording' | 'live' | null;
  /**
   * A judge check whose verdict was asked live: what asking it cost (USD) and in how many attempts it
   * was asked, from the result's judge summary when it is the result's only judge check, else in the
   * attempt shown for a result of one attempt. Null for a verdict from the recording (free), for a
   * judge model with no price, and for any other check.
   */
  live: { cost: number; asked: number } | null;
  /**
   * A golden run more than once in its last result: of the attempts that judged this check, how many
   * passed it. Null for one attempt, when an attempt's run is no longer in the store, or when the
   * result carried attempts over from an earlier session (`test --continue`), whose runs pruning thins.
   */
  attempts: { passed: number; of: number } | null;
}


/**
 * For a result of more than one attempt: of the attempts that judged each check (it passed, failed or
 * couldn't be decided there), how many passed it, by label. Each attempt's run keeps its checks. Null
 * for a single attempt, when a run is gone, or for a result that carried attempts over from an earlier
 * session (`test --continue`): its `attempts` are this session's alone, and pruning keeps only some of
 * the carried ones' runs. A tally missing an attempt would claim too much.
 */
function checkTallies(store: StoreOf<'recording'>, r: TestResult): Map<string, { passed: number; of: number }> | null {
  const runs = r.data?.attempts?.runs ?? [];
  if (runs.length < 2 || r.data?.continued) return null;
  const out = new Map<string, { passed: number; of: number }>();
  for (const id of runs) {
    const run = store.getRun(id);
    if (!run) return null;
    const seen = new Set<string>();
    for (const c of run.meta?.checks ?? []) {
      // A label once per attempt; a check that did not apply there says nothing either way.
      if (seen.has(c.label)) continue;
      seen.add(c.label);
      const status = checkStatus(c);
      if (status === 'not-applicable') continue;
      const t = out.get(c.label) ?? { passed: 0, of: 0 };
      t.of++;
      if (status === 'passed') t.passed++;
      out.set(c.label, t);
    }
  }
  return out;
}

/**
 * What asking a judge check's verdict live cost, and in how many attempts it was asked: the result's
 * judge summary (every attempt) when this is the result's only judge check and every judge model in it
 * has a price; else, for a result of one attempt, the check's own call. Null for a verdict from the
 * recording, which is free, and when the cost isn't known.
 */
function judgeLive(r: TestResult, c: StoredCheck): GoldenCheck['live'] {
  if (c.source !== 'live' || !c.judge) return null;
  const s = r.data?.judge;
  const judges = (r.data?.checks ?? []).filter((x) => x.judge).length;
  if (s && judges === 1 && s.live > 0 && !s.unknownModels.length) return { cost: s.spent, asked: s.live };
  return (r.data?.attempts?.total ?? 1) <= 1 && c.judge.cost !== null ? { cost: c.judge.cost, asked: 1 } : null;
}

/**
 * A golden's checks with how its last result came out on each: the status the attempt it shows kept
 * for it (the CLI judges a diverged replay's checks too, and fails what it didn't do), where a judge's
 * verdict came from and what asking it live cost, and over several attempts, how many passed it. A
 * check the result didn't judge has no status, as none has before the golden's first result: one added
 * since (the result judged the golden's checks of then), or one whose golden couldn't run.
 */
export function goldenChecks(store: StoreOf<'recording'>, labels: readonly string[], r: TestResult | null): GoldenCheck[] {
  const kept = r?.data?.checks ?? [];
  // The golden ran, and its checks of then were judged (none, if it had none): a check it lacks is newer.
  const ran = !!r && (r.data?.checks !== undefined || r.data?.calls !== undefined);
  const used = new Set<number>();
  const tallies = r && labels.length ? checkTallies(store, r) : null;
  return labels.map((label) => {
    const i = kept.findIndex((c, j) => !used.has(j) && c.label === label);
    if (i < 0) return { label, status: null, added: ran, detail: null, reason: null, source: null, live: null, attempts: null };
    used.add(i);
    const c = kept[i]!;
    const tally = tallies?.get(label);
    return { label, status: checkStatus(c), added: false, detail: c.detail ?? null, reason: c.reason ?? null, source: c.source ?? null, live: judgeLive(r!, c), attempts: tally && tally.of > 1 ? tally : null };
  });
}
