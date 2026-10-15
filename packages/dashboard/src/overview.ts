import { countOrigins, emptyOriginCounts, lostAt, originCells, type OriginCounts, type RunKind, type RunOutcome, type RunStatus, type Store } from '@shadowlap/engine';
import { addDays, daysFrom, dayIndex, isTimeZone, localDay, type LocalDay } from './local-days.js';
import { classifiable, loadRunIndex, type IndexedRun, type RunIndex } from './run-index.js';
import { cacheMisses, callTotals, runStats, sumStats, type CacheMiss, type RunStats, type StatsOptions } from './run-stats.js';

/**
 * The Overview, worked out on the server: this week against last week, the last seven days, what
 * ran today, every run of the week as a row of calls, and the outcomes that lead the page. A week
 * is the last seven of the viewer's days, today included; last week is the seven before.
 *
 * Runs and calls are counted without attempts (`--repeat`, blame probes, verify), which are bundled
 * under the run they came from: the grid, the week's calls, Calls by origin and Today count runs.
 * The week's money and time are not: what an attempt spent live was spent, and what it replayed
 * was not re-spent.
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
  /** Approximate USD spent on live model calls, attempts included. */
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

export interface TodayPanel {
  day: string;
  /** Calls today's runs were served from recordings, and what those calls did not re-spend. Attempts are left out, as in every count of calls. */
  served: number;
  notRespent: number;
  /** Recordings in progress, with their calls so far. */
  recording: Array<{ runId: string; command: string; calls: number; startedAt: number }>;
  /** Clean replays today. */
  replays: number;
  /** Forks today (the one blame rescued a run with among them), the calls that went live in them, and the writes they blocked. */
  forks: { count: number; live: number; blocked: number };
  /** Test runs today, the failures among them, and the newest failure. */
  tests: { count: number; failed: number; latestFailure: { runId: string; outcome: RunOutcome } | null };
  /** Blame today: the model calls it probed, its attempts (bundled under the run they probed), and the runs it probed with where each was lost. */
  blame: { probes: number; attempts: number; runs: Array<{ runId: string; lostAt: number | null }> };
}

export interface GridRow {
  runId: string;
  parentRunId: string | null;
  /** Indent under the family's first run. */
  depth: number;
  /**
   * A run from before this week, shown so the week's runs hang under the recording they came from
   * and their replayed prefixes line up under it. It is not one of the week's runs.
   */
  context: boolean;
  kind: RunKind;
  status: RunStatus;
  outcome: RunOutcome;
  failed: boolean;
  label: string;
  rescues: string | null;
  startedAt: number;
  calls: number;
  /** One character per cell; a run shorter than the family's scale has fewer cells than `cols`. */
  cells: string;
  /** The cell holding the call a fork left its parent at. */
  forkCell: number | null;
  origins: OriginCounts;
}

export interface GridFamily {
  /** Calls per cell: 1 up to 60 calls, then a cell stands for a range and shows its most notable origin. */
  size: number;
  /** Cells the family's scale spans: its longest run, at least 30 calls, so a fork's replayed prefix lines up under its parent. */
  cols: number;
  rows: GridRow[];
}

export interface RunGrid {
  /** Every run of the week, attempts left out, and their calls by origin. */
  runs: number;
  calls: number;
  origins: OriginCounts;
  /** Newest family first: the recording the runs came from (a context row when it is older), with the week's runs made from it under it. */
  families: GridFamily[];
  /** The week's runs shown (context rows aside), and those left for All runs. */
  shown: number;
  more: number;
}

export interface OutcomeStrip {
  /** Failures blame replayed exactly before probing, this week and last, and the failures still open. */
  reproduced: { value: number; lastWeek: number; open: number };
  /** Accepted verify verdicts this week and last, and those rejected before they shipped. Null until fixes report them. */
  fixesVerified: { value: number; lastWeek: number; rejected: number } | null;
  /** Goldens passing now and a week ago, the failures caught and the last test run. Null with no goldens. */
  testsPassing: TestsSummary | null;
  /** Spent live this week and last, with what replaying saved this week. */
  spent: { value: number; lastWeek: number; notRespent: number; notWaitedMs: number };
}

