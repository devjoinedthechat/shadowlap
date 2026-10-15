import { useMemo, useState } from 'react';
import { JOB_KINDS, type RunListItem } from '../api.js';
import { Chips, PageHeader } from '../components/bits.js';
import { ConfirmDialog, Dialog, PromptDialog } from '../components/Dialog.js';
import { Icon } from '../components/Icon.js';
import { Page } from '../components/Page.js';
import { RunIcon } from '../components/RunIcon.js';
import { MiniStrip } from '../components/Strip.js';
import { rowOpen, ShowMore, SortTh } from '../components/Table.js';
import { compactPath, num, shortId, whenShort } from '../format.js';
import { href } from '../route.js';
import { navigate } from '../router.js';
import { isAttempt, isLive, matchesChip, matchesText, RUN_CHIPS, runOrigins, runOutcome, runSpent, runSubline, sortRuns, type RunChip, type RunSort } from '../runs.js';
import { projectOf } from '../shell/ProjectBlock.js';
import { useApp } from '../state.js';

/**
 * Runs: every run in a table, with type chips, a filter, sorting, and a bulk bar for what is picked.
 * What the page was showing is kept while the dashboard is open, so a run opened and closed lands
 * back on the same view; the selection survives filter changes.
 */

const PAGE = 50;
const kept = { chip: 'all' as RunChip, query: '', sort: 'when' as RunSort, limit: PAGE, picked: new Set<string>() };

