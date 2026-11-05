import { checksOf, cleanLabel, isFailedOutcome, lostAt, messageOf, runOutcome, withLabels, type AttemptKind, type RunKind, type RunOutcome, type Store, type StoreOf } from '@shadowlap/engine';
import type { RunListItem } from './api.js';
import { filterTerms } from './links.js';
import { addDays, daysFrom, dayIndex, isTimeZone, localDay } from './local-days.js';
import { aboutsOf, aboutsWithin, knownAbouts } from './run-about.js';
import { classifiable, depthOf, fixedOutcome, loadRunIndex, type IndexedRun, type RunIndex } from './run-index.js';
import type { NextStepRow } from './next-step.js';
import type { RunJudged } from './run-outcome.js';
import { callTotals, callTotalsWithin, knownSpent, priced, spentOf, totalsKnown, type StatsOptions } from './run-stats.js';

/**
 * The Runs page: a page of the table at a time, the 12-week calendar above it, and the bulk
 * actions; and the sidebar's Recent runs. Attempts (`--repeat`, blame probes, verify attempts) are
 * not rows: each run says how many it bundles, and `includeAttempts` lists them for a view that
 * wants them.
 */

/**
 * The table's type chips. The kinds add up (forks or clean replays); Failed narrows to failures, and
 * Local, with a team store, to the runs only on this machine (`localRuns`).
 */
export type RunType = 'recording' | 'fork' | 'clean' | 'test' | 'capture' | 'failed' | 'local';
export const RUN_TYPES: readonly RunType[] = ['recording', 'fork', 'clean', 'test', 'capture', 'failed', 'local'];

/** The kinds each chip shows. A recording from a pack is a recording; a replay that never finished shows under All. */
const TYPE_KINDS: Readonly<Record<Exclude<RunType, 'failed' | 'local'>, readonly RunKind[]>> = {
  recording: ['recording', 'pack'],
  fork: ['fork'],
  clean: ['clean'],
  test: ['test'],
  capture: ['capture'],
};

export type RunSort = 'when' | 'calls' | 'spent';
export const RUN_SORTS: readonly RunSort[] = ['when', 'calls', 'spent'];

export interface RunFilter {
  /** Runs that started at or after this instant (epoch ms). */
  from?: number | null;
  /** Runs that started before this instant (epoch ms). */
  to?: number | null;
  types?: readonly RunType[];
  /** The filter field: every word must appear in the run's id, about line, labels, command, source or revision; `label:<name>` is that label exactly. */
  q?: string;
  /** List attempts as rows too. */
  includeAttempts?: boolean;
  /**
   * With a team store, the runs only on this machine, as its status counts them (`teamRunCounts`):
   * what the Local chip shows, and counts. Without one, Local matches nothing.
   */
  localRuns?: ReadonlySet<string> | null;
  /**
   * Match and order by what is known, and say what isn't yet (`warming`), rather than work it out
   * now: the about lines of recordings whose user's first words the warm-up has yet to read, and,
   * sorted by spent, the totals of runs it has yet to add up. What the dashboard asks for.
   */
  known?: boolean;
}

export interface RunsPageOptions extends RunFilter, StatsOptions {
  /** Rows per page: 50 unless asked, at most 500. */
  limit?: number;
  /** `next` from the page before. */
  cursor?: string | null;
  /**
   * Newest first by default. By calls or by spent, most first, with runs still in progress on top:
   * their numbers grow while they run, so they are kept apart and a page never skips one.
   */
  sort?: RunSort;
}

/** A row of the Runs table: what the run list has always said, plus its kind, outcome, origins and bundle. */
export interface RunRow extends RunListItem {
  kind: RunKind;
  /** When attempts are listed: the run an attempt is bundled under. */
  attemptOf: string | null;
  attemptKind: AttemptKind | null;
  /** The fork blame rescued a run with: the run it rescued. */
  rescues: string | null;
  outcome: RunOutcome;
  failed: boolean;
  /** One character per call: r replayed, l live, o overridden, i injected, f failed, b blocked, s stubbed. */
  origins: string;
  /** Attempts bundled under this run, those bundled under them in turn included: what deleting it takes with it. */
  attempts: number;
  /**
   * Its totals (what it spent, its calls by origin) aren't worked out yet: too long to add up inside
   * the request, they come with the warm-up beside the server, or once a recording ends.
   */
  warming?: true;
  /** The model call blame found lost the run. */
  lostAt: number | null;
  checks: { passed: number; total: number } | null;
  /** Who made it (`meta.author`): an email, a user name, or `ci`. */
  author: string | null;
  /** For a run made in CI: the provider (`meta.ci`), such as `github`. */
  ci: string | null;
  /**
   * Its outcome by checks (run-outcome.ts): its own, a capture's by the rules on calls, or its
   * family's goldens' judged from its recording; null when no check judges it. Absent while it isn't
   * judged yet: a long run past what a list reads, judged once its page or a later list reaches it.
   */
  judged?: RunJudged | null;
  /** Its next step in its light form (next-step.ts `stepRow`): which one, its words and its link, so a list says what the run's page leads with. */
  next?: NextStepRow;
}

