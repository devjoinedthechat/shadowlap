import { useCallback, useEffect, useMemo, useState } from 'react';
import { JOB_KINDS, type Client } from '../api.js';
import { Chips, PageHeader } from '../components/bits.js';
import { Icon } from '../components/Icon.js';
import { Page } from '../components/Page.js';
import { ShowMore } from '../components/Table.js';
import { compactPath } from '../format.js';
import { useLoad } from '../hooks.js';
import { sentence } from '../normalize.js';
import { addPaletteSource } from '../palette-sources.js';
import { href } from '../route.js';
import { BulkBar, type PickedRun } from '../runspage/BulkBar.js';
import { Calendar } from '../runspage/Calendar.js';
import { pickedOf, pickedRange, rangeTimes, type PickedDays } from '../runspage/calendar-model.js';
import { FindCommitDialog } from '../runspage/FindCommit.js';
import { ImportDialog } from '../runspage/ImportDialog.js';
import { runsLinkQuery } from '../runspage/query.js';
import { RunsTable, type TableRun } from '../runspage/RunsTable.js';
import { bundlesAttempts, isAttempt, matchesChip, matchesText, RUN_CHIPS, sortRuns, type RunChip, type RunSort } from '../runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';
import { useTeamStore } from '../teamstore.js';
import { errorText } from '../toast.js';
import type { BisectChoices, ChipCounts, RunsPage as RunsPageView, RunsPageRow, RunsQuery } from '../types.js';
import { viewerTimeZone } from './Overview.js';

/**
 * Runs: every run in a table, a page at a time from the server, with the 12-week calendar above it,
 * the type chips, a filter and sorting; attempts bundled under the run they came from. Runs picked
 * get a bulk bar. With a team store, who made each run, a `local` tag on runs not pushed yet, Pull
 * in the header and Push in the bulk bar. What the page was showing is kept while the dashboard is
 * open, so a run opened and closed lands back on the same view; the selection survives filter
 * changes, and lets go of a run deleted elsewhere. A link can ask for a filter
 * (`#/runs?q=…&type=failed`). An exported copy lists the runs it holds, worked out in the page.
 */

const PAGE = 50;

/**
 * What the page holds, every kind of attempt in one word: `--repeat`'s, blame's and verify's, a
 * golden's repeats in one test session and the error-path presets' are all bundled.
 */
export const RUNS_TEXT = 'Recordings, and the replays and forks made from them. Attempts are bundled under the run they came from.';

const kept = {
  chip: 'all' as RunChip,
  query: '',
  sort: 'when' as RunSort,
  limit: PAGE,
  picked: new Map<string, PickedRun>(),
  days: null as PickedDays | null,
  /** The instants the days picked span, so the table asks for them before the calendar is in. */
  times: null as { from: number; to: number } | null,
};

export function RunsPage() {
  const { exported } = useApp();
  return exported ? <ExportedRuns /> : <ServerRuns />;
}

/**
 * The filter a link asked for (`#/runs?q=…&type=…`: an import's runs, Needs a look's failed runs)
 * becomes the page's, the days picked let go, and the address goes back to `#/runs`, so the filter
 * can be changed from there. False when the link asked for nothing.
 */
function takeLinkQuery(): boolean {
  const asked = runsLinkQuery(location.hash);
  if (!asked) return false;
  kept.chip = asked.chip;
  kept.query = asked.q;
  kept.days = null;
  kept.times = null;
  kept.limit = PAGE;
  history.replaceState(history.state, '', `${location.pathname}${location.search}#/runs`);
  return true;
}

/** The palette's way to the import dialog: Runs opens it when it next shows. */
const IMPORT_ASKED = 'shadowlap:import';
let importAsked = false;

addPaletteSource(({ app, go }) =>
  app.exported || !app.hasKind(JOB_KINDS.importCapture)
    ? []
    : [
        {
          group: 'Actions',
          label: 'Import a capture…',
          hint: 'HAR, nock, VCR, LiteLLM, OpenTelemetry, a Langfuse or LangSmith trace',
          run: () =>
            app.guard(() => {
              importAsked = true;
              window.dispatchEvent(new Event(IMPORT_ASKED));
              go(href.runs());
            }),
        },
      ],
);

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