export interface TestsSummary {
  goldens: number;
  passing: number;
  /** Passing as the tests stood when this week started; null when there were none yet. */
  lastWeek: number | null;
  /** Goldens failing now: the regressions the tests caught. */
  regressions: number;
  lastRunAt: number | null;
  /** The goldens failing now, newest first, each with the run that failed: what Needs a look lists. */
  failing: Array<{ golden: string; runId: string; outcome: RunOutcome; at: number }>;
}

export interface CacheUse {
  /** Live model calls this week (attempts left out): their whole input, and the part read from the cache. */
  input: number;
  cacheRead: number;
  /** The four largest misses, the tokens all misses sent again, and how many there were. */
  misses: CacheMiss[];
  sentAgain: number;
  missCount: number;
}

/** How far each failure got towards a fix. Every step counts failures, the unit fixes are made of. */
export interface FixesFunnel {
  /**
   * Failures on their way to a fix, and those blame has reproduced. A fix starts from a blame, so
   * until the fixes slice groups runs into failures each blamed run is one failure.
   */
  failures: number;
  blamed: number;
  /** Failures with a verified fix, and those applied. Null until fixes report them. */
  verified: number | null;
  applied: number | null;
  open: number;
  /** Failed runs no blame has looked at yet (`needsLook.notBlamed`): not fixes yet. */
  notBlamed: number;
  /** The blame probes and verify attempts behind them, and what they spent live. */
  attempts: number;
  spent: number;
}

/** What the fixes slice knows: each count in failures (fixes), plus verify verdicts for the strip. */
export interface FixesHookResult {
  failures: number;
  blamed: number;
  verified: number;
  applied: number;
  open: number;
  /** Verify verdicts accepted this week and last, and rejected. */
  accepted: number;
  acceptedLastWeek: number;
  rejected: number;
}

/** What other slices know better. Until they hook in, the narrow local versions here stand in. */
export interface OverviewHooks {
  /** Fixes (stored verdicts, runs grouped into failures): replaces the funnel, the open count and Fixes verified. */
  fixes?: (windows: { week: TimeWindow; lastWeek: TimeWindow }) => FixesHookResult | null;
  /** Tests (sessions and golden results): replaces the summary read from test runs' metadata. */
  tests?: (asOf: { now: number; weekStart: number }) => TestsSummary | null;
  /** The run page's cache rule, once conversations are marked per call: replaces the local miss search. */
  cache?: (runIds: string[]) => CacheUse | null;
}

export interface OverviewOptions extends StatsOptions {
  /** The viewer's time zone (IANA). */
  tz?: string;
  now?: number;
  /** Rows of the run grid: families are added whole, newest first, while they fit (40 unless asked). */
  gridRows?: number;
  hooks?: OverviewHooks;
}

/**
 * What Needs a look can say from runs alone. Failing tests are in `outcomes.testsPassing.failing`;
 * open fixes and verified fixes waiting to be applied come from the fixes slice.
 */
export interface NeedsLook {
  /**
   * Failed runs no blame has looked at, newest first (at most 20): not fixes yet, each offers Run
   * blame. Tests are left out (a divergence is not blamed), as is a replay that reproduced its
   * recording's failure (the recording is the run to blame).
   */
  notBlamed: Array<{ runId: string; kind: RunKind; label: string; command: string; source: string | null; outcome: RunOutcome; startedAt: number }>;
  /** Such runs past the 20 listed. */
  more: number;
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
  grid: RunGrid;
  outcomes: OutcomeStrip;
  cache: CacheUse;
  fixes: FixesFunnel;
  needsLook: NeedsLook;
}

const GRID_CELLS = 60;
const GRID_MIN_CALLS = 30;
const NEEDS_LOOK_LISTED = 20;

/** A failure no blame has looked at: a run that failed, not a test and not a reproduction of its recording's failure. */
const needsBlame = (r: IndexedRun) => r.failed && !r.bundled && r.kind !== 'test' && r.kind !== 'clean' && !r.meta.blame;

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

