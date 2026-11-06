import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JOB_KINDS, type Client } from '../api.js';
import { Chips, PageHeader } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { Page } from '../components/Page.js';
import { ShowMore } from '../components/Table.js';
import { pageUp } from '../focus-manager.js';
import { compactPath, viewerTimeZone } from '../format.js';
import { useLatest, useLoad } from '../hooks.js';
import { shownRuns } from '../list-keys.js';
import { sentence } from '../normalize.js';
import { runRowScope } from '../run-row.js';
import { BulkBar, type PickedRun } from '../runspage/BulkBar.js';
import { Calendar } from '../runspage/Calendar.js';
import { pickedOf, pickedRange, rangeTimes } from '../runspage/calendar-model.js';
import { FindCommitDialog } from '../runspage/FindCommit.js';
import { ImportDialog } from '../runspage/ImportDialog.js';
import { onImportAsked, takeImportAsked } from '../runspage/import-ask.js';
import { ALL_RUNS, dayTimes, runsHref } from '../runspage/query.js';
import { navigate } from '../router.js';
import { isAllRuns, type RunsFilterRead } from '../../src/links.js';
import { useMarkRun } from '../components/RunKey.js';
import type { RunMark } from '../runkey.js';
import { RunsTable, type TableRun } from '../runspage/RunsTable.js';
import { noteShownRuns } from '../runspage/shown-runs.js';
import { warmingLine, withFirstPage } from '../runspage/rows.js';
import { bundlesAttempts, isAttempt, matchesChip, matchesText, RUN_CHIPS, sortRuns, type RunChip, type RunSort } from '../runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { keyColumn } from '../shortcuts.js';
import { useApp } from '../state.js';
import { useTeamStore } from '../teamstore.js';
import { errorText } from '../toast.js';
import type { BisectChoices, ChipCounts, RunsPage as RunsPageView, RunsPageRow, RunsQuery } from '../types.js';
import { ACTIONS } from '../labels.js';
import { ActionButton } from '../components/ActionButton.js';

/**
 * Runs: every run in a table, a page at a time from the server, with the 12-week calendar above it,
 * the type chips, a filter and sorting; attempts bundled under the run they came from. Runs picked
 * get a bulk bar. With a team store, who made each run, a `local` tag on runs not pushed yet, Pull
 * in the header and Push in the bulk bar.
 *
 * What it shows is its address's: the words the filter holds, the chip, the sort and the days picked
 * (`#/runs?q=refund&types=failed&sort=spent&from=2026-10-20&to=2026-10-22`, route.ts), so a view of
 * Runs can be shared and bookmarked, and Back and Forward go through the views it showed. A chip, a
 * sort or days picked is a step of its own in the history; the words typed take the place of the
 * step they were typed in, once they settle. `#/runs` alone, from another page, shows what Runs
 * showed last while the dashboard is open, so a run opened and closed lands back on the same view;
 * the selection survives filter changes, and lets go of a run deleted elsewhere. An exported copy
 * lists the runs it holds, worked out in the page, and reads the same address.
 */

const PAGE = 50;

/**
 * What the page holds, every kind of attempt in one word: `--repeat`'s, blame's and verify's, a
 * golden's repeats in one test session and the error-path presets' are all bundled.
 */
export const RUNS_TEXT = 'Recordings, and the replays and forks made from them. Attempts are bundled under the run they came from.';

/** What Runs showed last while the dashboard is open, and how far down it was read, and the runs picked. */
const kept = {
  filter: ALL_RUNS,
  limit: PAGE,
  picked: new Map<string, PickedRun>(),
};

/**
 * What the page shows: the address's filter, else, when Runs opens on `#/runs` alone, what it showed
 * last (and the address says so in its place). Once open, `#/runs` alone is every run: Back to it is
 * Back to them. `restore` is the filter the page opened with, until the address holds it.
 */
function useRunsFilter(filter: RunsFilterRead | undefined): RunsFilterRead {
  const restore = useRef<RunsFilterRead | null>(filter === undefined && !isAllRuns(kept.filter) ? kept.filter : null);
  // Held until the address moves: then what it says is what shows, #/runs alone every run.
  const opened = useRef(filter);
  if (opened.current !== filter) {
    opened.current = filter;
    restore.current = null;
  }
  useEffect(() => {
    if (restore.current) navigate(runsHref(restore.current), true);
  }, []);
  const f = filter ?? restore.current ?? ALL_RUNS;
  // Kept for the next time Runs opens on #/runs alone.
  kept.filter = f;
  return f;
}

/** Shows `next` in place of what Runs shows now: a step of its own in the history, or in place of this one (`replace`). */
function showRuns(next: RunsFilterRead, replace = false): void {
  kept.filter = next;
  navigate(runsHref(next), replace);
}

