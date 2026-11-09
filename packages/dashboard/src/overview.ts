import { emptyOriginCounts, importedRecording, sumCacheUse, type OriginCounts, type RunAbout, type RunKind, type Store } from '@shadowlap/engine';
import { fixesSummary, type PatchCheck, type RewriteCheck } from './fixes.js';
import { lookWork, type NeedsLook, needsLook } from './needs-look/index.js';
import type { NextStepWork } from './next-step.js';
import { aboutsUpTo } from './run-about.js';
import { addDays, daysFrom, dayIndex, isTimeZone, localDay, type LocalDay } from './local-days.js';
import { addSpendNoRunHolds } from './overview-spend.js';
import { loadRunIndex, type IndexedRun, type RunIndex } from './run-index.js';
import { cacheTotalsOf, cacheUseOf, callTotals, callTotalsWithin, priced, totalsKnown, type RunStats, type StatsOptions } from './run-stats.js';
import { overviewTests, type GoldenList } from './tests.js';

/**
 * The Overview, worked out on the server: this week against last week, the last seven days, the
 * outcomes its header states, what today served from recordings and what is recording now, and what
 * needs a look. A week is the last seven of the viewer's days, today included; last week is the
 * seven before.
 *
 * Runs and calls are counted without attempts (`--repeat`, blame probes, verify), which are bundled
 * under the run they came from: the week's calls, Calls by origin and what today served count runs.
 * The week's money and time are not: what an attempt spent live was spent, and what it replayed
 * was not re-spent. Spent live also holds what no run holds (overview-spend.ts): a preview's and a
 * migration's asking and judging, and a repairer's own answer.
 *
 * The numbers other screens own come from their read models: Fixes (`fixesSummary`) and Tests
 * (`overviewTests`, over the goldens on disk); Needs a look from its registry of sources
 * (needs-look/index.ts). The
 * prompt cache is the engine's `cacheUse`: each run's part (`runCacheUse`, the run page's Context
 * view's rule) kept with the run's other totals, and the week's summed by `sumCacheUse`.
 */

export interface TimeWindow {
  from: number;
  to: number;
}

export interface WeekSums {
  /** Runs that started in the window, attempts left out. */
  runs: number;
  /** Their calls, and those calls by origin (r replayed, l live, o overridden, i injected, f failed, b blocked, s stubbed). */
  calls: number;
  origins: OriginCounts;
  /**
   * Approximate USD spent on live model calls, attempts included, and on calls that are no run, on
   * the day each was made: a preview's or a migration's asks and judge calls, and a repairer's own
   * answer (overview-spend.ts). Their replays are runs, counted once with the rest.
   */
  spent: number;
  /** What replaying did not spend again: the recorded cost of every replayed model call, attempts included. */
  notRespent: number;
  /** The recorded duration of every replayed call, attempts included: time not waited. */
  notWaitedMs: number;
  /** Attempts that started in the window, and what they spent live. */
  attempts: number;
  attemptsSpent: number;
}

export interface DaySums {
  /** `YYYY-MM-DD` in the viewer's zone. */
  day: string;
  start: number;
  /** Spent live and not re-spent that day, attempts included, as the week's sums. */
  spent: number;
  notRespent: number;
}

/** What today served from recordings, for Usage's receipt, and the recordings in progress, for Watch live. */
export interface TodayPanel {
  day: string;
  /** Calls today's runs were served from recordings: attempts are left out, as in every count of calls. */
  served: number;
  /** What replaying did not spend again today: attempts included, as the day's bar in the chart and the week's sums count money. */
  notRespent: number;
  /** Recordings in progress, with their calls so far and what each is about (its first user message, once it sent one). */
  recording: Array<{ runId: string; command: string; calls: number; startedAt: number; about: RunAbout | null }>;
}

/**
 * Tests passing: the goldens on disk, each by its newest result as Tests shows it, those passing now
 * and when this week started, those that failed (`regressions`), and the last run.
 */
export interface TestsTile {
  goldens: number;
  passing: number;
  /** Goldens whose last result is inconclusive, counted apart from passing and the regressions. */
  inconclusive: number;
  /** Goldens with no result yet: what the passing ones and the rest are counted out of, said. */
  untested: number;
  /** Passing as the tests stood when this week started; null without results that old. */
  lastWeek: number | null;
  regressions: number;
  lastRunAt: number | null;
}

