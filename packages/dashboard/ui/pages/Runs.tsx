import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JOB_KINDS, type Client } from '../api.js';
import { Chips, PageHeader } from '../components/bits.js';
import { Page } from '../components/Page.js';
import { EmptyLine, EmptyState } from '../components/States.js';
import { ShowMore } from '../components/Table.js';
import { pageUp } from '../focus-manager.js';
import { viewerTimeZone } from '../format.js';
import { useLatest, useLoad, type Loaded } from '../hooks.js';
import { shownRuns } from '../list-keys.js';
import { sentence } from '../normalize.js';
import { IMPORT_ASK } from '../page-ask.js';
import { runRowScope } from '../run-row.js';
import { BulkBar, type PickedRun } from '../runspage/BulkBar.js';
import { TwelveWeeks } from '../runspage/DaysRow.js';
import { pickedOf, pickedRange, rangeTimes } from '../runspage/calendar-model.js';
import { RunsActions } from '../runspage/RunsActions.js';
import { RunsFilterField } from '../runspage/FilterField.js';
import { FindCommitDialog } from '../runspage/FindCommit.js';
import { ImportDialog } from '../runspage/ImportDialog.js';
import { ALL_RUNS, dayTimes, runsHref } from '../runspage/query.js';
import { commitRuns, replaceRuns, useRunsAddress } from '../runspage/history.js';
import { useKeptScroll } from '../runspage/scroll.js';
import type { RunsFilterRead } from '../../src/links.js';
import { useMarkRun } from '../components/RunKey.js';
import type { RunMark } from '../runkey.js';
import { RunsLoading, RunsTable, RunsTableEmpty, type TableRun } from '../runspage/RunsTable.js';
import { noteShownRuns } from '../runspage/shown-runs.js';
import { goneFromCounts, lessChips, shownWarming, tableNote, withFirstPage } from '../runspage/rows.js';
import { useServedParts, type FailedIssuesProps } from '../served-parts.js';
import { lessPending, usePendingHidden, useStillCounted, withoutPending } from '../pending-delete.js';
import { bundlesAttempts, isAttempt, matchesChip, matchesText, RUN_CHIPS, sortRuns, type RunChip, type RunSort } from '../runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { keyColumn } from '../shortcuts.js';
import { useApp } from '../state.js';
import { useTeamStoreState } from '../teamstore.js';
import { SetUpStep, useNoRunsYet } from './set-up-step.js';
import { errorText } from '../toast.js';
import type { BisectChoices, ChipCounts, RunsByDay, RunsPage as RunsPageView, RunsPageRow, RunsQuery, TeamStoreView } from '../types.js';

/**
 * Runs: every run in a table, a page at a time from the server, with the 12-week calendar above it,
 * the type chips, a filter and sorting; attempts bundled under the run they came from. Runs picked
 * get a bulk bar. With a team store, who made each run, a `local` tag on runs not pushed yet, Pull
 * in the header and Push in the bulk bar.
 *
 * What it shows is its address's: the words the filter holds, the chip, the sort and the days picked
 * (`#/runs?q=refund+label:good&types=failed&sort=spent&from=2026-10-20&to=2026-10-22`, route.ts), so
 * a view of Runs can be shared and bookmarked, and Back and Forward go through the views it showed.
 * A chip, a sort, days picked or Enter in the filter is a step of its own in the history; the words
 * typed take the place of the step they were typed in, once they settle (runspage/history.ts). Each
 * view is given back where its list was left (runspage/scroll.ts). `#/runs` alone is every run; the
 * nav's Runs opens the view Runs showed last while the dashboard is open (runs-view.ts), so a run
 * opened and closed lands back on the same view. The selection survives filter changes, and lets go
 * of a run deleted elsewhere. An exported copy lists the runs it holds, worked out in the page, and
 * reads the same address.
 */

const PAGE = 50;

/**
 * What the page holds, every kind of attempt in one word: `--repeat`'s, blame's and verify's, a
 * golden's repeats in one test session and the error-path presets' are all bundled.
 */
export const RUNS_TEXT = 'Recordings, and the replays and forks made from them. Attempts are bundled under the run they came from.';

/** While the dashboard is open: how far down a view of Runs was read (`at`), and the runs picked. */
const kept = {
  limit: PAGE,
  at: '',
  picked: new Map<string, PickedRun>(),
};

