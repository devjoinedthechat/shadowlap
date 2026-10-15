import { emptyOriginCounts, lostAt, originCells, type OriginCounts, type RunKind, type RunOutcome, type RunStatus, type Store } from '@shadowlap/engine';
import { addDays, daysFrom, dayIndex, isTimeZone, localDay, type LocalDay } from './local-days.js';
import { classifiable, loadRunIndex, type IndexedRun, type RunIndex } from './run-index.js';
import { cacheMisses, originStrings, runStats, sumStats, type CacheMiss, type RunStats, type StatsOptions } from './run-stats.js';

/**
 * The Overview, worked out on the server: this week against last week, the last seven days, what
 * ran today, every run of the week as a row of calls, and the outcomes that lead the page. A week
 * is the last seven of the viewer's days, today included; last week is the seven before.
 *
 * Runs and calls are counted without attempts (`--repeat`, blame probes, verify), which are bundled
 * under the run they came from. Money and time are not: what an attempt spent live was spent, and
 * what it replayed was not re-spent.
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
  /** What replaying did not spend again: the recorded cost of every replayed model call. */
  notRespent: number;
  /** The recorded duration of every replayed call: time not waited. */
  notWaitedMs: number;
  /** Attempts that started in the window, and what they spent live. */
  attempts: number;
  attemptsSpent: number;
}

export interface DaySums {
  /** `YYYY-MM-DD` in the viewer's zone. */
  day: string;
  start: number;
  spent: number;
  notRespent: number;
}

export interface TodayPanel {
  day: string;
  /** Calls served from recordings today, attempts included, and what that did not re-spend. */
  served: number;
  notRespent: number;
  /** Recordings in progress, with their calls so far. */
  recording: Array<{ runId: string; command: string; calls: number; startedAt: number }>;
  /** Clean replays today. */
  replays: number;
  /** Forks today, the calls that went live in them, and the writes they blocked. */
  forks: { count: number; live: number; blocked: number };
  /** Test runs today, the failures among them, and the newest failure. */
  tests: { count: number; failed: number; latestFailure: { runId: string; outcome: RunOutcome } | null };
  /** Blame today: the calls it probed, the attempts it ran, and the runs it blamed with where each was lost. */
  blame: { probes: number; attempts: number; runs: Array<{ runId: string; lostAt: number | null }> };
}

export interface GridRow {
  runId: string;
  parentRunId: string | null;
  /** Indent under the family's first run. */
  depth: number;
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
  /** Cells the family's scale spans: at least 30 calls, so a fork's replayed prefix lines up under its parent. */
  cols: number;
  rows: GridRow[];
}

export interface RunGrid {
  /** Every run of the week, attempts left out, and their calls by origin. */
  runs: number;
  calls: number;
  origins: OriginCounts;
  /** Newest family first; each a recording (or a run whose parent is older) with what came from it this week. */
  families: GridFamily[];
  /** Rows shown, and runs of the week left for All runs. */
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
  regressions: number;
  lastRunAt: number | null;
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

export interface FixesFunnel {
  /** Every failure so far (runs, attempts left out), how many blame reproduced, how many have a verified fix, and how many are applied. */
  failures: number;
  blamed: number;
  verified: number | null;
  applied: number | null;
  open: number;
  /** The blame probes and verify attempts behind them, and what they spent live. */
  attempts: number;
  spent: number;
}

/** What other slices know better. Until they hook in, the narrow local versions here stand in. */
export interface OverviewHooks {
  /** Fixes (stored verdicts, fixes grouped by failure): replaces the funnel's verified and applied, and the open count. */
  fixes?: (windows: { week: TimeWindow; lastWeek: TimeWindow }) => { accepted: number; acceptedLastWeek: number; rejected: number; open: number; verified: number; applied: number } | null;
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
}

const GRID_CELLS = 60;
const GRID_MIN_CALLS = 30;

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
  const blamedEver = index.runs.filter((r) => r.meta.blame).length;
  const open = fixHook?.open ?? blamedEver;
  const blamedIn = (w: TimeWindow) => index.runs.filter((r) => r.meta.blame && r.meta.blame.at >= w.from && r.meta.blame.at < w.to).length;

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
    cache: hooks.cache?.(thisWeek.map((r) => r.runId)) ?? cacheUse(store, thisWeek, stats),
    fixes: fixesFunnel(store, index, options, { open, verified: fixHook?.verified ?? null, applied: fixHook?.applied ?? null }),
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
  const probes = runs.filter((r) => r.meta.probe);
  const blamed = [...new Set(probes.map((r) => r.meta.probe!.of))];
  return {
    day: today.key,
    served: sum(runs, (s) => s.origins.r),
    notRespent: sum(runs, (s) => s.saved),
    recording: index.runs.filter((r) => r.status === 'running' && r.mode === 'record' && !r.bundled).map((r) => ({ runId: r.runId, command: r.argv.join(' '), calls: r.calls, startedAt: r.startedAt })),
    replays: of('clean').length,
    forks: { count: forks.length, live: sum(forks, (s) => s.origins.l), blocked: sum(forks, (s) => s.origins.b) },
    tests: { count: tests.length, failed: failedTests.length, latestFailure: failedTests[0] ? { runId: failedTests[0].runId, outcome: failedTests[0].outcome } : null },
    blame: {
      probes: new Set(probes.map((r) => `${r.meta.probe!.of}#${r.meta.probe!.callNo}`)).size,
      attempts: probes.length,
      runs: blamed.map((runId) => {
        const run = index.byId.get(runId);
        return { runId, lostAt: run ? lostAt(classifiable(run)) : null };
      }),
    },
  };
}