export interface ChipCounts {
  all: number;
  recording: number;
  fork: number;
  clean: number;
  test: number;
  capture: number;
  failed: number;
  /** Runs only on this machine, with a team store; 0 without one. */
  local: number;
}

export interface RunsPage {
  runs: RunRow[];
  /** Runs the filter matches, on every page. */
  total: number;
  /** Pass as `cursor` for the next page; null on the last. */
  next: string | null;
  /** Per chip, within the date range (the filter field and the chip picked don't change them). */
  chipCounts: ChipCounts;
  /**
   * Set while what the page is ordered or filtered by isn't all known yet, and is being worked out
   * beside the server: the about lines the filter field matches (`done` of `total` recordings), or
   * what runs spent for the sort by spent. Matches among the rest may be missing, or out of place;
   * asked again, the page has more of them.
   */
  warming?: { done: number; total: number };
}

interface Matcher {
  /** Listed at all: attempts only when asked, and within the date range. */
  scope: (r: IndexedRun) => boolean;
  /** The chips' kinds, Local and the filter field, without Failed: what failures are counted out of. */
  base: (r: IndexedRun) => boolean;
  /** Everything the filter asks for. */
  matches: (r: IndexedRun) => boolean;
}

/** The filter field's words and its `label:<name>` terms (links.ts, which the page reads them with too). */
export { filterTerms };

const filterWords = (filter: RunFilter): string[] => filterTerms(filter.q).words;

/**
 * The about line of each run the filter field may match, as far as it is known, worked out only
 * when the field has words: a recording's quotes what its user asked, which the run index brings
 * once the warm-up has worked it out. No request is read here: `pending` counts the recordings
 * whose about line isn't known yet, out of `of`.
 */
function aboutTexts(store: Store, index: RunIndex, runs: readonly IndexedRun[], filter: RunFilter): { text: (r: IndexedRun) => string; pending: number; of: number } {
  if (!filterWords(filter).length) return { text: () => '', pending: 0, of: 0 };
  if (!filter.known) {
    const abouts = aboutsOf(store, index, runs);
    return { text: (r) => abouts.get(r.runId)?.text ?? '', pending: 0, of: abouts.size };
  }
  const { abouts, pending } = knownAbouts(store, index, runs);
  return { text: (r) => abouts.get(r.runId)?.text ?? '', pending: pending.size, of: abouts.size + pending.size };
}