/** The Overview's numbers. Throws a RangeError for an unknown time zone. */
export function overviewSummary(store: Store, options: OverviewOptions = {}): OverviewSummary {
  const tz = options.tz ?? 'UTC';
  if (!isTimeZone(tz)) throw new RangeError(`unknown time zone: ${String(tz)}`);
  const now = options.now ?? Date.now();
  const today = localDay(now, tz);
  const weekDays = daysFrom(addDays(today, -6, tz), today, tz);
  const week: TimeWindow = { from: weekDays[0]!.start, to: today.end };
  const lastWeek: TimeWindow = { from: addDays(today, -13, tz).start, to: week.from };
  const index = loadRunIndex(store);
  const inWindow = index.runs.filter((r) => r.startedAt >= lastWeek.from && r.startedAt < week.to);
  const stats = runStats(store, index, inWindow, options);

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

  const thisWeek = inWindow.filter((r) => r.startedAt >= week.from && !r.bundled);
  const hooks = options.hooks ?? {};
  const fixHook = hooks.fixes?.({ week, lastWeek }) ?? null;
  const blamed = index.runs.filter((r) => r.meta.blame && !r.bundled);
  const open = fixHook?.open ?? blamed.length;
  const blamedIn = (w: TimeWindow) => blamed.filter((r) => r.meta.blame!.at >= w.from && r.meta.blame!.at < w.to).length;
  // Newest first, as the index lists runs.
  const notBlamed = index.runs.filter(needsBlame);

  return {
    tz,
    now,
    windows: { week, lastWeek },
    sums,
    daily,
    counts: index.counts,
    today: todayPanel(index, inWindow, stats, today),
    grid: runGrid(store, index, thisWeek, stats, Math.max(1, Math.min(500, Math.floor(options.gridRows ?? 40) || 40))),
    outcomes: {
      reproduced: { value: blamedIn(week), lastWeek: blamedIn(lastWeek), open },
      fixesVerified: fixHook ? { value: fixHook.accepted, lastWeek: fixHook.acceptedLastWeek, rejected: fixHook.rejected } : null,
      testsPassing: hooks.tests ? hooks.tests({ now, weekStart: week.from }) : testsSummary(index, now, week.from),
      spent: { value: sums.week.spent, lastWeek: sums.lastWeek.spent, notRespent: sums.week.notRespent, notWaitedMs: sums.week.notWaitedMs },
    },
    cache: hooks.cache?.(thisWeek.map((r) => r.runId)) ?? cacheUse(store, index, thisWeek, stats),
    fixes: fixesFunnel(store, index, options, blamed.length, notBlamed.length, fixHook),
    needsLook: {
      notBlamed: notBlamed.slice(0, NEEDS_LOOK_LISTED).map((r) => ({ runId: r.runId, kind: r.kind, label: r.label, command: r.argv.join(' '), source: r.source, outcome: r.outcome, startedAt: r.startedAt })),
      more: Math.max(0, notBlamed.length - NEEDS_LOOK_LISTED),
    },
  };
}

function todayPanel(index: RunIndex, inWindow: IndexedRun[], stats: Map<string, RunStats>, today: LocalDay): TodayPanel {
  const runs = inWindow.filter((r) => r.startedAt >= today.start && r.startedAt < today.end);
  const shown = runs.filter((r) => !r.bundled);
  const of = (kind: RunKind) => shown.filter((r) => r.kind === kind);
  const sum = (list: IndexedRun[], f: (s: RunStats) => number) => list.reduce((t, r) => t + (stats.has(r.runId) ? f(stats.get(r.runId)!) : 0), 0);
  const forks = of('fork');
  const tests = of('test');
  const failedTests = tests.filter((r) => r.failed);
  // Blame's runs today: the attempts bundled under the run they probed, and the fork it rescued a run with.
  const probes = runs.filter((r) => r.meta.probe && ((r.bundled && r.attemptKind === 'probe') || r.rescues));
  const probedRun = (r: IndexedRun) => r.rescues ?? r.attemptOf!;
  return {
    day: today.key,
    served: sum(shown, (s) => s.origins.r),
    notRespent: sum(shown, (s) => s.saved),
    recording: index.runs.filter((r) => r.status === 'running' && r.mode === 'record' && !r.bundled).map((r) => ({ runId: r.runId, command: r.argv.join(' '), calls: r.calls, startedAt: r.startedAt })),
    replays: of('clean').length,
    forks: { count: forks.length, live: sum(forks, (s) => s.origins.l), blocked: sum(forks, (s) => s.origins.b) },
    tests: { count: tests.length, failed: failedTests.length, latestFailure: failedTests[0] ? { runId: failedTests[0].runId, outcome: failedTests[0].outcome } : null },
    blame: {
      probes: new Set(probes.map((r) => `${probedRun(r)}#${r.meta.probe!.callNo}`)).size,
      attempts: probes.filter((r) => r.bundled).length,
      runs: [...new Set(probes.map(probedRun))].map((runId) => {
        const run = index.byId.get(runId);
        return { runId, lostAt: run ? lostAt(classifiable(run)) : null };
      }),
    },
  };
}