/**
 * This week's runs as rows of calls, grouped under the run they came from. Families come newest
 * first (by their newest run) and are added whole while they fit; one family too large for the
 * grid shows its first rows.
 */
function runGrid(store: Store, index: RunIndex, runs: IndexedRun[], stats: Map<string, RunStats>, maxRows: number): RunGrid {
  const ids = new Set(runs.map((r) => r.runId));
  const children = new Map<string, IndexedRun[]>();
  for (const r of runs) {
    if (!r.parentRunId || !ids.has(r.parentRunId)) continue;
    const list = children.get(r.parentRunId) ?? [];
    list.push(r);
    children.set(r.parentRunId, list);
  }
  const families = runs
    .filter((r) => !r.parentRunId || !ids.has(r.parentRunId))
    .map((root) => {
      const rows: Array<{ run: IndexedRun; depth: number }> = [];
      const walk = (run: IndexedRun, depth: number) => {
        rows.push({ run, depth });
        for (const c of (children.get(run.runId) ?? []).sort((a, b) => a.startedAt - b.startedAt)) if (depth < 64) walk(c, depth + 1);
      };
      walk(root, 0);
      return { rows, newest: rows.reduce((t, x) => Math.max(t, x.run.startedAt), 0) };
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
  const codes = originStrings(store, shownRuns.map((x) => x.run.runId));
  const total = sumStats(runs.map((r) => stats.get(r.runId)).filter((s): s is RunStats => !!s));
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
          kind: run.kind,
          status: run.status,
          outcome: run.outcome,
          failed: run.failed,
          label: run.label,
          rescues: run.rescues,
          startedAt: run.startedAt,
          calls: run.calls,
          cells: originCells(codes.get(run.runId) ?? '', size),
          forkCell: run.kind === 'fork' && run.divergence ? Math.floor((run.divergence.callNo - 1) / size) : null,
          origins: stats.get(run.runId)?.origins ?? emptyOriginCounts(),
        })),
      };
    }),
    shown: shownRuns.length,
    more: runs.length - shownRuns.length,
  };
}

/**
 * Goldens passing, from the runs `shadowlap test` made (`meta.test`): each golden's latest finished
 * run passes unless it failed. A week ago is the same question asked of the runs before this week.
 */
function testsSummary(index: RunIndex, now: number, weekStart: number): TestsSummary | null {
  const tests = index.runs.filter((r) => r.meta.test?.golden && r.status !== 'running' && r.startedAt <= now);
  if (!tests.length) return null;
  const latest = (before: number) => {
    const out = new Map<string, IndexedRun>();
    for (const r of tests) if (r.startedAt < before && !out.has(r.meta.test!.golden)) out.set(r.meta.test!.golden, r); // newest first
    return out;
  };
  const current = latest(Number.POSITIVE_INFINITY);
  const passing = [...current.values()].filter((r) => !r.failed).length;
  const before = latest(weekStart);
  return {
    goldens: current.size,
    passing,
    lastWeek: before.size ? [...before.values()].filter((r) => !r.failed).length : null,
    regressions: current.size - passing,
    lastRunAt: tests[0]!.startedAt,
  };
}

function cacheUse(store: Store, runs: IndexedRun[], stats: Map<string, RunStats>): CacheUse {
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
  const misses = cached.length ? cacheMisses(store, cached) : [];
  return { input, cacheRead, misses: misses.slice(0, 4), sentAgain: misses.reduce((t, m) => t + m.tokens, 0), missCount: misses.length };
}

function fixesFunnel(store: Store, index: RunIndex, options: StatsOptions, known: { open: number; verified: number | null; applied: number | null }): FixesFunnel {
  const attempts = index.runs.filter((r) => r.meta.probe || r.meta.verify);
  const stats = runStats(store, index, attempts, options);
  return {
    failures: index.runs.filter((r) => r.failed && !r.bundled).length,
    blamed: index.runs.filter((r) => r.meta.blame).length,
    verified: known.verified,
    applied: known.applied,
    open: known.open,
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