export function RunsPage() {
  const app = useApp();
  const { runs, meta, exported } = app;
  const [chip, setChipState] = useState(kept.chip);
  const [query, setQueryState] = useState(kept.query);
  const [sort, setSortState] = useState(kept.sort);
  const [limit, setLimitState] = useState(kept.limit);
  const [picked, setPickedState] = useState(() => new Set(kept.picked));
  const setChip = (c: RunChip) => {
    kept.chip = c;
    setChipState(c);
    setLimit(PAGE);
  };
  const setQuery = (q: string) => {
    kept.query = q;
    setQueryState(q);
  };
  const setSort = (s: RunSort) => {
    kept.sort = s;
    setSortState(s);
  };
  const setLimit = (n: number) => {
    kept.limit = n;
    setLimitState(n);
  };
  const setPicked = (s: Set<string>) => {
    kept.picked = s;
    setPickedState(s);
  };

  const listed = useMemo(() => (runs ?? []).filter((r) => !isAttempt(r)), [runs]);
  const counts = useMemo(() => Object.fromEntries(RUN_CHIPS.map(([k]) => [k, listed.filter((r) => matchesChip(r, k)).length])) as Record<RunChip, number>, [listed]);
  const matched = useMemo(() => sortRuns(listed.filter((r) => matchesChip(r, chip) && matchesText(r, query)), sort), [listed, chip, query, sort]);
  const shown = matched.slice(0, limit);
  const withOrigins = listed.some((r) => runOrigins(r));
  const byId = useMemo(() => new Map(listed.map((r) => [r.runId, r])), [listed]);
  const pickedRuns = [...picked].map((id) => byId.get(id)).filter((r): r is RunListItem => !!r);
  const allOn = shown.length > 0 && shown.every((r) => picked.has(r.runId));
  const toggle = (id: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };
  const p = projectOf(meta);
  const now = Date.now();

  return (
    <Page>
      <PageHeader eyebrow={exported ? 'exported copy' : p ? compactPath(p.path) : 'runs'} title="Runs" text="Recordings, and the replays and forks made from them." />
      <div className="tbar">
        <Chips label="Kind of run" items={RUN_CHIPS.map(([key, label]) => ({ key, label, count: counts[key] }))} value={chip} onChange={setChip} hideEmpty />
        <label className="tin">
          <span className="sr">Filter runs</span>
          <input type="search" placeholder="Filter by id, command, label or revision" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <section className="panel tscroll">
        <table className="t runst">
          <thead>
            <tr>
              {exported ? null : (
                <th className="selcell">
                  <input type="checkbox" aria-label="Select every run shown" checked={allOn} onChange={(e) => {
                      const next = new Set(picked);
                      for (const r of shown) {
                        if (e.target.checked) next.add(r.runId);
                        else next.delete(r.runId);
                      }
                      setPicked(next);
                    }} />
                </th>
              )}
              <th>Run</th>
              <th className="hide-lg">Labels</th>
              {withOrigins ? <th className="hide-md">Calls by origin</th> : null}
              <SortTh by="calls" sort={sort} onSort={setSort}>
                Calls
              </SortTh>
              <SortTh by="spent" sort={sort} onSort={setSort} className="num hide-sm">
                Spent
              </SortTh>
              <th>Status</th>
              <SortTh by="when" sort={sort} onSort={setSort} className="num hide-sm">
                When
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const out = runOutcome(r);
              const spent = runSpent(r);
              const origins = runOrigins(r);
              const on = picked.has(r.runId);
              return (
                <tr key={r.runId} className={on ? 'picked' : undefined} onClick={rowOpen(() => navigate(href.run(r.runId)))}>
                  {exported ? null : (
                    <td className="selcell">
                      <input type="checkbox" aria-label={`Select ${shortId(r.runId)}`} checked={on} onChange={(e) => toggle(r.runId, e.target.checked)} />
                    </td>
                  )}
                  <td className="runcell">
                    <span className="rid">
                      <RunIcon run={r} />
                      <a className="rlink" href={href.run(r.runId)}>
                        <code>{shortId(r.runId)}</code>
                      </a>
                    </span>
                    <span className="rsub" title={r.source ? `from ${r.source}` : r.command}>
                      {runSubline(r)}
                    </span>
                  </td>
                  <td className="hide-lg labcell">
                    {r.labels.map((l) => (
                      <span className="chip" key={l}>
                        {l}
                      </span>
                    ))}
                  </td>
                  {withOrigins ? <td className="hide-md">{origins ? <MiniStrip origins={origins} /> : null}</td> : null}
                  <td className="num">{num(r.calls)}</td>
                  <td className="num hide-sm">
                    {spent.text}
                    {spent.captured ? <span className="nil"> as captured</span> : null}
                  </td>
                  <td>
                    <span className={`st ${out.tone}`} aria-label={out.tone === 'n' ? 'nothing to report' : undefined}>
                      <i />
                      {out.text}
                    </span>
                  </td>
                  <td className="num hide-sm">{whenShort(r.startedAt, now)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {runs === null ? <div className="empty">Loading runs…</div> : shown.length === 0 ? <div className="empty">{listed.length ? 'No runs match.' : 'No runs yet. Record one with shadowlap run -- <command>.'}</div> : null}
        <ShowMore shown={shown.length} total={matched.length} onMore={() => setLimit(limit + PAGE)} />
      </section>
      {pickedRuns.length ? (
        <>
          <BulkBar runs={pickedRuns} clear={() => setPicked(new Set())} />
          <div className="bulkspace" />
        </>
      ) : null}
    </Page>
  );
}

type BulkDialog = 'label' | 'delete' | 'dataset' | null;

function BulkBar({ runs, clear }: { runs: RunListItem[]; clear: () => void }) {
  const app = useApp();
  const { actionsOff, client, toast, refresh, guard, hasKind, watchJob } = app;
  const [dialog, setDialog] = useState<BulkDialog>(null);
  const ids = runs.map((r) => r.runId);
  const live = runs.filter(isLive);
  const deletable = runs.filter((r) => !isLive(r));
  const off = actionsOff ?? undefined;
  return (
    <>
      <div className="bulkbar" role="toolbar" aria-label="Selected runs">
        <b>{runs.length} selected</b>
        <span className="sep" />
        <button className="btn sm" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => setDialog('label'))}>
          <Icon name="plus" />
          Label
        </button>
        {hasKind(JOB_KINDS.pack) ? (
          <button className="btn sm" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => runs.forEach((r) => watchJob(client.startJob(JOB_KINDS.pack, { runId: r.runId, dir: `share/${shortId(r.runId).toLowerCase()}` }))))}>
            Pack
          </button>
        ) : null}
        {hasKind(JOB_KINDS.dataset) ? (
          <button className="btn sm" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => setDialog('dataset'))}>
            Dataset
          </button>
        ) : null}
        <button
          className="btn sm"
          type="button"
          disabled={runs.length !== 2}
          title={runs.length === 2 ? undefined : 'Pick exactly two runs'}
          onClick={() => {
            const [a, b] = [...runs].sort((x, y) => x.startedAt - y.startedAt);
            if (a && b) navigate(href.compare(a.runId, b.runId));
          }}
        >
          Compare
        </button>
        <button className="btn sm quiet dz" type="button" disabled={!!actionsOff} title={off} onClick={() => guard(() => (deletable.length ? setDialog('delete') : toast('A run that is still recording can’t be deleted.')))}>
          Delete
        </button>
        <button className="linkbtn" type="button" onClick={clear}>
          Clear
        </button>
      </div>
      {dialog === 'label' ? (
        <PromptDialog
          title={`Label ${runs.length === 1 ? shortId(ids[0]!) : `${runs.length} runs`}`}
          text="A label says what a run is, so it can be found and exported as part of a dataset (export dataset --label)."
          label="Label"
          placeholder="good"
          maxLength={40}
          ok="Add label"
          onClose={() => setDialog(null)}
          onRun={(label) => {
            setDialog(null);
            void Promise.allSettled(ids.map((id) => client.labels(id, [label]))).then((results) => {
              const failed = results.filter((x) => x.status === 'rejected');
              const reason = failed[0]?.status === 'rejected' ? (failed[0].reason as Error).message : '';
              toast(failed.length ? `Labelled ${ids.length - failed.length} of ${ids.length}: ${reason}` : `Labelled ${ids.length === 1 ? shortId(ids[0]!) : `${ids.length} runs`} “${label}”`);
              refresh();
            });
          }}
        />
      ) : null}
      {dialog === 'delete' ? (
        <ConfirmDialog
          title={`Delete ${deletable.length === 1 ? shortId(deletable[0]!.runId) : `${deletable.length} runs`}?`}
          text={`Removes the runs and the recorded data nothing else uses. Their forks keep their own data but lose the link.${live.length ? ` ${live.map((r) => shortId(r.runId)).join(', ')} ${live.length === 1 ? 'is' : 'are'} still recording and ${live.length === 1 ? 'is' : 'are'} left alone.` : ''}`}
          command={`shadowlap rm ${deletable.map((r) => shortId(r.runId)).join(' ')}`}
          ok={`Delete ${deletable.length === 1 ? 'run' : `${deletable.length} runs`}`}
          danger
          onClose={() => setDialog(null)}
          onOk={() => {
            setDialog(null);
            void Promise.allSettled(deletable.map((r) => client.remove(r.runId))).then((results) => {
              const done = results.filter((x) => x.status === 'fulfilled').length;
              toast(done === deletable.length ? `Deleted ${done === 1 ? shortId(deletable[0]!.runId) : `${done} runs`}` : `Deleted ${done} of ${deletable.length} runs`);
              clear();
              refresh();
            });
          }}
        />
      ) : null}
      {dialog === 'dataset' ? <DatasetDialog ids={ids} onClose={() => setDialog(null)} /> : null}
    </>
  );
}

/** Runs as an eval dataset: the format and which calls become examples. */
export function DatasetDialog({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { client, watchJob } = useApp();
  const [format, setFormat] = useState('jsonl');
  const [calls, setCalls] = useState('final');
  return (
    <Dialog
      title={`Export ${ids.length === 1 ? shortId(ids[0]!) : `${ids.length} runs`} as an eval dataset`}
      text="One JSON line per example: the conversation exactly as the model saw it, its answer, and metadata with the labels, notes and check results."
      ok="Export"
      onClose={onClose}
      onOk={() => {
        onClose();
        watchJob(client.startJob(JOB_KINDS.dataset, { runIds: ids, format, calls }));
      }}
    >
      <div className="form">
        <label>
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="jsonl">jsonl</option>
            <option value="braintrust">braintrust</option>
            <option value="langfuse">langfuse</option>
            <option value="openai-chat">openai-chat</option>
          </select>
        </label>
        <label>
          Examples
          <select value={calls} onChange={(e) => setCalls(e.target.value)}>
            <option value="final">Last model call of each run</option>
            <option value="model">Every model call</option>
          </select>
        </label>
      </div>
    </Dialog>
  );
}