export function RunsPage({ filter }: { filter?: RunsFilterRead | undefined }) {
  const { exported } = useApp();
  return exported ? <ExportedRuns filter={filter} /> : <ServerRuns filter={filter} />;
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
    if (settled.trim() !== now.q.trim()) showRuns({ ...now, q: settled }, true);
  }, [settled, fNow]);
  return [text, setText, settled];
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
  warming: { done: number; total: number } | null;
  error: Error | null;
  loaded: boolean;
}

const emptyTable = (key: string): TableState => ({ key, rows: [], next: null, total: 0, chipCounts: null, warming: null, error: null, loaded: false });
const asError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)));

/**
 * The table's rows, a page at a time. When what it shows changes (`key`: its chip, filter, sort or
 * days), the rows asked for are read from the first page, those held kept in view until they come;
 * when the runs change (`refresh`), its first page alone is read again, the rows after it kept as
 * they were read (rows.ts `withFirstPage`); Show more reads the page after the last. While the server
 * says it is still working out what the filter or the sort reads (`warming`), the first page is read
 * again every second and a half.
 */
function useRunsTable(client: Client, query: RunsQuery, key: string, refresh: string, limit: number): TableState {
  const [state, setState] = useState<TableState>(() => emptyTable(key));
  const queryNow = useLatest(query);
  const limitNow = useLatest(limit);
  useEffect(() => {
    let alive = true;
    loadRows(client, queryNow.current, limitNow.current).then(
      (p) => alive && setState({ key, rows: p.runs, next: p.next, total: p.total, chipCounts: p.chipCounts, warming: p.warming ?? null, error: null, loaded: true }),
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
          const fresh = { total: first.total, chipCounts: first.chipCounts, warming: first.warming ?? null, error: null, loaded: true };
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
    if (!state.warming) return;
    const t = setTimeout(() => setNudge((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [state.warming]);
  return state;
}

const CHIP_TYPES: Readonly<Record<RunChip, readonly string[]>> = { all: [], recording: ['recording'], fork: ['fork'], clean: ['clean'], test: ['test'], capture: ['capture'], failed: ['failed'], local: ['local'] };

/** The table's rows for the filter, from the top: what makes it read them again. */
const rowsKey = (f: RunsFilterRead, q: string, times: { from: number; to: number } | null) => `${f.types}|${q}|${f.sort}|${times?.from ?? ''}|${times?.to ?? ''}`;

function pickedRun(r: TableRun): PickedRun {
  return { runId: r.runId, status: r.status, startedAt: r.startedAt, attempts: r.attempts ?? 0, ...(r.local !== undefined ? { local: r.local } : {}) };
}

/** Asked from the palette: on this page already, or arriving on it. */
function useImportAsked(open: () => void): void {
  useEffect(() => {
    takeImportAsked();
    return onImportAsked(open);
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

function ServerRuns({ filter }: { filter?: RunsFilterRead | undefined }) {
  const { client, meta, tick, feeds, actionsOff, hasKind, guard, watchJob, toast, refresh, runs: appRuns } = useApp();
  const store = useTeamStore();
  const tz = useMemo(viewerTimeZone, []);
  const f = useRunsFilter(filter);
  const chip = f.types;
  const sort = f.sort;
  const days = f.days;
  const [query, setQuery, q] = useFilterField(f, 250);
  const [limit, setLimitState] = useState(kept.limit);
  const [picked, setPickedState] = useState(() => new Map(kept.picked));
  const [dialog, setDialog] = useState<null | 'import' | { runId: string; choices: BisectChoices; earlier: { runId: string; why: string } | null }>(() => (takeImportAsked() ? 'import' : null));
  const now = Date.now();
  useImportAsked(useCallback(() => setDialog('import'), []));

  const setLimit = (n: number) => {
    kept.limit = n;
    setLimitState(n);
  };
  // What the table shows changed (a chip, the words, the sort, the days, or Back to another view): from its top again.
  const shownKey = runsHref({ ...f, q });
  const shownWas = useRef(shownKey);
  useEffect(() => {
    if (shownWas.current === shownKey) return;
    shownWas.current = shownKey;
    setLimit(PAGE);
  }, [shownKey]);
  // A chip or a sort is a step of its own, as are the days picked, with the words as typed so far.
  const setChip = (c: RunChip) => showRuns({ ...f, q: query, types: c });
  const setSort = (s: RunSort) => showRuns({ ...f, q: query, sort: s });
  const setPicked = useCallback((m: Map<string, PickedRun>) => {
    kept.picked = m;
    setPickedState(m);
  }, []);

  const types = CHIP_TYPES[chip];
  const cal = useLoad(() => client.runsByDay({ tz, weeks: 12, types, q }), 'runs-days', `${tick}|${chip}|${q}`);
  const calDays = cal.data?.days ?? null;
  const range = calDays ? pickedRange(calDays, days) : null;
  // The instants the days picked span: the calendar's own once it is in, else worked out here, so the
  // table asks for them from a link before the calendar has come.
  const times = (calDays && range ? rangeTimes(calDays, range) : null) ?? (days ? dayTimes(days) : null);

  const fNow = useLatest(f);
  const queryNow = useLatest(query);
  const pickDays = useCallback((r: [number, number] | null) => showRuns({ ...fNow.current, q: queryNow.current, days: calDays ? pickedOf(calDays, r) : null }), [calDays, fNow, queryNow]);

  // Its first page read again when runs change, and when a push or a pull changes what is only here (the local tags).
  const tableQuery: RunsQuery = { types, q, sort, from: times?.from ?? null, to: times?.to ?? null };
  const table = useRunsTable(client, tableQuery, rowsKey(f, q, times), `${tick}:${feeds.team ?? 0}`, limit);
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
  const warming = warmingLine(table.warming, { filtered: !!q.trim(), bySpent: sort === 'spent' });

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
        eyebrow={p ? compactPath(p.path) : 'runs'}
        title="Runs"
        text={RUNS_TEXT}
        actions={
          <>
            {store && hasKind(JOB_KINDS.pull) ? (
              <ActionButton className="btn" title={`Bring the team’s runs from ${store.name}`} onClick={() => guard(() => watchJob(client.startJob(JOB_KINDS.pull, {})))}>
                Pull
              </ActionButton>
            ) : null}
            {hasKind(JOB_KINDS.importCapture) ? (
              <ActionButton className="btn" onClick={() => guard(() => setDialog('import'))}>
                <Icon name="import" />
                {ACTIONS.importCapture.label}
              </ActionButton>
            ) : null}
          </>
        }
      />
      {cal.data ? <Calendar data={cal.data} chip={chip} range={range} onPick={pickDays} byPerson={!!store} onFindCommit={hasKind(JOB_KINDS.bisect) ? findCommit : null} /> : null}
      <div className="tbar">
        <Chips label="Kind of run" items={RUN_CHIPS.filter(([key]) => key !== 'local' || store || chip === 'local').map(([key, label]) => ({ key, label, ...(counts ? { count: counts[key] } : {}) }))} value={chip} onChange={setChip} />
        <label className="tin">
          <span className="sr">Filter runs</span>
          <input id="runsQuery" type="search" placeholder="Filter by id, about or label" title="Every word must be in a run’s id, about line, labels, command or revision; label:good lists the runs labelled good" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      {warming ? (
        <p className="muted" role="status">
          {warming}
        </p>
      ) : null}
      <section className="panel tscroll">
        <RunsTable rows={rows} picked={picked} selectable byColumn={!!store} you={store?.you ?? null} sort={sort} onSort={setSort} onPick={onPick} onPickAll={onPickAll} now={now} onMark={onMark} markOff={actionsOff ?? null} rowActions={(r) => runRowScope(r, { runs: appRuns ?? [], toast, pick: () => onPick(r, !picked.has(r.runId)), picked: picked.has(r.runId), pickKey: keyColumn('rowPick') })} />
        {table.error && !rows.length ? (
          <div className="empty">The runs could not be read: {table.error.message}</div>
        ) : !table.loaded ? (
          <div className="empty">Loading runs…</div>
        ) : rows.length === 0 ? (
          <div className="empty">{counts?.all ? 'No runs match.' : days ? 'No runs on the days picked.' : 'No runs yet. Record one with shadowlap run -- <command>.'}</div>
        ) : null}
        <ShowMore shown={rows.length} total={table.total} onMore={() => setLimit(limit + PAGE)} />
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
  const setChip = (c: RunChip) => showRuns({ ...f, q: query, types: c });
  const setSort = (s: RunSort) => showRuns({ ...f, q: query, sort: s });
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
        text={bundlesAttempts(runs ?? []) ? RUNS_TEXT : 'Recordings, and the replays and forks made from them.'}
      />
      <div className="tbar">
        <Chips label="Kind of run" items={RUN_CHIPS.map(([key, label]) => ({ key, label, count: counts[key] }))} value={chip} onChange={setChip} hideEmpty />
        <label className="tin">
          <span className="sr">Filter runs</span>
          <input id="runsQuery" type="search" placeholder="Filter by id, about or label" title="Every word must be in a run’s id, about line, labels, command or revision; label:good lists the runs labelled good" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <section className="panel tscroll">
        <RunsTable rows={shown} picked={new Set()} selectable={false} byColumn={false} sort={sort} onSort={setSort} onPick={() => undefined} onPickAll={() => undefined} now={Date.now()} />
        {runs === null ? <div className="empty">Loading runs…</div> : shown.length === 0 ? <div className="empty">No runs match.</div> : null}
        <ShowMore shown={shown.length} total={matched.length} onMore={() => setLimit(limit + PAGE)} />
      </section>
    </Page>
  );
}
