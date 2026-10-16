import { countOrigins, emptyOriginCounts, fixOfRun, importedRecording, lostAt, originCells, sumCacheUse, type OriginCounts, type RunKind, type RunOutcome, type RunStatus, type Store } from '@shadowlap/engine';
import { fixesSummary, needsLookFixes } from './fixes.js';
import { stepWords } from './store-steps.js';
import { addDays, daysFrom, dayIndex, isTimeZone, localDay, type LocalDay } from './local-days.js';
import { classifiable, loadRunIndex, type IndexedRun, type RunIndex } from './run-index.js';
import { cacheTotalsOf, cacheUseOf, callTotals, runStats, sumStats, type RunStats, type StatsOptions } from './run-stats.js';
import { failingTests, overviewTests, type GoldenList } from './tests.js';

/**
 * The Overview, worked out on the server: this week against last week, the last seven days, what
 * ran today, every run of the week as a row of calls, the outcomes that lead the page, and what
 * needs a look. A week is the last seven of the viewer's days, today included; last week is the
 * seven before.
 *
 * Runs and calls are counted without attempts (`--repeat`, blame probes, verify), which are bundled
 * under the run they came from: the grid, the week's calls, Calls by origin and Today count runs.
 * The week's money and time are not: what an attempt spent live was spent, and what it replayed
 * was not re-spent.
 *
 * The numbers other screens own come from their read models: Fixes (`fixesSummary`,
 * `needsLookFixes`) and Tests (`overviewTests`, `failingTests`, over the goldens on disk). The
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
  /** Calls today's runs were served from recordings: attempts are left out, as in every count of calls. */
  served: number;
  /** What replaying did not spend again today: attempts included, as the day's bar in the chart and the week's sums count money. */
  notRespent: number;
  /** Recordings in progress, with their calls so far. */
  recording: Array<{ runId: string; command: string; calls: number; startedAt: number }>;
  /** Clean replays today. */
  replays: number;
  /** Forks today (the one blame rescued a run with among them), the calls that went live in them, and the writes they blocked. */
  forks: { count: number; live: number; blocked: number };
  /** Test runs today, the failures among them, and the newest failure. */
  tests: { count: number; failed: number; latestFailure: { runId: string; outcome: RunOutcome } | null };
  /**
   * Blame today: the model calls it probed, its attempts (bundled under the run they probed), and
   * the runs it probed, each with how its blame came out (null while it is still probing), where
   * it was lost, and the fix it belongs to.
   */
  blame: { probes: number; attempts: number; runs: Array<{ runId: string; outcome: BlameOutcome | null; lostAt: number | null; title: string | null; fixId: string | null }> };
}

/** How a blame came out (`meta.blame.outcome`): it found the model call that lost the run, no model call rescued it, or it stopped before the search finished. */
export type BlameOutcome = 'blamed' | 'unrescuable' | 'stopped';

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

/** Tests passing: the goldens on disk with a result, those passing now and when this week started, the regressions caught, the last run. */
export interface TestsTile {
  goldens: number;
  passing: number;
  /** Passing as the tests stood when this week started; null without results that old. */
  lastWeek: number | null;
  regressions: number;
  lastRunAt: number | null;
}

export interface OutcomeStrip {
  /** Failures blame replayed exactly before probing (by a run's first blame), this week and last, and the fixes still open. */
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

/**
 * One line of Needs a look, most urgent first: a team store's setup left unfinished, an applied fix
 * that doesn't hold, a failing test, a failure with no fix yet (an open fix, then a failed run never
 * blamed), a verified fix waiting to be applied, and runs only on this machine when a team store is
 * set. Past ten of a kind, one line says how many more there are and opens the page that lists them
 * (`more` is that count).
 */
export interface NeedsLookRow {
  kind: 'store-setup' | 'broken' | 'test' | 'open' | 'unblamed' | 'ready' | 'local';
  /** The icon: a setting, a failure, a blame, a fix that holds, or a recording. */
  icon: 'setting' | 'fail' | 'blame' | 'fixok' | 'rec';
  title: string;
  detail: string;
  /** The word before the arrow: Open, Fix, Fix it, Run blame, Apply, Push. */
  action: string;
  href: string;
  runId: string | null;
  fixId: string | null;
  at: number;
  /** For the line that stands for the rest of its kind: how many it stands for. */
  more?: number;
}

export interface NeedsLook {
  /** Every line, most urgent first: each kind's first ten, then a line for the rest of that kind. */
  items: NeedsLookRow[];
  /** Everything that needs a look, the panel's count: a line each, a line for the rest of its kind as many as it stands for. */
  total: number;
}

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
  /** Rows of the run grid: families are added whole, newest first, while they fit (40 unless asked). */
  gridRows?: number;
  /** The goldens on disk (the CLI's `projectGoldens`): Tests passing and failing tests. Without any, there are no goldens yet. */
  goldens?: GoldenList;
  /** The team store, when the config names one: its runs only on this machine join Needs a look. */
  teamStore?: StoreNote | null;
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
/** Lines of one kind Needs a look lists one by one; past them (and one more), a line stands for the rest. */
const NEEDS_LOOK_EACH = 10;

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
  // Recordings in progress, as the top bar's chip counts them: a run whose recorder stopped without
  // ending it (killed, out of memory) is still marked running, but nothing is recording it.
  const recording = new Set(store.recordingRuns(now).live.map((x) => x.run.runId));
  // Blames and verdicts in the same weeks as the runs: the viewer's days, not 7 × 24 hours up to now.
  const fixes = fixesSummary(store, now, { week, lastWeek });
  const goldens = options.goldens ?? [];
  const tests = goldens.length ? overviewTests(store, { now, weekStart: week.from }, { goldens }) : null;