function matcher(filter: RunFilter, aboutText: (r: IndexedRun) => string = () => ''): Matcher {
  const types = filter.types ?? [];
  const kinds = new Set(types.flatMap((t) => (t === 'failed' || t === 'local' ? [] : TYPE_KINDS[t])));
  const failedOnly = types.includes('failed');
  const localOnly = types.includes('local');
  const local = filter.localRuns ?? null;
  const { words, labels } = filterTerms(filter.q);
  // A run's about line counts, and so does the kind Runs words it as (`clean replay`, `fork @17`), as
  // an exported copy's filter reads them (ui/runs.ts `matchesText`); a `label:` term, the label alone.
  const text = (r: IndexedRun) => {
    if (!labels.every((l) => r.meta.labels.includes(l))) return false;
    if (!words.length) return true;
    const hay = [r.runId, aboutText(r), ...r.meta.labels, r.argv.join(' '), r.source ?? '', r.codeVersion ?? '', r.label].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const scope = (r: IndexedRun) => (filter.includeAttempts || !r.bundled) && (filter.from == null || r.startedAt >= filter.from) && (filter.to == null || r.startedAt < filter.to);
  // Local narrows what failures are counted out of, as a kind does: the calendar's "8 of 12 local runs".
  const base = (r: IndexedRun) => scope(r) && (!kinds.size || kinds.has(r.kind)) && (!localOnly || !!local?.has(r.runId)) && text(r);
  return { scope, base, matches: (r) => base(r) && (!failedOnly || r.failed) };
}

/** Every run the filter matches, newest first, as the table lists them. */
export function matchingRuns(store: Store, filter: RunFilter): IndexedRun[] {
  const index = loadRunIndex(store);
  const all = withLiveness(store, index);
  const scoped = all.filter(matcher(filter).scope);
  return all.filter(matcher(filter, aboutTexts(store, index, scoped, filter).text).matches);
}

/**
 * The index's runs as the lists show them now: a run the store still marks running though nothing
 * records it (its recorder was killed, or ran out of memory, before ending it) is interrupted, as
 * the Overview's grid and the top bar's chip have it. Nothing adds to such a run or ends it until
 * gc marks it interrupted; meanwhile it can be deleted, packed and pushed like a run that ended.
 * Asked on every read: a recorder can stop without anything in the store changing.
 */
export function withLiveness(store: StoreOf<'recording'>, index: RunIndex): IndexedRun[] {
  if (!index.runs.some((r) => r.status === 'running')) return index.runs;
  const left = leftRunning(store);
  if (!left.size) return index.runs;
  return index.runs.map((r) => {
    const lastAt = left.get(r.runId);
    return lastAt === undefined ? r : interrupted(index, r, lastAt);
  });
}

/** The runs the store marks running that nothing records any more, with each one's last call (or its start). */
function leftRunning(store: StoreOf<'recording'>): Map<string, number> {
  return new Map(store.recordingRuns().abandoned.map((x) => [x.run.runId, x.lastAt]));
}

/**
 * A run its recorder left, as an interrupted run: ended at its last call, as gc ends it, with its
 * outcome worked out again for that status (the kind stays).
 */
function interrupted(index: RunIndex, r: IndexedRun, lastAt: number): IndexedRun {
  const p = r.parentRunId ? index.byId.get(r.parentRunId) : undefined;
  const outcome = fixedOutcome(runOutcome(classifiable({ ...r, status: 'crashed' }), { kind: r.kind, calls: r.calls, parent: p ? { calls: p.calls, status: p.status } : null, injected: r.injected, offline: r.offline }), r.fixCheck);
  return { ...r, status: 'crashed', endedAt: r.endedAt ?? lastAt, outcome, failed: isFailedOutcome(outcome) };
}

/**
 * A run's state as every list shows it and its own page does: its status (`crashed` for one its
 * recorder left running: interrupted), its kind, how it came out and whether that is a failure.
 * Interrupted means stopped before it ended with nothing else that failed: the lists say so in a
 * neutral tone, never as a failure.
 */
export interface RunState {
  status: IndexedRun['status'];
  /** When it ended: for one its recorder left, its last call, as gc would end it; null while it records. */
  endedAt: number | null;
  kind: RunKind;
  outcome: RunOutcome;
  failed: boolean;
  interrupted: boolean;
  /** The kind as the run list's line under the id says it: recording, fork @n, clean replay, … */
  label: string;
}

/** One run's state, from the same index and liveness check the run list reads. */
export function runState(store: StoreOf<'recording' | 'readModels'>, runId: string): RunState | null {
  return runStates(store)(runId);
}

/**
 * Each run's state as `runState` gives it, from one index and at most one liveness check: for a read
 * model that tells several runs (a run's family, each run in it as the lists show it).
 */
export function runStates(store: StoreOf<'recording' | 'readModels'>): (runId: string) => RunState | null {
  const index = loadRunIndex(store);
  let left: Map<string, number> | null = null;
  return (runId) => {
    const found = index.byId.get(runId);
    if (!found) return null;
    const lastAt = found.status === 'running' ? (left ??= leftRunning(store)).get(runId) : undefined;
    const r = lastAt === undefined ? found : interrupted(index, found, lastAt);
    return { status: r.status, endedAt: r.endedAt, kind: r.kind, outcome: r.outcome, failed: r.failed, interrupted: r.status === 'crashed' && !r.failed, label: r.label };
  };
}

export function chipCounts(runs: Iterable<IndexedRun>, inScope: (r: IndexedRun) => boolean, localRuns: ReadonlySet<string> | null = null): ChipCounts {
  const c: ChipCounts = { all: 0, recording: 0, fork: 0, clean: 0, test: 0, capture: 0, failed: 0, local: 0 };
  for (const r of runs) {
    if (!inScope(r)) continue;
    c.all++;
    if (r.failed) c.failed++;
    if (localRuns?.has(r.runId)) c.local++;
    for (const t of ['recording', 'fork', 'clean', 'test', 'capture'] as const) if (TYPE_KINDS[t].includes(r.kind)) c[t]++;
  }
  return c;
}

// ---- the table ----

interface SortKey {
  s: RunSort;
  /** 1 for a run still in progress, kept on top in the sorts by calls and spent; 0 otherwise. */
  g: 0 | 1;
  v: number;
  t: number;
  id: string;
}

/** Runs in progress first, then descending by the sort's value, then by start time and id, so every row has one place. */
function compareKeys(a: SortKey, b: SortKey): number {
  return b.g - a.g || b.v - a.v || b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function encodeCursor(k: SortKey): string {
  return Buffer.from(JSON.stringify(k)).toString('base64url');
}

function decodeCursor(cursor: string, sort: RunSort): SortKey {
  try {
    const k = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<SortKey>;
    if (k.s === sort && (k.g === 0 || k.g === 1) && typeof k.v === 'number' && typeof k.t === 'number' && typeof k.id === 'string') return { s: sort, g: k.g, v: k.v, t: k.t, id: k.id };
  } catch {
    // reported below
  }
  throw new RangeError('this cursor is not one the run list gave out for this sort');
}

/** One page of the Runs table. Throws a RangeError for a cursor it did not hand out. */
export function listRunsPage(store: Store, options: RunsPageOptions = {}): RunsPage {
  const index = loadRunIndex(store);
  const all = withLiveness(store, index);
  const sort = options.sort ?? 'when';
  const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 50) || 50));
  const texts = aboutTexts(store, index, all.filter(matcher(options).scope), options);
  const m = matcher(options, texts.text);
  const matching = all.filter(m.matches);
  // By spent, from what is known: the runs whose totals aren't, the warm-up works out meanwhile.
  const finished = sort === 'spent' ? matching.filter((r) => r.status !== 'running') : [];
  const totals = options.known && sort === 'spent' ? totalsKnown(store, index, finished) : null;
  const unknownSpent = totals ? totals.total - totals.done : 0;
  const spent = sort === 'spent' ? (unknownSpent ? knownSpent(store, index, finished, options) : spentOf(store, index, finished, options)) : null;
  const keyOf = (r: IndexedRun): SortKey => {
    // A run in progress is still adding calls and cost: it sorts by when it started, on top.
    if (sort === 'when' || r.status === 'running') return { s: sort, g: sort === 'when' ? 0 : 1, v: 0, t: r.startedAt, id: r.runId };
    return { s: sort, g: 0, v: sort === 'calls' ? r.calls : (spent!.get(r.runId) ?? 0), t: r.startedAt, id: r.runId };
  };
  const keyed = matching.map((r) => ({ r, k: keyOf(r) }));
  // The index is newest first already; the other sorts reorder it.
  if (sort !== 'when') keyed.sort((a, b) => compareKeys(a.k, b.k));
  let start = 0;
  if (options.cursor) {
    const after = decodeCursor(options.cursor, sort);
    start = keyed.findIndex((x) => compareKeys(after, x.k) < 0);
    if (start < 0) start = keyed.length;
  }
  const page = keyed.slice(start, start + limit);
  const last = page[page.length - 1];
  const listed = rows(store, index, page.map((x) => x.r), options);
  const warming = texts.pending ? { done: texts.of - texts.pending, total: texts.of } : totals && unknownSpent ? totals : rowsWarming(listed);
  return {
    runs: listed,
    total: matching.length,
    next: last && start + limit < keyed.length ? encodeCursor(last.k) : null,
    chipCounts: chipCounts(all, m.scope, options.localRuns ?? null),
    ...(warming ? { warming } : {}),
  };
}