const CHIP_TYPES: Readonly<Record<RunChip, readonly string[]>> = { all: [], recording: ['recording'], fork: ['fork'], clean: ['clean'], test: ['test'], capture: ['capture'], failed: ['failed'], local: ['local'] };

function pickedRun(r: TableRun): PickedRun {
  return { runId: r.runId, status: r.status, startedAt: r.startedAt, attempts: r.attempts ?? 0, ...(r.local !== undefined ? { local: r.local } : {}) };
}

function ServerRuns() {
  const { client, meta, tick, feeds, actionsOff, hasKind, guard, watchJob, toast, refresh } = useApp();
  // Arriving from a link that asks for a filter: it is the page's before the first request.
  useState(takeLinkQuery);
  const store = useTeamStore();
  const tz = useMemo(viewerTimeZone, []);
  const [chip, setChipState] = useState(kept.chip);
  const [query, setQueryState] = useState(kept.query);
  const q = useSettled(query, 250);
  const [sort, setSortState] = useState(kept.sort);
  const [limit, setLimitState] = useState(kept.limit);
  const [picked, setPickedState] = useState(() => new Map(kept.picked));
  const [days, setDaysState] = useState(kept.days);
  const [times, setTimesState] = useState(kept.times);
  const [dialog, setDialog] = useState<null | 'import' | { runId: string; choices: BisectChoices }>(() => (importAsked ? 'import' : null));
  const now = Date.now();
  // Asked from the palette: on this page already, or arriving on it.
  useEffect(() => {
    importAsked = false;
    const on = () => {
      importAsked = false;
      setDialog('import');
    };
    window.addEventListener(IMPORT_ASKED, on);
    return () => window.removeEventListener(IMPORT_ASKED, on);
  }, []);
  // A link that asks for a filter, followed while the page is open (the import drawer's).
  useEffect(() => {
    const on = () => {
      if (!takeLinkQuery()) return;
      setChipState(kept.chip);
      setQueryState(kept.query);
      setDaysState(null);
      setTimesState(null);
      setLimitState(PAGE);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const setLimit = (n: number) => {
    kept.limit = n;
    setLimitState(n);
  };
  const setChip = (c: RunChip) => {
    kept.chip = c;
    setChipState(c);
    setLimit(PAGE);
  };
  const setQuery = (v: string) => {
    kept.query = v;
    setQueryState(v);
  };
  const setSort = (s: RunSort) => {
    kept.sort = s;
    setSortState(s);
  };
  const setPicked = useCallback((m: Map<string, PickedRun>) => {
    kept.picked = m;
    setPickedState(m);
  }, []);

  const types = CHIP_TYPES[chip];
  const cal = useLoad(() => client.runsByDay({ tz, weeks: 12, types, q }), 'runs-days', `${tick}|${chip}|${q}`);
  const calDays = cal.data?.days ?? null;
  const range = calDays ? pickedRange(calDays, days) : null;

  const pickDays = useCallback(
    (r: [number, number] | null) => {
      const keys = calDays ? pickedOf(calDays, r) : null;
      const t = calDays ? rangeTimes(calDays, r) : null;
      kept.days = keys;
      kept.times = t;
      kept.limit = PAGE;
      setDaysState(keys);
      setTimesState(t);
      setLimitState(PAGE);
    },
    [calDays],
  );

  // Read again when runs change, and when a push or a pull changes what is only here (the local tags).
  const page = useLoad(() => loadRows(client, { types, q, sort, from: times?.from ?? null, to: times?.to ?? null }, limit), 'runs-page', `${tick}:${feeds.team ?? 0}|${chip}|${q}|${sort}|${times?.from ?? ''}|${times?.to ?? ''}|${limit}`);
  const rows: TableRun[] = page.data?.runs ?? [];
  const counts: ChipCounts | null = page.data?.chipCounts ?? null;

  // What the bar knows of a run picked follows the table: a recording that ends can then be deleted,
  // and a delete names the attempts a blame added meanwhile.
  useEffect(() => {
    if (!picked.size || !page.data) return;
    let changed = false;
    const next = new Map(picked);
    for (const r of page.data.runs) {
      const was = next.get(r.runId);
      if (!was) continue;
      const now = pickedRun(r);
      if (was.status !== now.status || was.local !== now.local || was.attempts !== now.attempts) {
        next.set(r.runId, now);
        changed = true;
      }
    }
    if (changed) setPicked(next);
  }, [page.data, picked, setPicked]);

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
      client.daysBisect({ ...t, types, q }).then(
        (out) => ('reason' in out ? toast(sentence(out.reason)) : setDialog({ runId: out.runId, choices: out.choices })),
        (err: unknown) => toast(errorText(err), 'error'),
      ),
    );
  };

  const p = projectOf(meta);
  const off = actionsOff ?? undefined;
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
              <button className="btn" type="button" disabled={!!actionsOff} title={off ?? `Bring the team’s runs from ${store.name}`} onClick={() => guard(() => watchJob(client.startJob(JOB_KINDS.pull, {})))}>
                Pull
              </button>
            ) : null}
            {hasKind(JOB_KINDS.importCapture) ? (
              <button className="btn" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => setDialog('import'))}>
                <Icon name="import" />
                Import a capture
              </button>
            ) : null}
          </>
        }
      />
      {cal.data ? <Calendar data={cal.data} chip={chip} range={range} onPick={pickDays} byPerson={!!store} onFindCommit={hasKind(JOB_KINDS.bisect) ? findCommit : null} actionsOff={actionsOff} /> : null}
      <div className="tbar">
        <Chips label="Kind of run" items={RUN_CHIPS.filter(([key]) => key !== 'local' || store || chip === 'local').map(([key, label]) => ({ key, label, ...(counts ? { count: counts[key] } : {}) }))} value={chip} onChange={setChip} />
        <label className="tin">
          <span className="sr">Filter runs</span>
          <input type="search" placeholder="Filter by id, command, label or revision" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <section className="panel tscroll">
        <RunsTable rows={rows} picked={picked} selectable byColumn={!!store} you={store?.you ?? null} sort={sort} onSort={setSort} onPick={onPick} onPickAll={onPickAll} now={now} />
        {page.error && !page.data ? (
          <div className="empty">The runs could not be read: {page.error.message}</div>
        ) : !page.data ? (
          <div className="empty">Loading runs…</div>
        ) : rows.length === 0 ? (
          <div className="empty">{counts?.all ? 'No runs match.' : days ? 'No runs on the days picked.' : 'No runs yet. Record one with shadowlap run -- <command>.'}</div>
        ) : null}
        <ShowMore shown={rows.length} total={page.data?.total ?? 0} onMore={() => setLimit(limit + PAGE)} />
      </section>
      {runs.length ? (
        <>
          <BulkBar runs={runs} store={!!store} clear={() => setPicked(new Map())} onDone={refresh} />
          <div className="bulkspace" />
        </>
      ) : null}
      {dialog === 'import' ? <ImportDialog onClose={() => setDialog(null)} /> : null}
      {dialog && dialog !== 'import' ? <FindCommitDialog runId={dialog.runId} choices={dialog.choices} onClose={() => setDialog(null)} /> : null}
    </Page>
  );
}

/** An exported copy: the runs it holds, filtered and sorted in the page; nothing to pick. */
function ExportedRuns() {
  const { runs } = useApp();
  const [chip, setChip] = useState<RunChip>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<RunSort>('when');
  const [limit, setLimit] = useState(PAGE);
  const listed = useMemo(() => (runs ?? []).filter((r) => !isAttempt(r)), [runs]);
  const counts = useMemo(() => Object.fromEntries(RUN_CHIPS.map(([k]) => [k, listed.filter((r) => matchesChip(r, k)).length])) as Record<RunChip, number>, [listed]);
  const matched = useMemo(() => sortRuns(listed.filter((r) => matchesChip(r, chip) && matchesText(r, query)), sort), [listed, chip, query, sort]);
  const shown = matched.slice(0, limit);
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
          <input type="search" placeholder="Filter by id, command, label or revision" value={query} onChange={(e) => setQuery(e.target.value)} />
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
