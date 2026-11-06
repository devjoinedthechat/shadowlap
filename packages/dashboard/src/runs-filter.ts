import type { RunRecord, Store, StoreOf, TestResult } from '@shadowlap/engine';
import { filterTerms, RECORDED_MIN_CHARS } from './links.js';
import type { IndexedRun, RunIndex } from './run-index.js';
import { judgedCanChange, verdictOf, type RunVerdict, type VerdictJudged } from './run-verdict.js';
import { recordedRuns, searchBehind } from './search-hits.js';

/**
 * What the run lists read besides the index's own fields. To say which runs failed: a test replay
 * whose golden passed when it ran again since is fixed by that run (`fixed by <run>`), and a capture
 * failed by the verdict its import kept. The Failed chip, `types=failed`, the days' failures and each
 * row's `failed` read the same set (`listFailed`), so the chip, the bars and Status agree. And what
 * the filter field's `status:`, `tool:` and words read (`termReads`), below.
 */

/**
 * The newest replay of a golden that passed since this run, made after it and still in the store;
 * null when none has. `results`: the golden's, newest first, where the caller has read them.
 */
export function passedSince(store: StoreOf<'recording' | 'tests'>, run: Pick<RunRecord, 'runId' | 'startedAt'>, golden: string, results: readonly TestResult[] = store.listTestResults({ golden, since: run.startedAt, limit: 50 })): string | null {
  for (const r of results) {
    if (r.at < run.startedAt) break;
    if (!r.ok || !r.runId || r.runId === run.runId) continue;
    const passed = store.getRun(r.runId);
    if (passed && passed.startedAt >= run.startedAt) return passed.runId;
  }
  return null;
}

/** A test replay of its own that failed: what a later passing replay of its golden fixes. */
const fixable = (r: IndexedRun): r is IndexedRun & { meta: { test: { golden: string } } } => r.kind === 'test' && !r.attemptKind && r.failed && !!r.meta.test?.golden;

/** The most of a golden's results read back to its oldest failed replay: a passing replay is among the newest. */
const RESULTS_READ = 1000;

const fixedKept = new WeakMap<object, { key: string; fixed: ReadonlyMap<string, string> }>();

/**
 * Each failed test replay whose golden passed when it ran again since, with the run that passed: its
 * golden's results read once for all its failed replays, kept until runs or the tests' results move.
 */
export function fixedByOf(store: StoreOf<'recording' | 'tests' | 'activity'>, index: RunIndex): ReadonlyMap<string, string> {
  const key = `${index.revision}|${index.runs.length}|${store.changeCounts().tests ?? 0}`;
  const kept = fixedKept.get(index);
  if (kept?.key === key) return kept.fixed;
  const byGolden = new Map<string, Array<IndexedRun & { meta: { test: { golden: string } } }>>();
  for (const r of index.runs) {
    if (!fixable(r)) continue;
    const list = byGolden.get(r.meta.test.golden);
    if (list) list.push(r);
    else byGolden.set(r.meta.test.golden, [r]);
  }
  const fixed = new Map<string, string>();
  for (const [golden, failed] of byGolden) {
    const since = Math.min(...failed.map((r) => r.startedAt));
    const results = store.listTestResults({ golden, since, limit: RESULTS_READ });
    for (const r of failed) {
      const by = passedSince(store, r, golden, results);
      if (by) fixed.set(r.runId, by);
    }
  }
  fixedKept.set(index, { key, fixed });
  return fixed;
}

/**
 * Whether a run counts as failed in the lists: it failed and no later replay of its golden fixed it,
 * or it is a capture whose import judged it failed. A capture judged again since the rules changed
 * reads the verdict it kept until its row is judged.
 */
export const listFailed = (r: IndexedRun, fixed: ReadonlyMap<string, string>): boolean => (r.failed || r.meta.judged === 'failed') && !fixed.has(r.runId);

// ---- what the filter field's terms read ----

/**
 * A run's outcome by checks, for `status:` (run-outcome.ts `judgeFor`): `quick` reads no call, and is
 * undefined where judging the run would.
 */
export type JudgeRun = (runId: string, quick: boolean) => VerdictJudged | null | undefined;

/** What the filter waits for besides the about lines (`RunsPage.warming`): `what` names it, for the words the page says. */
export interface TermsWarming {
  done: number;
  total: number;
  what: 'verdicts';
}

/** What the filter's terms read besides the index, for one read of the runs: each only when a term asks for it. */
export interface TermReads {
  /** A run's verdict as its Status says it (run-verdict.ts); undefined while it isn't worked out. */
  verdict?: (r: IndexedRun) => RunVerdict | null | undefined;
  /** The tools a run called, lowercased (`toolsCalled`). */
  tools?: (r: IndexedRun) => readonly string[];
  /** Whether what a run recorded holds the word (search-hits.ts `recordedRuns`). */
  recorded?: (word: string, r: IndexedRun) => boolean;
  /** Once the filter has gone over the runs: how many of the verdicts `status:` asked for are known, while some aren't. */
  warming: () => TermsWarming | null;
  /** Once the filter has gone over the runs: the newest whose verdict `status:` waits for and whose calls are more than a read judges, to judge beside the server (read-jobs.ts). */
  judgeAfter: () => string | null;
  /** While the search index is behind on some runs, for words it is asked: how many, of how many. */
  indexing: { runs: number; of: number } | null;
}

