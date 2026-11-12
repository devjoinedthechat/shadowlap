import { checkStatus, judgeLabel, judgeSourceParts, parseExpect, testResultVerdict, type CheckStatus, type StoreOf, type StoredCheck, type TestResult } from '@shadowlap/engine';
import { judgeAsked } from './golden-report.js';
import type { GoldenSource, TestsView, UnjudgedCheck } from './tests.js';

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
  /**
   * When the check builder added it (ms): the newest `checks.changed` event for its golden that added
   * its label, after the last result. Null for one added in an editor, before the last result, or
   * with no last result.
   */
  addedAt: number | null;
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
  /**
   * A judge check: what it asks and the model it names, as the golden's entry holds them (null where
   * the entry names no such judge or can't be read: `withJudgeAsks`), the verdict its last result
   * kept, and where that verdict came from and what it cost in the engine's words, at the cost `live`
   * gives (null before it was judged), and for one a replay couldn't judge offline, what the golden's
   * pack holds for it (`heldVerdict`: none, an older one, one on other material; null otherwise). Null
   * for any other check.
   */
  judge: { question: string | null; model: string | null; verdict: 'yes' | 'no' | null; judged: JudgedParts | null; held: UnjudgedCheck['held'] } | null;
}

/** Where a judge's verdict came from (`judged live`), what that cost (null where the result doesn't say) and what was done to what it read, as the engine words them: a page joins them with ` · `. */
export interface JudgedParts {
  how: string;
  cost: string | null;
  read: string[];
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
 * What a golden's pack holds for a judge check its test couldn't decide, read from the CLI's words for
 * why (`whyNotAnswered` in the CLI's judge.ts): no verdict, one given to an older form of the judge's
 * request, or one given on other material, with where it differs. Null for any other reason. Tests'
 * judge cards and its inconclusive report (tests.ts' `unjudgedCheck`) read it alike.
 */
export function heldVerdict(why: string): Pick<UnjudgedCheck, 'held' | 'changed'> {
  const w = why.replace(/^not judged: /, '');
  if (w.startsWith('no recorded verdict')) return { held: 'none', changed: null };
  if (w.startsWith("the recording's verdict was given to an older form of the judge's request")) return { held: 'older', changed: null };
  // `…on other material: it read "…" where it now reads "…", and <why the judge couldn't be asked>`, the last clause without a comma.
  const other = /^the recording's verdict was given on other material(?:: (it read [\s\S]*))?, and [^,]*$/.exec(w);
  if (other) return { held: 'material', changed: other[1] ?? null };
  return { held: null, changed: null };
}

/**
 * A judged check's judge, as its result kept it: the model that answered, its verdict, and where that
 * came from and what it cost by the engine's words, at the cost Tests gives (`live`), which for a
 * verdict asked over several attempts beside other judges the result doesn't say. For one a replay,
 * offline, couldn't decide: what the pack holds for it, by the CLI's words for why.
 */
function judgeOf(r: TestResult, c: StoredCheck, live: GoldenCheck['live']): GoldenCheck['judge'] {
  if (!c.judge) return null;
  const parts = judgeSourceParts(live ? { ...c.judge, cost: live.cost } : c.judge);
  const judged = parts && c.judge.source === 'live' && !live && c.judge.cost !== null ? { ...parts, cost: null } : parts;
  const held = checkStatus(c) === 'inconclusive' && r.data?.mode !== 'fork' ? heldVerdict(c.detail ?? '').held : null;
  return { question: null, model: c.judge.model, verdict: c.judge.verdict, judged, held };
}

/**
 * A golden's checks with how its last result came out on each: the status the attempt it shows kept
 * for it (the CLI judges a diverged replay's checks too, and fails what it didn't do), where a judge's
 * verdict came from and what asking it live cost, and over several attempts, how many passed it. A
 * check the result didn't judge has no status, as none has before the golden's first result: one added
 * since (the result judged the golden's checks of then), or one whose golden couldn't run.
 */
export function goldenChecks(store: StoreOf<'recording'>, labels: readonly string[], r: TestResult | null, addedAt: (label: string) => number | null = () => null): GoldenCheck[] {
  const kept = r?.data?.checks ?? [];
  // The golden ran, and its checks of then were judged (none, if it had none): a check it lacks is newer.
  const ran = !!r && (r.data?.checks !== undefined || r.data?.calls !== undefined);
  const used = new Set<number>();
  const tallies = r && labels.length ? checkTallies(store, r) : null;
  return labels.map((label) => {
    const i = kept.findIndex((c, j) => !used.has(j) && c.label === label);
    if (i < 0) {
      const at = ran ? addedAt(label) : null;
      return { label, status: null, added: ran, addedAt: at !== null && at > r!.at ? at : null, detail: null, reason: null, source: null, live: null, attempts: null, judge: null };
    }
    used.add(i);
    const c = kept[i]!;
    const tally = tallies?.get(label);
    const live = judgeAsked(r!, c);
    return { label, status: checkStatus(c), added: false, addedAt: null, detail: c.detail ?? null, reason: c.reason ?? null, source: c.source ?? null, live, attempts: tally && tally.of > 1 ? tally : null, judge: judgeOf(r!, c, live) };
  });
}

/**
 * When the check builder added each of a golden's checks, as `added(golden, label)`: the time of the
 * newest `checks.changed` event for the golden whose `added` holds the label. Its events are read
 * once, for every golden, and only when a golden has a check added since its last result.
 */
export function addedTimes(store: StoreOf<'activity'>): (golden: string, label: string) => number | null {
  let byGolden: Map<string, Map<string, number>> | null = null;
  return (golden, label) => {
    if (!byGolden) {
      byGolden = new Map();
      // Newest first: the first event to add a label is when it was last added.
      for (const e of store.listEvents({ kinds: ['checks.changed'], limit: 500 })) {
        const added = (e.data as { added?: unknown } | null)?.added;
        if (!e.ref || !Array.isArray(added)) continue;
        const of = byGolden.get(e.ref) ?? new Map<string, number>();
        for (const l of added) if (typeof l === 'string' && !of.has(l)) of.set(l, e.at);
        byGolden.set(e.ref, of);
      }
    }
    return byGolden.get(golden)?.get(label) ?? null;
  };
}

/** A check a golden's last result failed or couldn't decide, which its checks no longer hold. */
export interface ChangedCheck {
  label: string;
  status: 'failed' | 'inconclusive';
}

/**
 * A golden's checks as the config holds them now, by their labels, or null where the config's tests
 * couldn't be read (`checksUnread`, a file mid-edit), when nothing can say they changed since.
 */
export const checksNow = (g: Pick<GoldenSource, 'checks' | 'checksUnread'> | undefined): readonly string[] | null => (!g || g.checksUnread ? null : g.checks);

/**
 * The checks changed since a golden's last test: those its last result failed or couldn't decide
 * that the golden's checks (`labels`, as the CLI labels them) no longer hold, removed or changed (a
 * changed check reads as another). Then that result stands on checks the config no longer has, and
 * only a test judges the checks as they are now. Null when none left, and for a result that passed,
 * or that failed or was undecided for a reason other than its checks (diverged, exit, no calls,
 * guard, injection, error), which keeps its own step: a check it passed changes nothing when it goes.
 * Null too where the golden's checks couldn't be read (`labels` null, `checksNow`), whose last result
 * keeps its own step: a config mid-edit says nothing of them.
 * The one rule for the row's line, the step on Tests, a run's page and Needs a look, and the report.
 */
export function checksChanged(r: Pick<TestResult, 'ok' | 'failure' | 'data'> | null, labels: readonly string[] | null): ChangedCheck[] | null {
  if (!labels || !r || r.ok || (r.failure !== 'check' && r.failure !== 'inconclusive')) return null;
  const now = new Set(labels);
  const out: ChangedCheck[] = [];
  for (const c of r.data?.checks ?? []) {
    const status = checkStatus(c);
    if ((status === 'failed' || status === 'inconclusive') && !now.has(c.label) && !out.some((x) => x.label === c.label)) out.push({ label: c.label, status });
  }
  return out.length ? out : null;
}

/**
 * The verdict's reason for a golden whose checks changed since (`checksChanged`): its base, then
 * `, its checks changed since`. The base is its gate's verdict where one decided it (`gated`), else
 * `inconclusive`, after how many attempts, or `failed its check`: what the check it failed or
 * couldn't decide found applies no longer.
 */
export function changedReason(r: Pick<TestResult, 'ok' | 'failure' | 'data'>, gated: string | null): string {
  const n = r.data?.attempts?.total ?? 1;
  const base = gated ?? (testResultVerdict(r) === 'inconclusive' ? `inconclusive${n > 1 ? ` after ${n} attempts` : ''}` : 'failed its check');
  return `${base}, its checks changed since`;
}

/** A golden's judge checks by label, with what each asks and its model, as the engine reads the entry's `expect`; none for an entry that can't be read. */
function judgeAsks(expect: unknown): Map<string, { question: string; model: string }> {
  if (expect === undefined) return new Map();
  try {
    return new Map((parseExpect(expect, 'expect').judge ?? []).map((j) => [judgeLabel(j), { question: j.question, model: j.model }]));
  } catch {
    // An entry that can't be read asks nothing here: the golden's checks say why.
    return new Map();
  }
}

/**
 * Tests' judge cards: each judge check's question and model as the golden's entry in the config holds
 * them now (`expectOf`, the entry's `expect`), on the rows of the view. A check not judged yet gets its
 * card here; a judged one keeps the model its result names, the one that answered.
 */
export function withJudgeAsks(view: TestsView, expectOf: (golden: string) => unknown): TestsView {
  const rows = view.rows.map((row) => {
    const asks = judgeAsks(expectOf(row.path));
    if (!asks.size) return row;
    const checkResults = row.checkResults.map((c): GoldenCheck => {
      const ask = asks.get(c.label);
      return ask ? { ...c, judge: { verdict: null, judged: null, held: null, ...c.judge, question: ask.question, model: c.judge?.model ?? ask.model } } : c;
    });
    return { ...row, checkResults };
  });
  return { ...view, rows };
}