  return {
    tz,
    now,
    windows: { week, lastWeek },
    sums,
    daily,
    counts: index.counts,
    today: todayPanel(store, index, inWindow, stats, today, recording),
    grid: runGrid(store, index, thisWeek, stats, Math.max(1, Math.min(500, Math.floor(options.gridRows ?? 40) || 40)), recording),
    outcomes: {
      reproduced: { value: fixes.reproduced.thisWeek, lastWeek: fixes.reproduced.lastWeek, open: fixes.open },
      fixesVerified: { value: fixes.verified.thisWeek, lastWeek: fixes.verified.lastWeek, rejected: fixes.rejected.thisWeek },
      testsPassing: tests,
      spent: { value: sums.week.spent, lastWeek: sums.lastWeek.spent, notRespent: sums.week.notRespent, notWaitedMs: sums.week.notWaitedMs },
    },
    cache: weekCache(store, index, week.from),
    fixes: { ...fixes.funnel, open: fixes.open, readyToApply: fixes.readyToApply, broken: fixes.broken, attempts: fixes.attempts, spent: fixes.spent },
    needsLook: needsLook(store, goldens, options.teamStore ?? null),
  };
}

function todayPanel(store: Store, index: RunIndex, inWindow: IndexedRun[], stats: Map<string, RunStats>, today: LocalDay, recordingNow: ReadonlySet<string>): TodayPanel {
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
    notRespent: sum(runs, (s) => s.saved),
    recording: index.runs.filter((r) => recordingNow.has(r.runId) && r.mode === 'record' && !r.bundled).map((r) => ({ runId: r.runId, command: r.argv.join(' '), calls: r.calls, startedAt: r.startedAt })),
    replays: of('clean').length,
    forks: { count: forks.length, live: sum(forks, (s) => s.origins.l), blocked: sum(forks, (s) => s.origins.b) },
    tests: { count: tests.length, failed: failedTests.length, latestFailure: failedTests[0] ? { runId: failedTests[0].runId, outcome: failedTests[0].outcome } : null },
    blame: {
      probes: new Set(probes.map((r) => `${probedRun(r)}#${r.meta.probe!.callNo}`)).size,
      attempts: probes.filter((r) => r.bundled).length,
      runs: [...new Set(probes.map(probedRun))].map((runId) => {
        const run = index.byId.get(runId);
        const fix = fixOfRun(store, runId);
        const outcome = run?.meta.blame?.outcome;
        return { runId, outcome: outcome === 'blamed' || outcome === 'unrescuable' || outcome === 'stopped' ? outcome : null, lostAt: run ? lostAt(classifiable(run)) : null, title: fix?.title ?? null, fixId: fix?.fixId ?? null };
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
function runGrid(store: Store, index: RunIndex, runs: IndexedRun[], stats: Map<string, RunStats>, maxRows: number, recordingNow: ReadonlySet<string>): RunGrid {
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
          // Only a run something is recording grows in place; one its recorder left reads as interrupted.
          status: run.status === 'running' && !recordingNow.has(run.runId) ? 'crashed' : run.status,
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
 * Live model calls' cache use in runs started since the week started: the engine's `cacheUse`
 * (attempts included, imported recordings left out: they were live somewhere else), summed by its
 * `sumCacheUse` from each run's part as `run_stats` keeps it (worked out once per run, the first
 * time a week asks), with each miss's run kind for its icon. Largest misses first.
 */
function weekCache(store: Store, index: RunIndex, since: number): CacheUse {
  const runs = index.runs.filter((r) => r.startedAt >= since && !importedRecording(r));
  const caches = cacheTotalsOf(store, index, runs);
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

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * Needs a look, most urgent first: a team store's setup left unfinished, applied fixes that don't
 * hold, failing tests, failures with no fix yet (open fixes, then failed runs never blamed), verified
 * fixes not yet applied, then runs only on this machine. A recording in progress shows under Today
 * instead.
 */
function needsLook(store: Store, goldens: GoldenList, teamStore: StoreNote | null): NeedsLook {
  const fixes = needsLookFixes(store);
  const of = (kind: string) => fixes.filter((f) => f.kind === kind);
  const fixRow = (f: (typeof fixes)[number]): NeedsLookRow => ({ kind: f.kind, icon: f.icon, title: f.title, detail: f.detail, action: f.action, href: f.href, runId: f.runId, fixId: f.fixId, at: f.at });
  const tests: NeedsLookRow[] = goldens.length
    ? failingTests(store, { goldens }).map((t) => ({ kind: 'test', icon: 'fail', title: t.title, detail: t.line, action: 'Fix', href: t.href, runId: t.runId, fixId: null, at: t.at }))
    : [];
  // On Runs, as the design has it: the runs only here carry the local tag, and Push in the bulk bar
  // sends the ones picked (Settings → Store's Push local runs sends them all).
  const local: NeedsLookRow[] =
    teamStore && teamStore.onlyLocal > 0
      ? [
          {
            kind: 'local',
            icon: 'rec',
            title: `${plural(teamStore.onlyLocal, 'run is', 'runs are')} only on this machine`,
            detail: `push ${teamStore.onlyLocal === 1 ? 'it' : 'them'} so the team can open ${teamStore.onlyLocal === 1 ? 'it' : 'them'}`,
            action: 'Push',
            href: '#/runs',
            runId: null,
            fixId: null,
            at: 0,
          },
        ]
      : [];
  // A store's setup left half done leads back to its page until it is finished, as the design's setup
  // holds the Overview until then: first, since the team gets nothing from a store set up halfway.
  const setup: NeedsLookRow[] = teamStore?.setup
    ? [{ kind: 'store-setup', icon: 'setting', title: 'The team store’s setup isn’t finished', detail: `step ${teamStore.setup.step} of 4: ${stepWords(teamStore.setup.title)}`, action: 'Continue', href: '#/setup/store', runId: null, fixId: null, at: 0 }]
    : [];
  // Each kind's first lines, then one that says how many more there are and where they are listed:
  // a long-lived project's failures never blamed must not push its fixes ready to apply out of sight.
  const capped = (rows: NeedsLookRow[], rest: (n: number) => Pick<NeedsLookRow, 'icon' | 'title' | 'detail' | 'href'>): NeedsLookRow[] => {
    if (rows.length <= NEEDS_LOOK_EACH + 1) return rows;
    const n = rows.length - NEEDS_LOOK_EACH;
    return [...rows.slice(0, NEEDS_LOOK_EACH), { kind: rows[0]!.kind, action: 'Open', runId: null, fixId: null, at: rows[NEEDS_LOOK_EACH]!.at, more: n, ...rest(n) }];
  };
  const all = [
    ...setup,
    ...capped(of('broken').map(fixRow), (n) => ({ icon: 'fail', title: `${plural(n, 'more applied fix', 'more applied fixes')} ${n === 1 ? "doesn't" : "don't"} hold`, detail: 'each on Fixes', href: '#/fixes' })),
    ...capped(tests, (n) => ({ icon: 'fail', title: `${plural(n, 'more test')} failed`, detail: 'each on Tests', href: '#/tests' })),
    ...capped(of('open').map(fixRow), (n) => ({ icon: 'blame', title: `${plural(n, 'more failure')} with no fix yet`, detail: 'each on Fixes', href: '#/fixes' })),
    ...capped(of('unblamed').map(fixRow), (n) => ({ icon: 'fail', title: `${plural(n, 'more failed run')} not blamed yet`, detail: 'the failed runs on Runs', href: '#/runs?type=failed' })),
    ...capped(of('ready').map(fixRow), (n) => ({ icon: 'fixok', title: `${plural(n, 'more verified fix', 'more verified fixes')} ${n === 1 ? 'is' : 'are'} ready`, detail: 'each on Fixes', href: '#/fixes' })),
    ...local,
  ];
  return { items: all, total: all.reduce((t, x) => t + (x.more ?? 1), 0) };
}

/** Options for `overviewSummary` from a request's query string: tz. */
export function overviewOptions(params: URLSearchParams): Pick<OverviewOptions, 'tz'> | { error: string } {
  const tz = params.get('tz');
  if (!tz) return {};
  if (!isTimeZone(tz)) return { error: `tz: unknown time zone "${tz.slice(0, 64)}"` };
  return { tz };
}