/**
 * The most runs one read of `status:` judges by their checks, newest first, those it judged before
 * among them: well within what a thread keeps judged (run-outcome.ts `JUDGED_KEPT`) beside the rows
 * and the runs' pages, so what a walk over the runs judged is still kept when the page asks again.
 * An older run goes by its own outcome, as Status shows a row nothing judged, and isn't waited for.
 */
export const STATUS_JUDGED_RUNS = 2_000;

/**
 * Each run's verdict, worked out as the filter reaches it, so newest first. A run whose outcome
 * decides it needs nothing judged (`judgedCanChange`); then what needs no call read, then a run whose
 * calls fit what is left of `budget`, as the rows are judged (run-outcome.ts `judgedRows`). A run past
 * it is undefined, so it matches no `status:` yet: `warming` counts it, the page says so and asks
 * again, and each read judges more of them, kept on its thread. One with more calls than `budget` is
 * judged beside the server once the read is answered (`judgeAfter`), the newest first.
 */
function verdictsAsked(fixed: ReadonlyMap<string, string>, judge: JudgeRun | null, budget: number): Pick<TermReads, 'verdict' | 'warming' | 'judgeAfter'> {
  const known = new Map<string, RunVerdict | null | undefined>();
  const capped = Number.isFinite(budget);
  let left = budget;
  let pending = 0;
  let reached = 0;
  let after: string | null = null;
  const judgedOf = (r: IndexedRun): VerdictJudged | null | undefined => {
    let judged = judge!(r.runId, true);
    if (judged === undefined && r.calls <= left) {
      left -= r.calls;
      judged = judge!(r.runId, false);
    }
    if (judged === undefined && r.calls > budget) after ??= r.runId;
    return judged;
  };
  const verdict = (r: IndexedRun): RunVerdict | null | undefined => {
    if (known.has(r.runId)) return known.get(r.runId);
    const run = { status: r.status, outcome: r.outcome, fixedBy: fixed.get(r.runId) ?? null };
    const judged = judge && judgedCanChange(run) && (!capped || ++reached <= STATUS_JUDGED_RUNS) ? judgedOf(r) : null;
    const v = judged === undefined ? undefined : verdictOf({ ...run, judged });
    if (v === undefined) pending++;
    known.set(r.runId, v);
    return v;
  };
  return { verdict, warming: () => (pending ? { done: known.size - pending, total: known.size, what: 'verdicts' } : null), judgeAfter: () => after };
}

const toolsKept = new WeakMap<object, { key: string; tools: ReadonlyMap<string, readonly string[]> }>();

/**
 * The tools each run called, lowercased, as its recorded tool calls name them, for `tool:`: one pass
 * over the calls' starts, kept on this thread until runs or calls change, as Settings → Tools' reads
 * are (tool-reads.ts). A tool a model only asked for, or one its agent called unwrapped, isn't one.
 */
export function toolsCalled(store: StoreOf<'readModels' | 'activity'>): ReadonlyMap<string, readonly string[]> {
  const c = store.changeCounts();
  const key = `${c.runs ?? 0}:${c.calls ?? 0}`;
  const kept = toolsKept.get(store);
  if (kept?.key === key) return kept.tools;
  const tools = new Map<string, string[]>();
  for (const row of store.query(`SELECT DISTINCT name, run_id FROM call_events WHERE phase = 'start' AND kind = 'tool'`)) {
    const name = String(row.name).toLowerCase();
    const list = tools.get(String(row.run_id));
    if (!list) tools.set(String(row.run_id), [name]);
    else if (!list.includes(name)) list.push(name);
  }
  toolsKept.set(store, { key, tools });
  return tools;
}

/**
 * What the filter field's terms read for one read of the runs: `status:` each run's verdict, within
 * `budget` calls (`verdictsAsked`), `tool:` the tools runs called, and a word from RECORDED_MIN_CHARS
 * characters what runs recorded, through the search index, which answers from what it holds.
 */
export function termReads(store: Store, index: RunIndex, filter: { q?: string; judge?: JudgeRun | null }, budget: number): TermReads {
  const terms = filterTerms(filter.q);
  const asked = terms.statuses.length ? verdictsAsked(fixedByOf(store, index), filter.judge ?? null, budget) : null;
  const tools = terms.tools.length ? toolsCalled(store) : null;
  const behind = terms.words.some((w) => w.length >= RECORDED_MIN_CHARS) ? searchBehind(store, index) : null;
  return {
    ...asked,
    ...(tools ? { tools: (r: IndexedRun) => tools.get(r.runId) ?? [] } : {}),
    ...(behind === null ? {} : { recorded: (w: string, r: IndexedRun) => recordedRuns(store, w, index, String(behind)).has(r.runId) }),
    warming: asked?.warming ?? (() => null),
    judgeAfter: asked?.judgeAfter ?? (() => null),
    indexing: behind ? { runs: behind, of: index.runs.length } : null,
  };
}