export interface OutcomeStrip {
  /**
   * Failures blame replayed exactly before probing, by each fix's first blame (a failure is a fix,
   * as the fixes funnel counts it), this week and last, and the fixes still open.
   */
  reproduced: { value: number; lastWeek: number; open: number };
  /** Accepted verify verdicts that count for a fix, this week and last, and those rejected this week before they shipped. */
  fixesVerified: { value: number; lastWeek: number; rejected: number };
  /** Null with no goldens on disk: "—, no goldens yet". */
  testsPassing: TestsTile | null;
  /** Spent live this week and last, with what replaying saved this week. */
  spent: { value: number; lastWeek: number; notRespent: number; notWaitedMs: number };
}

/** A live model call where the prompt cache stopped hitting, as the Overview lists it. */
export interface CacheMissRow {
  runId: string;
  /** The run's kind, for the icon beside it. */
  kind: RunKind;
  callNo: number;
  scope: string | null;
  /** The model that answered it, shortened ("sonnet-5"); null when not known. */
  model: string | null;
  /** Input tokens sent again: the previous call's whole input, less what this call read from the cache. */
  tokens: number;
}

export interface CacheUse {
  /** Live model calls of runs started this week: their whole input, the part read from the cache, and that share (null without any). */
  input: number;
  cacheRead: number;
  readShare: number | null;
  /** The four largest misses, the tokens all misses sent again, and how many there were. */
  misses: CacheMissRow[];
  sentAgain: number;
  missCount: number;
}

/** How far each failure got towards a fix, as the fixes read model counts them. */
export interface FixesFunnel {
  /** Every failure (fixes, and failed recordings never blamed), those blamed, those with a verified fix, those applied. */
  failures: number;
  blamed: number;
  verified: number;
  applied: number;
  /** Fixes still open, verified fixes not applied yet, and applied fixes that don't hold. */
  open: number;
  readyToApply: number;
  broken: number;
  /** The attempts behind every fix, and what they and the repairers spent live. */
  attempts: number;
  spent: number;
}

export type { LookStep, NeedsLook, NeedsLookRow } from './needs-look/index.js';

/**
 * The team store as Needs a look reads it: how many runs are only on this machine, as the store's
 * status counts them for Settings → Store and the CLI (`onlyLocal`): by run, a run counted once
 * when it or the attempts filed under it aren't in the store's index yet, as the Runs page tags it.
 * `setup`: the next step of a setup started on the setup page and not finished.
 */
export interface StoreNote {
  name: string;
  onlyLocal: number;
  setup?: { step: number; title: string } | null;
}

export interface OverviewOptions extends StatsOptions {
  /** The viewer's time zone (IANA). */
  tz?: string;
  now?: number;
  /** The goldens on disk (the CLI's `projectGoldens`): Tests passing and failing tests. Without any, there are no goldens yet. */
  goldens?: GoldenList;
  /** The team store, when the config names one: its runs only on this machine join Needs a look. */
  teamStore?: StoreNote | null;
  /** Whether a verified fix's patch is in the working tree already (merged, or applied by hand): such a fix is no more ready to apply. */
  patchInTree?: PatchCheck;
  /** Why `fix apply` refuses a pulled patch in the working tree: such a fix has no step on Needs a look, as its page applies none. */
  rewriteHere?: RewriteCheck;
  /**
   * Answering a request beside the server (read-jobs.ts), after `overviewKnown` found the finished
   * runs' totals known: what isn't known yet is worked out only while the calls read for it stay
   * within this many (a run older than the two weeks under a run of the week, a recording in
   * progress's prompt cache, what a long recording's user asked), the rest left to the warm-up.
   */
  budget?: number;
  /** What a run's next step reads of the project: a line about a run says what its page leads with. */
  next?: NextStepWork | null;
  /** The configured repairer, which Run repair's card on Needs a look names. */
  repairer?: string | null;
}

export interface OverviewSummary {
  tz: string;
  now: number;
  windows: { week: TimeWindow; lastWeek: TimeWindow };
  sums: { week: WeekSums; lastWeek: WeekSums };
  /** The last seven days, oldest first. */
  daily: DaySums[];
  /** In the whole store: runs and the attempts bundled under them, as the status bar counts them. */
  counts: { runs: number; attempts: number };
  today: TodayPanel;
  outcomes: OutcomeStrip;
  cache: CacheUse;
  fixes: FixesFunnel;
  needsLook: NeedsLook;
}

function emptyWeek(): WeekSums {
  return { runs: 0, calls: 0, origins: emptyOriginCounts(), spent: 0, notRespent: 0, notWaitedMs: 0, attempts: 0, attemptsSpent: 0 };
}