/** What the page shows: the address's filter, `#/runs` alone every run; the address in the one form the page writes. */
function useRunsFilter(filter: RunsFilterRead | undefined): RunsFilterRead {
  const f = filter ?? ALL_RUNS;
  useRunsAddress(f);
  return f;
}

export function RunsPage({ filter }: { filter?: RunsFilterRead | undefined }) {
  const { exported } = useApp();
  const none = useNoRunsYet();
  return exported ? <ExportedRuns filter={filter} /> : none ? <NoRuns /> : <ServerRuns filter={filter} />;
}

/** Runs' line where there are no attempts to bundle: an exported copy that holds none, a project with no runs yet. */
const RUNS_LINE = 'Recordings, and the replays and forks made from them.';

/**
 * Runs in a project with no runs yet: its header, with Import capture… alone (a team store's Pull
 * and Push wait for the list, as the setup is the way to a first run), then what the page will hold,
 * with Set up <project> and the command quiet under it. No calendar, chips or filter: nothing to
 * pick from. The first run recorded turns it into the list.
 */
function NoRuns() {
  const { meta } = useApp();
  const { store, known } = useTeamStoreState();
  const [importing, setImporting] = useState(() => IMPORT_ASK.take());
  useImportAsked(useCallback(() => setImporting(true), []));
  return (
    <Page>
      <PageHeader eyebrow={runsEyebrow(projectOf(meta), store, known)} title="Runs" text={RUNS_LINE} actions={<RunsActions store={null} onImport={() => setImporting(true)} />} />
      <EmptyState title="No runs yet" text="Every recording shows here with its replays and forks: record the agent once, or import a capture another tool made." copy step={<SetUpStep />} command="shadowlap run -- <command>" />
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
    </Page>
  );
}

/**
 * The words in the filter field: what is typed, and once it settles (`ms`), the address's, which
 * takes the place of the step it was typed in; the address's words when they change from outside
 * (Back, a link), without a space typed at the end taken away.
 */
function useFilterField(f: RunsFilterRead, ms: number): [string, (v: string) => void, string] {
  const [text, setText] = useState(f.q);
  const settled = useSettled(text, ms);
  const fNow = useLatest(f);
  // The address's words moved on their own: the field follows.
  useEffect(() => {
    setText((t) => (t.trim() === f.q.trim() ? t : f.q));
  }, [f.q]);
  useEffect(() => {
    const now = fNow.current;
    if (settled.trim() !== now.q.trim()) replaceRuns({ ...now, q: settled });
  }, [settled, fNow]);
  return [text, setText, settled];
}

/**
 * How far down the table reads: as far as it was read when this view was last shown while the
 * dashboard is open, so a run opened and closed lands back on the rows it was among; from its top
 * again when the view changes.
 */
function useReadTo(shown: string): [number, (n: number) => void] {
  const [limit, setLimitState] = useState(() => (kept.at === shown ? kept.limit : PAGE));
  const setLimit = useCallback((n: number) => {
    kept.limit = n;
    setLimitState(n);
  }, []);
  const shownWas = useRef(shown);
  useEffect(() => {
    kept.at = shown;
    if (shownWas.current === shown) return;
    shownWas.current = shown;
    setLimit(PAGE);
  }, [shown, setLimit]);
  return [limit, setLimit];
}

/** The text a field holds once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Rows of the table up to `limit`, a page of at most 500 at a time. */
async function loadRows(client: Client, q: RunsQuery, limit: number): Promise<RunsPageView & { runs: RunsPageRow[] }> {
  const first = await client.runsPage({ ...q, limit: Math.min(limit, 500) });
  let runs = first.runs;
  let next = first.next;
  while (next && runs.length < limit) {
    const more = await client.runsPage({ ...q, cursor: next, limit: Math.min(limit - runs.length, 500) });
    runs = runs.concat(more.runs);
    next = more.next;
  }
  return { ...first, runs, next };
}

interface TableState {
  /** What the rows were read for: the chip, the filter, the sort and the days. Until the rows for another are read, those held stay. */
  key: string;
  rows: TableRun[];
  next: string | null;
  total: number;
  chipCounts: ChipCounts | null;
  warming: NonNullable<RunsPageView['warming']> | null;
  /** While the search index is behind for the filter's words: how many runs it has yet to read. */
  indexing: NonNullable<RunsPageView['indexing']> | null;
  error: Error | null;
  loaded: boolean;
}