/**
 * This week's runs as rows of calls, grouped under the recording they came from: the first run of
 * their lineage, shown as a context row when it is older than the week, as is any older run between
 * it and the week's runs. Families come newest first (by their newest run of the week) and are
 * added whole while they fit; one family too large for the grid shows its first rows.
 */
function runGrid(store: Store, index: RunIndex, runs: IndexedRun[], stats: Map<string, RunStats>, maxRows: number): RunGrid {
  const week = new Set(runs.map((r) => r.runId));
  // The run each row hangs under: its parent, or past an attempt (attempts are not rows), the run that attempt came from.
  const shownParent = (r: IndexedRun): IndexedRun | null => {
    let p = r.parentRunId ? index.byId.get(r.parentRunId) : undefined;
    for (let i = 0; p && p.bundled && i < 64; i++) p = p.parentRunId ? index.byId.get(p.parentRunId) : undefined;
    return p ?? null;
  };
  const members = new Map<string, IndexedRun>();
  const rootOf = new Map<string, IndexedRun>();
  for (const r of runs) {
    let cur = r;
    members.set(cur.runId, cur);
    for (let i = 0; i < 64; i++) {
      const p = shownParent(cur);
      if (!p || p.runId === r.runId) break;
      members.set(p.runId, p);
      cur = p;
    }
    rootOf.set(r.runId, cur);
  }
  const children = new Map<string, IndexedRun[]>();
  for (const m of members.values()) {
    const p = shownParent(m);
    if (!p || !members.has(p.runId)) continue;
    const list = children.get(p.runId) ?? [];
    list.push(m);
    children.set(p.runId, list);
  }
  const roots = new Map<string, IndexedRun>();
  for (const root of rootOf.values()) roots.set(root.runId, root);
  const families = [...roots.values()]
    .map((root) => {
      const rows: Array<{ run: IndexedRun; depth: number }> = [];
      const seen = new Set<string>();
      const walk = (run: IndexedRun, depth: number) => {
        if (seen.has(run.runId)) return;
        seen.add(run.runId);
        rows.push({ run, depth });
        for (const c of (children.get(run.runId) ?? []).sort((a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : 1))) if (depth < 64) walk(c, depth + 1);
      };
      walk(root, 0);
      return { rows, newest: rows.reduce((t, x) => (week.has(x.run.runId) ? Math.max(t, x.run.startedAt) : t), 0) };
    })
    .sort((a, b) => b.newest - a.newest);

  const picked: Array<Array<{ run: IndexedRun; depth: number }>> = [];
  let used = 0;
  for (const f of families) {
    if (used + f.rows.length > maxRows) {
      if (!picked.length) picked.push(f.rows.slice(0, maxRows));
      break;
    }
    picked.push(f.rows);
    used += f.rows.length;
  }
  const shownRuns = picked.flat();
  const totals = callTotals(store, index, shownRuns.map((x) => x.run));
  const total = sumStats(runs.map((r) => stats.get(r.runId)).filter((s): s is RunStats => !!s));
  const shown = shownRuns.filter((x) => week.has(x.run.runId)).length;
  return {
    runs: runs.length,
    calls: total.calls,
    origins: total.origins,
    families: picked.map((rows) => {
      const n = rows.reduce((t, x) => Math.max(t, x.run.calls), GRID_MIN_CALLS);
      const size = n > GRID_CELLS ? Math.ceil(n / GRID_CELLS) : 1;
      return {
        size,
        cols: Math.ceil(n / size),
        rows: rows.map(({ run, depth }) => ({
          runId: run.runId,
          parentRunId: run.parentRunId,
          depth,
          context: !week.has(run.runId),
          kind: run.kind,
          status: run.status,
          outcome: run.outcome,
          failed: run.failed,
          label: run.label,
          rescues: run.rescues,
          startedAt: run.startedAt,
          calls: run.calls,
          cells: originCells(totals.get(run.runId)?.codes ?? '', size),
          forkCell: run.kind === 'fork' && run.divergence ? Math.floor((run.divergence.callNo - 1) / size) : null,
          origins: countOrigins(totals.get(run.runId)?.codes ?? ''),
        })),
      };
    }),
    shown,
    more: runs.length - shown,
  };
}