function addTo(w: WeekSums, r: IndexedRun, s: RunStats | undefined): void {
  if (!s) return;
  w.spent += s.spent;
  w.notRespent += s.saved;
  w.notWaitedMs += s.notWaitedMs;
  if (r.bundled) {
    w.attempts++;
    w.attemptsSpent += s.spent;
    return;
  }
  w.runs++;
  w.calls += s.calls;
  for (const k of Object.keys(w.origins) as Array<keyof OriginCounts>) w.origins[k] += s.origins[k];
}

/** This week and last in the viewer's days, today included. Throws a RangeError for an unknown time zone. */
function windowsOf(tz: string, now: number): { today: LocalDay; weekDays: LocalDay[]; week: TimeWindow; lastWeek: TimeWindow } {
  if (!isTimeZone(tz)) throw new RangeError(`unknown time zone: ${String(tz)}`);
  const today = localDay(now, tz);
  const weekDays = daysFrom(addDays(today, -6, tz), today, tz);
  const week: TimeWindow = { from: weekDays[0]!.start, to: today.end };
  return { today, weekDays, week, lastWeek: { from: addDays(today, -13, tz).start, to: week.from } };
}

/**
 * How far what the Overview adds up is known (run-stats.ts `totalsKnown`): the totals of every
 * finished run of these two weeks, and this week's prompt cache. A store no dashboard has opened has
 * none of it kept: its first look answers with this while the warm-up works out the rest beside the
 * server, rather than read every call of every run while the browser waits. With `budget`, what fits
 * it is worked out first, newest first: a short run that just ended doesn't send the Overview back to
 * warming, a long one waits for the warm-up.
 */
export function overviewKnown(store: Store, options: Pick<OverviewOptions, 'tz' | 'now' | 'budget'> = {}): { done: number; total: number } {
  const { week, lastWeek } = windowsOf(options.tz ?? 'UTC', options.now ?? Date.now());
  const index = loadRunIndex(store);
  const inWindow = index.runs.filter((r) => r.startedAt >= lastWeek.from && r.startedAt < week.to);
  const cache = (r: IndexedRun) => r.startedAt >= week.from && !importedRecording(r);
  if (options.budget === undefined) return totalsKnown(store, index, inWindow, { cache });
  const finished = inWindow.filter((r) => r.status !== 'running' && r.calls > 0);
  const { totals } = callTotalsWithin(store, index, finished, { budget: options.budget });
  // Kept caches another thread worked out are read here once, with those that fit worked out.
  const caches = cacheTotalsOf(store, index, finished.filter(cache), { budget: options.budget });
  // A cache known comes with its run's totals.
  const done = finished.filter((r) => (cache(r) ? caches.has(r.runId) : totals.has(r.runId))).length;
  return { done, total: finished.length };
}

/** The Overview's numbers. Throws a RangeError for an unknown time zone. */
export function overviewSummary(store: Store, options: OverviewOptions = {}): OverviewSummary {
  const tz = options.tz ?? 'UTC';
  const now = options.now ?? Date.now();
  const { today, weekDays, week, lastWeek } = windowsOf(tz, now);
  const index = loadRunIndex(store);
  const inWindow = index.runs.filter((r) => r.startedAt >= lastWeek.from && r.startedAt < week.to);
  // A recording in progress is added up anew whenever it has made calls.
  const totals = callTotals(store, index, inWindow);
  const stats = new Map([...totals].map(([runId, t]) => [runId, priced(t, options.prices)] as const));

  const sums = { week: emptyWeek(), lastWeek: emptyWeek() };
  const daily: DaySums[] = weekDays.map((d) => ({ day: d.key, start: d.start, spent: 0, notRespent: 0 }));
  for (const r of inWindow) {
    const s = stats.get(r.runId);
    addTo(r.startedAt >= week.from ? sums.week : sums.lastWeek, r, s);
    const i = dayIndex(weekDays, r.startedAt);
    if (i >= 0 && s) {
      daily[i]!.spent += s.spent;
      daily[i]!.notRespent += s.saved;
    }
  }
  addSpendNoRunHolds(store, { week, lastWeek }, weekDays, sums, daily);

  // Recordings in progress, as the top bar's chip counts them: a run whose recorder stopped without
  // ending it (killed, out of memory) is still marked running, but nothing is recording it.
  const recording = new Set(store.recordingRuns(now).live.map((x) => x.run.runId));
  // Blames and verdicts in the same weeks as the runs: the viewer's days, not 7 × 24 hours up to now.
  const fixes = fixesSummary(store, now, { week, lastWeek }, { ...(options.patchInTree ? { patchInTree: options.patchInTree } : {}) });
  const goldens = options.goldens ?? [];
  const tests = goldens.length ? overviewTests(store, { now, weekStart: week.from }, { goldens }) : null;

  return {
    tz,
    now,
    windows: { week, lastWeek },
    sums,
    daily,
    counts: index.counts,
    today: todayPanel(store, index, inWindow, stats, today, recording, options.budget),
    outcomes: {
      reproduced: { value: fixes.reproduced.thisWeek, lastWeek: fixes.reproduced.lastWeek, open: fixes.open },
      fixesVerified: { value: fixes.verified.thisWeek, lastWeek: fixes.verified.lastWeek, rejected: fixes.rejected.thisWeek },
      testsPassing: tests,
      spent: { value: sums.week.spent, lastWeek: sums.lastWeek.spent, notRespent: sums.week.notRespent, notWaitedMs: sums.week.notWaitedMs },
    },
    cache: weekCache(store, index, week.from, options.budget),
    fixes: { ...fixes.funnel, open: fixes.open, readyToApply: fixes.readyToApply, broken: fixes.broken, attempts: fixes.attempts, spent: fixes.spent },
    needsLook: needsLook(lookWork(store, { goldens, teamStore: options.teamStore ?? null, patchInTree: options.patchInTree, rewriteHere: options.rewriteHere, repairer: options.repairer ?? null, budget: options.budget, next: options.next ?? null, now, week: { ...week, first: weekDays[0]!.key, last: today.key }, index })),
  };
}