/**
 * Rows of the table for these runs, with their statistics and origins. With `known` (a read beside
 * the server), the totals not worked out yet are read here only for runs that fit `ROW_CALLS_BUDGET`
 * calls in all, the newest first: a row whose run is longer says its totals are on their way
 * (`warming`), which the warm-up works out beside the server and the table asks for again. Two runs
 * of 100,000 calls a store had never added up held the sidebar 9.4 s and Runs 10.6 s, and both
 * threads with them. What a recording's user asked is read within the same budget (`aboutsWithin`).
 */
export function rows(store: Store, index: RunIndex, runs: readonly IndexedRun[], options: StatsOptions & { known?: boolean } = {}): RunRow[] {
  const { totals, later } = options.known ? callTotalsWithin(store, index, [...runs].sort((a, b) => b.startedAt - a.startedAt), { budget: ROW_CALLS_BUDGET }) : { totals: callTotals(store, index, runs), later: [] };
  const waiting = new Set(later.map((r) => r.runId));
  const abouts = options.known ? aboutsWithin(store, index, runs, { budget: ROW_CALLS_BUDGET, quick: waiting }) : aboutsOf(store, index, runs);
  return runs.map((r) => {
    const t = totals.get(r.runId);
    const s = t ? priced(t, options.prices) : null;
    const c = classifiable(r);
    return {
      ...(waiting.has(r.runId) ? { warming: true as const } : {}),
      runId: r.runId,
      parentRunId: r.parentRunId,
      depth: depthOf(index, r),
      mode: r.mode,
      status: r.status,
      label: r.label,
      divergence: r.divergence,
      command: r.argv.join(' '),
      about: abouts.get(r.runId)!,
      codeVersion: r.codeVersion,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      calls: r.calls,
      spent: s?.spent ?? 0,
      saved: s?.saved ?? 0,
      captured: s?.captured ?? 0,
      imported: !!r.meta.imported,
      covers: r.meta.covers,
      source: r.source,
      labels: r.meta.labels,
      kind: r.kind,
      attemptOf: r.attemptOf,
      attemptKind: r.attemptKind,
      rescues: r.rescues,
      outcome: r.outcome,
      failed: r.failed,
      origins: t?.codes ?? '',
      attempts: bundleOf(index, r.runId).length,
      lostAt: lostAt(c),
      checks: checksOf(c),
      author: r.meta.author,
      ci: r.meta.ci,
    };
  });
}