/**
 * Goldens passing, from the runs `shadowlap test` made (`meta.test`): each golden's latest session
 * passes when enough of its attempts passed (`meta.test.passes` when the run says, otherwise all of
 * them). An attempt passes when it exited 0 and came out clean or with its checks passed; one that
 * was interrupted or timed out did not pass. A week ago is the same question asked of the runs
 * before this week.
 */
function testsSummary(index: RunIndex, now: number, weekStart: number): TestsSummary | null {
  const tests = index.runs.filter((r) => r.meta.test?.golden && r.status !== 'running' && r.startedAt <= now);
  if (!tests.length) return null;
  const verdicts = (before: number) => {
    const latest = new Map<string, { session: string; runs: IndexedRun[] }>();
    // Newest first: a golden's first run seen names its latest session.
    for (const r of tests) {
      if (r.startedAt >= before) continue;
      const { golden, session } = r.meta.test!;
      const found = latest.get(golden);
      if (!found) latest.set(golden, { session, runs: [r] });
      else if (found.session === session) found.runs.push(r);
    }
    const out = new Map<string, { passed: boolean; failedRun: IndexedRun | null }>();
    for (const [golden, { runs }] of latest) {
      const passes = (r: IndexedRun) => r.status === 'completed' && !r.failed;
      const passed = runs.filter(passes).length;
      const required = runs.find((r) => r.meta.test!.passes !== null)?.meta.test!.passes ?? runs.length;
      // The newest attempt that failed; the newest of all when too few attempts ran.
      out.set(golden, passed >= required ? { passed: true, failedRun: null } : { passed: false, failedRun: runs.find((r) => !passes(r)) ?? runs[0]! });
    }
    return out;
  };
  const count = (m: Map<string, { passed: boolean }>) => [...m.values()].filter((v) => v.passed).length;
  const current = verdicts(Number.POSITIVE_INFINITY);
  const before = verdicts(weekStart);
  const passing = count(current);
  const failing = [...current]
    .filter(([, v]) => v.failedRun)
    .map(([golden, v]) => ({ golden, runId: v.failedRun!.runId, outcome: v.failedRun!.outcome, at: v.failedRun!.startedAt }))
    .sort((a, b) => b.at - a.at || (a.golden < b.golden ? -1 : 1));
  return { goldens: current.size, passing, lastWeek: before.size ? count(before) : null, regressions: current.size - passing, lastRunAt: tests[0]!.startedAt, failing };
}

function cacheUse(store: Store, index: RunIndex, runs: IndexedRun[], stats: Map<string, RunStats>): CacheUse {
  let input = 0;
  let cacheRead = 0;
  const cached: IndexedRun[] = [];
  for (const r of runs) {
    const s = stats.get(r.runId);
    if (!s || !s.liveInput) continue;
    input += s.liveInput;
    cacheRead += s.liveCacheRead;
    cached.push(r);
  }
  const misses = cached.length ? cacheMisses(store, index, cached) : [];
  return { input, cacheRead, misses: misses.slice(0, 4), sentAgain: misses.reduce((t, m) => t + m.tokens, 0), missCount: misses.length };
}

function fixesFunnel(store: Store, index: RunIndex, options: StatsOptions, blamed: number, notBlamed: number, hook: FixesHookResult | null): FixesFunnel {
  const attempts = index.runs.filter((r) => r.meta.probe || r.meta.verify);
  const stats = runStats(store, index, attempts, options);
  return {
    failures: hook?.failures ?? blamed,
    blamed: hook?.blamed ?? blamed,
    verified: hook?.verified ?? null,
    applied: hook?.applied ?? null,
    open: hook?.open ?? blamed,
    notBlamed,
    attempts: attempts.length,
    spent: attempts.reduce((t, r) => t + (stats.get(r.runId)?.spent ?? 0), 0),
  };
}

/** Options for `overviewSummary` from a request's query string: tz. */
export function overviewOptions(params: URLSearchParams): Pick<OverviewOptions, 'tz'> | { error: string } {
  const tz = params.get('tz');
  if (!tz) return {};
  if (!isTimeZone(tz)) return { error: `tz: unknown time zone "${tz.slice(0, 64)}"` };
  return { tz };
}