const emptyTable = (key: string): TableState => ({ key, rows: [], next: null, total: 0, chipCounts: null, warming: null, indexing: null, error: null, loaded: false });
const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

/**
 * The table's rows, a page at a time. When what it shows changes (`key`: its chip, filter, sort or
 * days), the rows asked for are read from the first page, those held kept in view until they come;
 * when the runs change (`refresh`), its first page alone is read again, the rows after it kept as
 * they were read (rows.ts `withFirstPage`); Show more reads the page after the last. While the server
 * says it is still working out what the filter or the sort reads (`warming`), the first page is read
 * again every second and a half.
 */
function useRunsTable(client: Client, query: RunsQuery, key: string, refresh: string, limit: number): TableState & { retry: () => void } {
  const [state, setState] = useState<TableState>(() => emptyTable(key));
  const queryNow = useLatest(query);
  const limitNow = useLatest(limit);
  useEffect(() => {
    let alive = true;
    loadRows(client, queryNow.current, limitNow.current).then(
      (p) => alive && setState({ key, rows: p.runs, next: p.next, total: p.total, chipCounts: p.chipCounts, warming: p.warming ?? null, indexing: p.indexing ?? null, error: null, loaded: true }),
      (err: unknown) => alive && setState((s) => ({ ...s, error: asError(err), loaded: true })),
    );
    return () => {
      alive = false;
    };
  }, [client, key, queryNow, limitNow]);

  const [nudge, setNudge] = useState(0);
  const refreshed = useRef(`${refresh}|${nudge}`);
  useEffect(() => {
    const now = `${refresh}|${nudge}`;
    if (refreshed.current === now) return;
    refreshed.current = now;
    let alive = true;
    client.runsPage({ ...queryNow.current, limit: PAGE }).then(
      (first) =>
        alive &&
        setState((s) => {
          const fresh = { total: first.total, chipCounts: first.chipCounts, warming: first.warming ?? null, indexing: first.indexing ?? null, error: null, loaded: true };
          // The rows held are another's (their own read failed, or is still on its way): the first page stands for them.
          if (s.key !== key) return { ...s, ...fresh, key, rows: first.runs, next: first.next };
          const merged = withFirstPage(s.rows, first.runs);
          return { ...s, ...fresh, rows: merged.rows, next: merged.kept ? s.next : first.next };
        }),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client, key, refresh, nudge, queryNow]);

  useEffect(() => {
    if (!state.loaded || state.key !== key || state.rows.length >= limit || !state.next) return;
    let alive = true;
    const cursor = state.next;
    client.runsPage({ ...queryNow.current, cursor, limit: Math.min(limit - state.rows.length, 500) }).then(
      (more) =>
        alive &&
        setState((s) => {
          if (s.key !== key || s.next !== cursor) return s;
          const have = new Set(s.rows.map((r) => r.runId));
          return { ...s, rows: [...s.rows, ...more.runs.filter((r) => !have.has(r.runId))], next: more.next, total: more.total, chipCounts: more.chipCounts };
        }),
      (err: unknown) => alive && setState((s) => (s.key === key ? { ...s, error: asError(err) } : s)),
    );
    return () => {
      alive = false;
    };
  }, [client, key, limit, state.loaded, state.key, state.next, state.rows.length, queryNow]);

  useEffect(() => {
    if (!state.warming && !state.indexing) return;
    const t = setTimeout(() => setNudge((n) => n + 1), ASK_AGAIN_MS);
    return () => clearTimeout(t);
  }, [state.warming, state.indexing]);
  // Retry, where the first page could not be read: it is read again as a change of runs reads it.
  const retry = useCallback(() => setNudge((n) => n + 1), []);
  return useMemo(() => ({ ...state, retry }), [state, retry]);
}

/** While the server is still working out what the filter reads, or the search index is behind: how often what is shown is asked for again. */
const ASK_AGAIN_MS = 1500;

/**
 * The runs per day for the twelve weeks, read for the same filter as the table, and asked for again
 * while what that filter reads is still being worked out, as the table is (`useRunsTable`): the two
 * count the same runs once both are.
 */
function useRunsDays(client: Client, q: { tz: string; types: readonly string[]; q: string }, refresh: string): Loaded<RunsByDay> {
  const load = useLoad(() => client.runsByDay({ ...q, weeks: 12 }), 'runs-days', refresh);
  const behind = load.data?.warming ?? load.data?.indexing ?? null;
  const { reload } = load;
  useEffect(() => {
    if (!behind) return;
    const t = setTimeout(reload, ASK_AGAIN_MS);
    return () => clearTimeout(t);
  }, [behind, reload]);
  return load;
}

const CHIP_TYPES: Readonly<Record<RunChip, readonly string[]>> = { all: [], recording: ['recording'], fork: ['fork'], clean: ['clean'], test: ['test'], capture: ['capture'], failed: ['failed'], local: ['local'] };

/**
 * The twelve weeks for the table's filter, the days picked kept to them, and the instants the table
 * filters by: the calendar's own once it is in, else worked out from the address, so the table asks
 * for them from a link before the calendar has come. Once it has, days in the address running past
 * the twelve weeks are written back as the days inside, in place of the step, and days wholly
 * outside them are let go (`pickedRange`). Picking days is a step of its own, with the words as
 * typed so far.
 */
function useWeeks(client: Client, o: { f: RunsFilterRead; query: string; q: string; tz: string }, tick: number) {
  const { f, q } = o;
  const types = CHIP_TYPES[f.types];
  const cal = useRunsDays(client, { tz: o.tz, types, q }, `${tick}|${f.types}|${q}`);
  const calDays = cal.data?.days ?? null;
  const range = calDays ? pickedRange(calDays, f.days) : null;
  const times = calDays ? rangeTimes(calDays, range) : f.days ? dayTimes(f.days) : null;
  const fNow = useLatest(f);
  const queryNow = useLatest(o.query);
  const pickDays = useCallback((r: [number, number] | null) => commitRuns({ ...fNow.current, q: queryNow.current, days: calDays ? pickedOf(calDays, r) : null }), [calDays, fNow, queryNow]);
  const inside = calDays ? pickedOf(calDays, range) : undefined;
  const insideNow = useLatest(inside);
  const past = inside !== undefined && (inside?.from !== f.days?.from || inside?.to !== f.days?.to);
  useEffect(() => {
    if (past) replaceRuns({ ...fNow.current, q: queryNow.current, days: insideNow.current ?? null });
  }, [past, fNow, queryNow, insideNow]);
  return { cal, calDays, range, times, pickDays, types };
}

/** The table's rows for the filter, from the top: what makes it read them again. */
const rowsKey = (f: RunsFilterRead, q: string, times: { from: number; to: number } | null) => `${f.types}|${q}|${f.sort}|${times?.from ?? ''}|${times?.to ?? ''}`;

function pickedRun(r: TableRun): PickedRun {
  const chips = RUN_CHIPS.flatMap(([k]) => (k !== 'all' && (k === 'local' ? r.local === true : matchesChip(r, k)) ? [k] : []));
  return { runId: r.runId, status: r.status, startedAt: r.startedAt, attempts: r.attempts ?? 0, chips, ...(r.local !== undefined ? { local: r.local } : {}) };
}

/**
 * The table as it shows while a delete waits out its toast (`pending-delete.ts`): without the runs it
 * takes, its total and its chips' counts less them (`goneFromCounts`) until the table is read again
 * after the delete lands. The days above aren't adjusted: they catch up once the delete lands.
 */
function useShownTable<T extends TableState>(table: T, o: { chip: RunChip; q: string; times: { from: number; to: number } | null }): T {
  const hidden = usePendingHidden();
  const counted = useStillCounted(table.chipCounts);
  const { chip, q } = o;
  const from = o.times?.from ?? -Infinity;
  const to = o.times?.to ?? Infinity;
  return useMemo(() => {
    if (!hidden.size) return table;
    const gone = goneFromCounts(counted, { held: new Set(table.rows.map((r) => r.runId)), chip, q, from, to });
    return { ...table, rows: withoutPending(table.rows, hidden), total: lessPending(table.total, gone.total) ?? 0, chipCounts: lessChips(table.chipCounts, gone.chips) };
  }, [table, hidden, counted, chip, q, from, to]);
}

/** Asked from the palette: on this page already, or arriving on it. */
function useImportAsked(open: () => void): void {
  useEffect(() => {
    IMPORT_ASK.take();
    return IMPORT_ASK.on(open);
  }, [open]);
}

/**
 * What the keys read from the table. Esc clears a selection before it lets go of a row. `[` and `]`
 * on a run step through the rows as Runs last showed them, and past the last through the pages still
 * to read, which Runs then reads as far as, so Esc finds its row.
 */
function useRunsKeyNotes(o: { client: Client; query: RunsQuery; rows: readonly TableRun[]; next: string | null; picked: number; clear: () => void }): void {
  const now = useLatest(o);
  useEffect(() => {
    pageUp.current = () => {
      if (!now.current.picked) return false;
      now.current.clear();
      return true;
    };
    return () => {
      pageUp.current = null;
    };
  }, [now]);
  const { rows, next } = o;
  useEffect(() => {
    const read = async (cursor: string) => {
      const page = await now.current.client.runsPage({ ...now.current.query, cursor, limit: PAGE });
      return { ids: page.runs.map((r) => r.runId), next: page.next };
    };
    noteShownRuns(rows.map((r) => r.runId), next, read, (n) => void (kept.limit = n));
  }, [rows, next, now]);
}

/** The page's eyebrow: the project, and which store its runs are kept in once that is known (a team's never reads `local store` first); `runs` without a project. */
function runsEyebrow(p: { name: string } | null, store: TeamStoreView | null, known: boolean): string {
  if (!p) return 'runs';
  return known ? `${p.name} · ${store ? 'team store' : 'local store'}` : p.name;
}

/** Failed's issues, which only the served dashboard hands in (served-parts.ts): nothing where none was handed in. */
function FailedIssuesPart(props: FailedIssuesProps) {
  const { FailedIssues } = useServedParts();
  return FailedIssues ? <FailedIssues {...props} /> : null;
}

function ServerRuns({ filter }: { filter?: RunsFilterRead | undefined }) {
  const { client, meta, tick, feeds, actionsOff, hasKind, guard, toast, refresh, runs: appRuns } = useApp();
  const { store, known: storeKnown } = useTeamStoreState();
  const tz = useMemo(viewerTimeZone, []);
  const f = useRunsFilter(filter);
  const chip = f.types;
  // Under Failed the issues go by their newest run, and the list behind them by when: the sort waits in the address.
  const sort: RunSort = chip === 'failed' ? 'when' : f.sort;
  const days = f.days;
  const [query, setQuery, q] = useFilterField(f, 250);
  // What the table shows (a chip, the words, the sort, the days, or Back to another view).
  const shownKey = runsHref({ ...f, q });
  const [limit, setLimit] = useReadTo(shownKey);
  const [picked, setPickedState] = useState(() => new Map(kept.picked));
  const [dialog, setDialog] = useState<null | 'import' | { runId: string; choices: BisectChoices; earlier: { runId: string; why: string } | null }>(() => (IMPORT_ASK.take() ? 'import' : null));
  const now = Date.now();
  useImportAsked(useCallback(() => setDialog('import'), []));

  // A chip or a sort is a step of its own, as are the days picked and Enter, with the words as typed so far.
  const setChip = (c: RunChip) => commitRuns({ ...f, q: query, types: c });
  const setSort = (s: RunSort) => commitRuns({ ...f, q: query, sort: s });
  const setPicked = useCallback((m: Map<string, PickedRun>) => {
    kept.picked = m;
    setPickedState(m);
  }, []);

  const { cal, calDays, range, times, pickDays, types } = useWeeks(client, { f, query, q, tz }, tick);

  // Its first page read again when runs change, and when a push or a pull changes what is only here (the local tags).
  const tableQuery: RunsQuery = { types, q, sort, from: times?.from ?? null, to: times?.to ?? null };
  const key = rowsKey(f, q, times);
  const table = useShownTable(useRunsTable(client, tableQuery, key, `${tick}:${feeds.team ?? 0}`, limit), { chip, q, times });
  // Given back once the twelve weeks above the rows are in too: their sentence can take a second line,
  // and a place given back before it would leave the list that much higher than it was.
  useKeptScroll(shownKey, chip !== 'failed' && table.loaded && table.key === key && !cal.loading);
  // The good/bad key: a row shows the labels a press gave it until the table's own say otherwise.
  const [marks, setMarks] = useState<ReadonlyMap<string, { base: string; labels: string[] }>>(() => new Map());
  const byId = useLatest(new Map(table.rows.map((r) => [r.runId, r])));
  const markRun = useMarkRun(useCallback((runId: string, labels: string[]) => setMarks((m) => new Map(m).set(runId, { base: JSON.stringify(byId.current.get(runId)?.labels ?? []), labels })), [byId]));
  const rows: TableRun[] = useMemo(
    () =>
      marks.size
        ? table.rows.map((r) => {
            const o = marks.get(r.runId);
            return o && o.base === JSON.stringify(r.labels) ? { ...r, labels: o.labels } : r;
          })
        : table.rows,
    [table.rows, marks],
  );
  const rowsNow = useLatest(new Map(rows.map((r) => [r.runId, r])));
  const onMark = useCallback((r: TableRun, m: RunMark, from?: HTMLElement) => markRun(r.runId, rowsNow.current.get(r.runId)?.labels ?? r.labels, m, from), [markRun, rowsNow]);
  useRunsKeyNotes({ client, query: tableQuery, rows, next: table.next, picked: picked.size, clear: () => setPicked(new Map()) });
  const counts: ChipCounts | null = table.loaded ? table.chipCounts : null;
  const warming = tableNote({ ...table, warming: shownWarming(table.warming, { chip, q }) }, { filtered: !!q.trim(), bySpent: sort === 'spent' });

  // What the bar knows of a run picked follows the table: a recording that ends can then be deleted,
  // and a delete names the attempts a blame added meanwhile.
  useEffect(() => {
    if (!picked.size || !table.loaded) return;
    let changed = false;
    const next = new Map(picked);
    for (const r of table.rows) {
      const was = next.get(r.runId);
      if (!was) continue;
      const now = pickedRun(r);
      if (was.status !== now.status || was.local !== now.local || was.attempts !== now.attempts) {
        next.set(r.runId, now);
        changed = true;
      }
    }
    if (changed) setPicked(next);
  }, [table.loaded, table.rows, picked, setPicked]);

  // A run picked, then deleted elsewhere (its own page, shadowlap rm), leaves the selection when
  // the runs change: the bar counts and acts on runs that are there.
  useEffect(() => {
    const ids = [...kept.picked.keys()];
    if (!ids.length) return;
    let alive = true;
    const asks: Array<Promise<string[]>> = [];
    for (let i = 0; i < ids.length; i += 1000) asks.push(client.knownRuns(ids.slice(i, i + 1000)));
    Promise.all(asks).then(
      (lists) => {
        const known = new Set(lists.flat());
        const gone = new Set(ids.filter((id) => !known.has(id)));
        // Only runs asked about and found gone: one picked meanwhile stays.
        if (alive && gone.size) setPicked(new Map([...kept.picked].filter(([id]) => !gone.has(id))));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [client, tick, setPicked]);

  const onPick = useCallback(
    (r: TableRun, on: boolean) => {
      const next = new Map(kept.picked);
      if (on) next.set(r.runId, pickedRun(r));
      else next.delete(r.runId);
      setPicked(next);
    },
    [setPicked],
  );
  const onPickAll = (on: boolean) => {
    const next = new Map(picked);
    for (const r of rows) {
      if (on) next.set(r.runId, pickedRun(r));
      else next.delete(r.runId);
    }
    setPicked(next);
  };

  const findCommit = (r: [number, number]) => {
    const t = calDays ? rangeTimes(calDays, r) : null;
    if (!t) return;
    guard(() =>
      void client.daysBisect({ ...t, types, q }).then(
        (out) => ('reason' in out ? toast(sentence(out.reason)) : setDialog({ runId: out.runId, choices: out.choices, earlier: out.earlier ?? null })),
        (err: unknown) => toast(errorText(err), 'error'),
      ),
    );
  };

  const p = projectOf(meta);
  const runs = [...picked.values()];
  return (
    <Page>
      <PageHeader
        eyebrow={runsEyebrow(p, store, storeKnown)}
        title="Runs"
        text={RUNS_TEXT}
        actions={<RunsActions store={store} onImport={() => setDialog('import')} />}
      />
      <TwelveWeeks load={cal} chip={chip} range={range} onPick={pickDays} byPerson={!!store} onFindCommit={hasKind(JOB_KINDS.bisect) ? findCommit : null} />
      <div className="tbar">
        <Chips label="Kind of run" items={RUN_CHIPS.filter(([key]) => key !== 'local' || store || chip === 'local').map(([key, label]) => ({ key, label, ...(counts ? { count: counts[key] } : {}) }))} value={chip} onChange={setChip} />
        <RunsFilterField value={query} onChange={setQuery} onCommit={() => commitRuns({ ...f, q: query })} settled={q} total={table.total} loaded={table.loaded} />
      </div>
      {warming ? (
        <p className="muted" role="status">
          {warming}
        </p>
      ) : null}
      <section className="panel sec tscroll runsec">
        {chip === 'failed' ? (
          <FailedIssuesPart query={{ q, from: times?.from ?? null, to: times?.to ?? null }} refresh={`${tick}:${feeds.team ?? 0}`} scrollKey={shownKey} above={table.loaded && !cal.loading} />
        ) : (
          <>
            <RunsTable rows={rows} picked={picked} selectable byColumn={!!store} you={store?.you ?? null} sort={sort} onSort={setSort} onPick={onPick} onPickAll={onPickAll} now={now} onMark={onMark} markOff={actionsOff ?? null} rowActions={(r) => runRowScope(r, { runs: appRuns ?? [], toast, pick: () => onPick(r, !picked.has(r.runId)), picked: picked.has(r.runId), pickKey: keyColumn('rowPick') })} />
            <RunsTableEmpty error={table.error} loaded={table.loaded} shown={rows.length} counts={counts} days={days} retry={table.retry} />
            <ShowMore shown={rows.length} total={table.total} onMore={() => setLimit(limit + PAGE)} />
          </>
        )}
      </section>
      {runs.length ? (
        <>
          <BulkBar runs={runs} store={!!store} clear={() => setPicked(new Map())} onDone={refresh} />
          <div className="bulkspace" />
        </>
      ) : null}
      {dialog === 'import' ? <ImportDialog onClose={() => setDialog(null)} /> : null}
      {dialog && dialog !== 'import' ? <FindCommitDialog runId={dialog.runId} choices={dialog.choices} earlier={dialog.earlier} onClose={() => setDialog(null)} /> : null}
    </Page>
  );
}

/** An exported copy: the runs it holds, filtered and sorted in the page; nothing to pick. */
function ExportedRuns({ filter }: { filter?: RunsFilterRead | undefined }) {
  const { runs } = useApp();
  const f = useRunsFilter(filter);
  const chip = f.types;
  const sort = f.sort;
  const [query, setQuery] = useFilterField(f, 150);
  const setChip = (c: RunChip) => commitRuns({ ...f, q: query, types: c });
  const setSort = (s: RunSort) => commitRuns({ ...f, q: query, sort: s });
  useKeptScroll(runsHref(f), runs !== null);
  const [limit, setLimit] = useState(PAGE);
  const listed = useMemo(() => (runs ?? []).filter((r) => !isAttempt(r)), [runs]);
  const counts = useMemo(() => Object.fromEntries(RUN_CHIPS.map(([k]) => [k, listed.filter((r) => matchesChip(r, k)).length])) as Record<RunChip, number>, [listed]);
  const matched = useMemo(() => sortRuns(listed.filter((r) => matchesChip(r, chip) && matchesText(r, query)), sort), [listed, chip, query, sort]);
  const shown = matched.slice(0, limit);
  useEffect(() => {
    shownRuns.current = { ids: matched.map((r) => r.runId), more: null };
  }, [matched]);
  return (
    <Page>
      <PageHeader
        eyebrow="exported copy"
        title="Runs"
        text={bundlesAttempts(runs ?? []) ? RUNS_TEXT : RUNS_LINE}
      />
      <div className="tbar">
        <Chips label="Kind of run" items={RUN_CHIPS.map(([key, label]) => ({ key, label, count: counts[key] }))} value={chip} onChange={setChip} hideEmpty />
        <RunsFilterField value={query} onChange={setQuery} onCommit={() => commitRuns({ ...f, q: query })} settled={query} total={matched.length} loaded={runs !== null} copy />
      </div>
      <section className="panel sec tscroll runsec">
        <RunsTable rows={shown} picked={new Set()} selectable={false} byColumn={false} sort={sort} onSort={setSort} onPick={() => undefined} onPickAll={() => undefined} now={Date.now()} />
        {runs === null ? <RunsLoading /> : shown.length === 0 ? <EmptyLine>No runs match.</EmptyLine> : null}
        <ShowMore shown={shown.length} total={matched.length} onMore={() => setLimit(limit + PAGE)} />
      </section>
    </Page>
  );
}