/** The most calls a request that lists runs reads to add up the totals of the rows it answers with (`rows`). */
export const ROW_CALLS_BUDGET = 5000;

/**
 * How far the totals of these rows are worked out, when some finished run's aren't yet: the page asks
 * again until they are. A recording's come once it ends, so it is no reason to ask again.
 */
export function rowsWarming(listed: readonly RunRow[]): { done: number; total: number } | null {
  const waiting = listed.filter((r) => r.warming && r.status !== 'running').length;
  return waiting ? { done: listed.length - waiting, total: listed.length } : null;
}

// ---- the sidebar ----

export interface RecentRunsOptions extends StatsOptions {
  /** Read beside the server: the rows' totals not worked out yet are left to the warm-up (`rows`). */
  known?: boolean;
  /** How many of the newest runs to list: 500 unless asked. */
  limit?: number;
  /** List attempts too, each under the run it came from. */
  includeAttempts?: boolean;
  /** List these runs only, attempts among them included, however old: what an exported copy holds. */
  ids?: readonly string[];
}

/**
 * The sidebar's Recent runs, served as `/api/runs`: the newest runs as a tree, each family's first
 * run with its replays and forks under it, oldest family first (the sidebar shows the newest
 * first). Attempts are bundled as on the Runs page: each run says how many it has, and a run made
 * from an attempt is listed under the run the attempt came from.
 */