function todayPanel(store: Store, index: RunIndex, inWindow: IndexedRun[], stats: Map<string, RunStats>, today: LocalDay, recordingNow: ReadonlySet<string>, budget?: number): TodayPanel {
  const runs = inWindow.filter((r) => r.startedAt >= today.start && r.startedAt < today.end);
  const sum = (list: IndexedRun[], f: (s: RunStats) => number) => list.reduce((t, r) => t + (stats.has(r.runId) ? f(stats.get(r.runId)!) : 0), 0);
  return {
    day: today.key,
    served: sum(runs.filter((r) => !r.bundled), (s) => s.origins.r),
    notRespent: sum(runs, (s) => s.saved),
    recording: recordingRows(store, index, recordingNow, budget),
  };
}

/** Recordings in progress, each with what it is about: a recording's first user message, read once it was sent. */
function recordingRows(store: Store, index: RunIndex, recordingNow: ReadonlySet<string>, budget?: number): TodayPanel['recording'] {
  const runs = index.runs.filter((r) => recordingNow.has(r.runId) && r.mode === 'record' && !r.bundled);
  const abouts = runs.length ? aboutsUpTo(store, index, runs, budget) : new Map<string, RunAbout>();
  return runs.map((r) => ({ runId: r.runId, command: r.argv.join(' '), calls: r.calls, startedAt: r.startedAt, about: abouts.get(r.runId) ?? null }));
}

/**
 * Live model calls' cache use in runs started since the week started: the engine's `cacheUse`
 * (attempts included, imported recordings left out: they were live somewhere else), summed by its
 * `sumCacheUse` from each run's part as `run_stats` keeps it (worked out once per run, the first
 * time a week asks), with each miss's run kind for its icon. Largest misses first.
 */
function weekCache(store: Store, index: RunIndex, since: number, budget?: number): CacheUse {
  const runs = index.runs.filter((r) => r.startedAt >= since && !importedRecording(r));
  const caches = cacheTotalsOf(store, index, runs, budget === undefined ? {} : { budget });
  const use = sumCacheUse(
    runs.map((r) => ({ runId: r.runId, startedAt: r.startedAt, use: cacheUseOf(caches.get(r.runId) ?? null) })),
    4,
  );
  return {
    input: use.liveInput,
    cacheRead: use.liveRead,
    readShare: use.readShare,
    misses: use.largest.map((m) => ({ runId: m.runId, kind: index.byId.get(m.runId)?.kind ?? 'recording', callNo: m.callNo, scope: m.scope, model: m.model, tokens: m.sentAgain })),
    sentAgain: use.sentAgain,
    missCount: use.misses,
  };
}


/** Options for `overviewSummary` from a request's query string: tz. */
export function overviewOptions(params: URLSearchParams): Pick<OverviewOptions, 'tz'> | { error: string } {
  const tz = params.get('tz');
  if (!tz) return {};
  if (!isTimeZone(tz)) return { error: `tz: unknown time zone "${tz.slice(0, 64)}"` };
  return { tz };
}