export function recentRuns(store: Store, options: RecentRunsOptions = {}): RunRow[] {
  const index = loadRunIndex(store);
  const all = withLiveness(store, index);
  const limit = Math.max(1, Math.min(5000, Math.floor(options.limit ?? 500) || 500));
  const only = options.ids ? new Set(options.ids) : null;
  const listed = only ? all.filter((r) => only.has(r.runId)) : all.filter((r) => options.includeAttempts || !r.bundled).slice(0, limit);
  const ids = new Set(listed.map((r) => r.runId));
  // The listed run a run hangs under: its parent, or past an attempt left out, the run that attempt came from.
  const anchorOf = (r: IndexedRun): string | null => {
    let p = r.parentRunId;
    for (let i = 0; p && i < 1000; i++) {
      if (ids.has(p)) return p;
      const parent = index.byId.get(p);
      if (!parent?.bundled) return null;
      p = parent.parentRunId;
    }
    return null;
  };
  const under = new Map<string, IndexedRun[]>();
  const roots: IndexedRun[] = [];
  // Oldest first, so each family and each run's children come in the order they were made.
  for (const r of [...listed].reverse()) {
    const anchor = anchorOf(r);
    if (!anchor) roots.push(r);
    else {
      const list = under.get(anchor);
      if (list) list.push(r);
      else under.set(anchor, [r]);
    }
  }
  const order: Array<{ run: IndexedRun; depth: number }> = [];
  const walk = (run: IndexedRun, depth: number) => {
    order.push({ run, depth });
    if (depth < 64) for (const child of under.get(run.runId) ?? []) walk(child, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  const out = rows(store, index, order.map((x) => x.run), options);
  return out.map((row, i) => ({ ...row, depth: order[i]!.depth }));
}

// ---- the calendar ----

export interface RunsByDayOptions extends Omit<RunFilter, 'from' | 'to'> {
  /** Weeks to show, the current one included: 12 unless asked. */
  weeks?: number;
  /** The viewer's time zone (IANA). Days are theirs. */
  tz?: string;
  now?: number;
}

export interface DayCount {
  /** `YYYY-MM-DD` in the viewer's zone. */
  day: string;
  /** The instants the day starts and the next one starts: the table's `from` and `to` for a day picked. */
  start: number;
  end: number;
  /** 0 for Monday … 6 for Sunday. */
  weekday: number;
  /** Runs the chips and the filter field match. With Failed picked, the failures. */
  runs: number;
  /** Failures among the runs of the chips' kinds and the filter field, Failed or not. */
  failed: number;
  /** The runs those failures are counted out of. */
  all: number;
  /** The shade: 0 for none, then 1–4 split at the quartiles of the busy days. */
  level: 0 | 1 | 2 | 3 | 4;
  byKind: Partial<Record<RunKind, number>>;
  /** Runs per author; runs with none are counted under "". */
  byAuthor: Record<string, number>;
}

export interface RunsByDay {
  tz: string;
  weeks: number;
  today: string;
  /** The first day's start and the end of today. */
  from: number;
  to: number;
  /** Oldest first: Monday of the first week through today. */
  days: DayCount[];
  /** Where the shades split: runs per busy day at the 25th, 50th and 75th percentile, or null with no runs. */
  thresholds: [number, number, number] | null;
  totals: { runs: number; failed: number; all: number; busiest: { day: string; runs: number } | null };
  /** Set while the about lines the filter field matches aren't all known yet (`RunsPage.warming`). */
  warming?: { done: number; total: number };
}

/** Runs per day for the calendar above the table, in the viewer's days. Throws a RangeError for an unknown time zone. */
export function runsByDay(store: Store, options: RunsByDayOptions = {}): RunsByDay {
  const tz = options.tz ?? 'UTC';
  if (!isTimeZone(tz)) throw new RangeError(`unknown time zone: ${String(tz)}`);
  const weeks = Math.max(1, Math.min(53, Math.floor(options.weeks ?? 12) || 12));
  const today = localDay(options.now ?? Date.now(), tz);
  const days = daysFrom(addDays(today, -(today.weekday + (weeks - 1) * 7), tz), today, tz);
  const out: DayCount[] = days.map((d) => ({ day: d.key, start: d.start, end: d.end, weekday: d.weekday, runs: 0, failed: 0, all: 0, level: 0, byKind: {}, byAuthor: {} }));
  const index = loadRunIndex(store);
  const all = withLiveness(store, index);
  const texts = aboutTexts(store, index, all.filter(matcher(options).scope), options);
  const m = matcher(options, texts.text);
  for (const r of all) {
    const i = dayIndex(days, r.startedAt);
    if (i < 0 || !m.base(r)) continue;
    const d = out[i]!;
    d.all++;
    if (r.failed) d.failed++;
    if (!m.matches(r)) continue;
    d.runs++;
    d.byKind[r.kind] = (d.byKind[r.kind] ?? 0) + 1;
    const who = r.meta.author ?? '';
    d.byAuthor[who] = (d.byAuthor[who] ?? 0) + 1;
  }
  const busy = out.map((d) => d.runs).filter((c) => c > 0).sort((a, b) => a - b);
  const q = (f: number) => busy[Math.floor((busy.length - 1) * f)]!;
  const thresholds: RunsByDay['thresholds'] = busy.length ? [q(0.25), q(0.5), q(0.75)] : null;
  let busiest: RunsByDay['totals']['busiest'] = null;
  const totals = { runs: 0, failed: 0, all: 0 };
  for (const d of out) {
    d.level = !d.runs || !thresholds ? 0 : d.runs <= thresholds[0] ? 1 : d.runs <= thresholds[1] ? 2 : d.runs <= thresholds[2] ? 3 : 4;
    totals.runs += d.runs;
    totals.failed += d.failed;
    totals.all += d.all;
    if (d.runs && (!busiest || d.runs > busiest.runs)) busiest = { day: d.day, runs: d.runs };
  }
  return { tz, weeks, today: today.key, from: days[0]!.start, to: today.end, days: out, thresholds, totals: { ...totals, busiest }, ...(texts.pending ? { warming: { done: texts.of - texts.pending, total: texts.of } } : {}) };
}

// ---- counts and bulk actions ----

/** Runs and attempts in the store, as the status bar counts them ("N runs · M attempts"). */
export function countRuns(store: StoreOf<'readModels'>): { runs: number; attempts: number } {
  return loadRunIndex(store).counts;
}

export interface BulkSkip {
  runId: string;
  reason: string;
}

export const BULK_MAX = 1000;

/** The run ids of a bulk request: full ids, as the table hands them out. A prefix is not one. */
function idList(ids: unknown): string[] | { error: string } {
  if (!Array.isArray(ids) || !ids.length) return { error: 'ids: pick at least one run' };
  if (ids.length > BULK_MAX) return { error: `ids: at most ${BULK_MAX} runs at once` };
  if (!ids.every((id): id is string => typeof id === 'string')) return { error: 'ids: run ids are strings' };
  return [...new Set(ids)];
}

/** Which of these runs are still in the store: the Runs page lets go of a run picked once it is deleted elsewhere. */
export function knownRuns(store: StoreOf<'readModels'>, ids: unknown): { known: string[] } | { error: string } {
  const list = idList(ids);
  if ('error' in list) return list;
  const index = loadRunIndex(store);
  return { known: list.filter((id) => index.byId.has(id)) };
}

/** Adds and removes labels on several runs at once. A bad label refuses the whole request. */
export function labelRuns(store: StoreOf<'recording'>, ids: unknown, add: unknown, remove: unknown): { done: Array<{ runId: string; labels: string[] }>; skipped: BulkSkip[] } | { error: string } {
  const list = idList(ids);
  if ('error' in list) return list;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const adding: string[] = [];
  for (const raw of strings(add)) {
    const c = cleanLabel(raw);
    if ('error' in c) return { error: c.error };
    adding.push(c.label);
  }
  const removing = strings(remove).map((l) => l.trim().replace(/\s+/g, ' '));
  if (!adding.length && !removing.length) return { error: 'nothing to change: add or remove a label' };
  const done: Array<{ runId: string; labels: string[] }> = [];
  const skipped: BulkSkip[] = [];
  store.transaction(() => {
    for (const id of list) {
      const run = store.getRun(id);
      if (!run) {
        skipped.push({ runId: id, reason: 'no such run' });
        continue;
      }
      try {
        const labels = withLabels(run.meta?.labels, adding, removing);
        store.updateRunMeta(run.runId, { labels });
        done.push({ runId: run.runId, labels });
      } catch (err) {
        skipped.push({ runId: run.runId, reason: messageOf(err) });
      }
    }
  });
  return { done, skipped };
}

export interface DeleteResult {
  /** The runs deleted. */
  done: string[];
  /** The attempts deleted with them: they were bundled under a deleted run and have nowhere else to show. */
  attempts: string[];
  skipped: BulkSkip[];
  /** Recorded data nothing else used, removed afterwards. */
  blobs: number;
  bytes: number;
}

/**
 * The attempts bundled under a run, and those bundled under them in turn (a `--repeat` of one of
 * blame's probes): what the lists show only through the run, and what goes with it when it is
 * deleted, so none is left behind as a run of its own.
 */
export function bundleOf(index: RunIndex, runId: string): IndexedRun[] {
  const out: IndexedRun[] = [];
  const seen = new Set([runId]);
  for (let i = -1; i < out.length; i++) {
    for (const a of index.attempts.get(i < 0 ? runId : out[i]!.runId) ?? []) {
      if (seen.has(a.runId)) continue;
      seen.add(a.runId);
      out.push(a);
    }
  }
  return out;
}

/**
 * Deletes several runs, with the attempts bundled under each, as `shadowlap rm` does. A run still
 * in progress is left alone, as is one a run in progress reads from: an attempt of it, or a replay
 * or fork of it, would lose the answers it has yet to serve. Forks of a deleted run keep their own
 * data and lose the link to it. In progress means a process is still recording it (the store's
 * recordingRuns): a run a killed process left marked running can be deleted, as gc would.
 */
export function deleteRuns(store: StoreOf<'recording' | 'cleanup' | 'readModels'>, ids: unknown): DeleteResult | { error: string } {
  const list = idList(ids);
  if ('error' in list) return list;
  const index = loadRunIndex(store);
  const live = new Set(store.recordingRuns().live.map((r) => r.run.runId));
  const inProgress = (r: { runId: string }) => live.has(r.runId);
  // A replay serves its answers from its parent's calls as it goes: the parents of runs in progress.
  const readFrom = new Set(index.runs.filter((r) => inProgress(r) && r.parentRunId).map((r) => r.parentRunId!));
  const done: string[] = [];
  const attempts: string[] = [];
  const skipped: BulkSkip[] = [];
  const doomed = new Set<string>();
  for (const id of list) {
    const run = index.byId.get(id);
    if (!run) {
      skipped.push({ runId: id, reason: 'no such run' });
      continue;
    }
    if (doomed.has(run.runId)) continue;
    if (inProgress(run)) {
      skipped.push({ runId: run.runId, reason: run.mode === 'record' ? 'still recording' : 'still running' });
      continue;
    }
    const bundle = bundleOf(index, run.runId);
    if (bundle.some(inProgress)) {
      skipped.push({ runId: run.runId, reason: 'an attempt of it is still running' });
      continue;
    }
    if (readFrom.has(run.runId) || bundle.some((a) => readFrom.has(a.runId))) {
      skipped.push({ runId: run.runId, reason: 'a replay of it is still running' });
      continue;
    }
    doomed.add(run.runId);
    done.push(run.runId);
    for (const a of bundle) {
      if (doomed.has(a.runId)) continue;
      doomed.add(a.runId);
      attempts.push(a.runId);
    }
  }
  if (!doomed.size) return { done, attempts, skipped, blobs: 0, bytes: 0 };
  store.transaction(() => {
    for (const id of doomed) store.deleteRun(id);
  });
  const gc = store.gcBlobs();
  return { done, attempts: attempts.filter((a) => !done.includes(a)), skipped, blobs: gc.removed, bytes: gc.bytes };
}

// ---- reading a request's query string (for the routes) ----

function intParam(params: URLSearchParams, name: string): number | null | { error: string } {
  const raw = params.get(name);
  if (raw === null || raw === '') return null;
  const v = Number(raw);
  return Number.isSafeInteger(v) ? v : { error: `${name}: expected a whole number, got "${raw.slice(0, 40)}"` };
}

function filterFrom(params: URLSearchParams): RunFilter | { error: string } {
  const filter: RunFilter = {};
  const types = (params.get('types') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
  const unknown = types.find((t) => !RUN_TYPES.includes(t as RunType));
  if (unknown) return { error: `types: unknown type "${unknown.slice(0, 40)}" (${RUN_TYPES.join(', ')})` };
  if (types.length) filter.types = types as RunType[];
  const q = params.get('q');
  if (q) filter.q = q.slice(0, 200);
  const attempts = params.get('attempts');
  if (attempts === '1' || attempts === 'true') filter.includeAttempts = true;
  return filter;
}

/** Options for `listRunsPage` from a request's query string: limit, cursor, from, to, types, q, attempts, sort. */
export function runsPageOptions(params: URLSearchParams): RunsPageOptions | { error: string } {
  const filter = filterFrom(params);
  if ('error' in filter) return filter;
  const out: RunsPageOptions = { ...filter };
  for (const name of ['limit', 'from', 'to'] as const) {
    const v = intParam(params, name);
    if (v !== null && typeof v === 'object') return v;
    if (v !== null) out[name] = v;
  }
  const cursor = params.get('cursor');
  if (cursor) out.cursor = cursor.slice(0, 500);
  const sort = params.get('sort');
  if (sort) {
    if (!RUN_SORTS.includes(sort as RunSort)) return { error: `sort: expected ${RUN_SORTS.join(', ')}` };
    out.sort = sort as RunSort;
  }
  return out;
}

/** Options for `runsByDay` from a request's query string: weeks, tz, types, q, attempts. */
export function runsByDayOptions(params: URLSearchParams): RunsByDayOptions | { error: string } {
  const filter = filterFrom(params);
  if ('error' in filter) return filter;
  const out: RunsByDayOptions = { ...filter };
  const weeks = intParam(params, 'weeks');
  if (weeks !== null && typeof weeks === 'object') return weeks;
  if (weeks !== null) out.weeks = weeks;
  const tz = params.get('tz');
  if (tz) {
    if (!isTimeZone(tz)) return { error: `tz: unknown time zone "${tz.slice(0, 64)}"` };
    out.tz = tz;
  }
  return out;
}

