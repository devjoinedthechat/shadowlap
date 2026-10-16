import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JOB_KINDS, type CallDetail, type RunDetail } from '../api.js';
import { Legend } from '../components/bits.js';
import { useMenu } from '../components/Popover.js';
import { Page } from '../components/Page.js';
import { Strip, stripDetail, type StripCall } from '../components/Strip.js';
import { callName, shortId } from '../format.js';
import { useActiveTabInView, useLatest, useLoad } from '../hooks.js';
import { followNewest, recordingEnded } from '../live.js';
import { countOrigins, presentOrigins } from '../origins.js';
import { indexCalls, needsAncestors, notWaited, type CallIndex } from '../recorded.js';
import { CYCLE_VIEWS, href, nextView, type View } from '../route.js';
import { navigate } from '../router.js';
import { inScope, scopeChips, scopesOf } from '../scopes.js';
import { useApp, type PaletteCommand } from '../state.js';
import { useActionRunner } from '../run/actions.js';
import { CallsTable, CallsToolbar, matchesFilter, type OriginFilter } from '../run/CallsView.js';
import { ContextView } from '../run/ContextView.js';
import { ForksView } from '../run/ForksView.js';
import { Inspector, TABS, type InspectorTab } from '../run/Inspector.js';
import { flagText } from '../run/banner.js';
import { askedTools } from '../run/calls.js';
import { bisectLabel } from '../run/offers.js';
import { blameOf, checksOf, forkAtOf, forkMarkOf, originOf, withModelNames } from '../run/model.js';
import { Banner, DiffPanel, Metrics, ScopeBar } from '../run/parts.js';
import { ProvenanceView } from '../run/ProvenanceView.js';
import { RunHeader } from '../run/RunHeader.js';
import { TimelineView } from '../run/TimelineView.js';
import { TurnsView } from '../run/TurnsView.js';

/**
 * A run: its header and numbers, a banner for how it forked, where it was lost or that it is
 * recording, the strip of every call, scopes, the five views and Provenance, and the inspector. The
 * URL holds the call and the view; a run still recording grows as calls arrive.
 */

let lastTab: InspectorTab = 'conversation';

export function RunPage({ id, call, view }: { id: string; call: number | null; view: View | null }) {
  const { client, tick } = useApp();
  const loaded = useLoad(() => client.run(id), id, tick);
  const run = loaded.data;
  if (!run) {
    if (loaded.error)
      return (
        <Page>
          <div className="empty tall">
            {/no run|not part of it|404/.test(loaded.error.message) ? `No run ${id} in ${client.exported ? 'this copy' : 'this store'}.` : `Could not load ${id}: ${loaded.error.message}`}{' '}
            <a className="more" href={href.runs()}>
              Back to Runs
            </a>
          </div>
        </Page>
      );
    return <div className="rv loading" />;
  }
  return <Workspace run={run} id={id} call={call} view={view} />;
}

/** The parent run, and further back, for replayed calls' recorded durations and how a fork came about. */
function useAncestors(run: RunDetail): RunDetail[] {
  const { client } = useApp();
  const [chain, setChain] = useState<RunDetail[]>([]);
  const want = !!run.run.parentRunId && (needsAncestors(run.calls) || !!run.run.divergence);
  const deep = needsAncestors(run.calls);
  useEffect(() => {
    if (!want || !run.run.parentRunId) return setChain([]);
    let alive = true;
    void (async () => {
      const out: RunDetail[] = [];
      let next: string | null = run.run.parentRunId;
      while (next && out.length < (deep ? 5 : 1)) {
        try {
          const d: RunDetail = await client.run(next);
          out.push(d);
          if (!alive) return;
          setChain([...out]);
          if (!needsAncestors(d.calls)) break;
          next = d.run.parentRunId;
        } catch {
          break;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [client, run.run.runId, run.run.parentRunId, want, deep]);
  return chain;
}

/** The turn a fork changed in the conversation at a call: the first that differs from the parent's at the same call. */
function useChange(run: RunDetail, detail: CallDetail | null, forkAt: number | null): { turn: number; firstAt: number; by: 'fork' | 'replay' } | null {
  const { client } = useApp();
  const parent = run.run.parentRunId;
  const n = detail?.call.callNo ?? null;
  const want = !!parent && forkAt !== null && n !== null && n >= forkAt && detail?.call.kind === 'api' && !!detail.conversation;
  const theirs = useLoad(() => (want && parent && n ? client.call(parent, n) : null), want ? `${parent}:${n}` : 'none');
  return useMemo(() => {
    if (!want || !detail?.conversation || !forkAt) return null;
    const mine = detail.conversation.turns;
    const other = theirs.data?.conversation?.turns;
    if (!other) return null;
    // The first turn that differs, or the first one the parent did not have (an instruction added at the end).
    // A test's replay that diverged changed its request without forking: the message says "this replay".
    const by = run.run.meta?.test ? 'replay' : 'fork';
    for (let i = 0; i < mine.length; i++) if (i >= other.length || JSON.stringify(mine[i]) !== JSON.stringify(other[i])) return { turn: i, firstAt: forkAt, by };
    return null;
  }, [want, detail, theirs.data, forkAt, run.run.meta?.test]);
}

function Workspace({ run, id, call, view }: { run: RunDetail; id: string; call: number | null; view: View | null }) {
  const app = useApp();
  const { client, toast, exported, actionsOff, setRunCommands, runKeys, setPalette, tick } = app;
  const runId = run.run.runId;
  const live = run.run.status === 'running';
  // Each model named as the page names it everywhere: claude-opus-5, not opus-5 here and the full id there.
  const calls = useMemo(() => withModelNames(run.calls, run.models), [run.calls, run.models]);
  const forkAt = forkAtOf(run);
  // Flagged FORK on the strip and in Calls: not where a test replay diverged offline, which failed there.
  const forkMark = forkMarkOf(run);
  const blame = useMemo(() => blameOf(run), [run]);
  const lostAt = blame?.callNo ?? null;
  const last = calls.length ? calls[calls.length - 1]!.callNo : null;
  const first = calls[0]?.callNo ?? null;
  const fallback = forkAt ?? lostAt ?? (live ? last : first);
  const selected = call !== null && calls.some((c) => c.callNo === call) ? call : call !== null && live ? call : fallback;
  const v: View = view ?? 'calls';

  // A short id settles on the full one; a run opened without a call lands on its fork, its lost call, or its first call.
  useEffect(() => {
    if (runId !== id || (call === null && selected !== null)) navigate(href.run(runId, call ?? selected, view), true);
  }, [runId, id, call, selected, view]);

  // Recording: the selection follows the newest call if it was on the newest (also when the last calls
  // and the end of the recording arrive together); a toast when it ends.
  const prevLast = useRef(last);
  const prevStatus = useRef(run.run.status);
  useEffect(() => {
    const step = { wasStatus: prevStatus.current, status: run.run.status, prevLast: prevLast.current, last, selected };
    const next = followNewest(step);
    if (next !== null) navigate(href.run(runId, next, view), true);
    const ended = recordingEnded(step);
    if (ended) toast(`Recording ${ended} · ${shortId(runId)} · ${calls.length} ${calls.length === 1 ? 'call' : 'calls'}`);
    prevLast.current = last;
    prevStatus.current = run.run.status;
  }, [last, selected, runId, view, run.run.status, calls.length, toast]);

  const [scope, setScope] = useState('all');
  const scopes = useMemo(() => scopesOf(calls), [calls]);
  const scopeTree = useMemo(() => scopeChips(calls), [calls]);
  const scoped = scopes.length > 0;
  const scopedCalls = useMemo(() => (scope === 'all' ? calls : calls.filter((c) => inScope(c, scope))), [calls, scope]);
  const [filter, setFilter] = useState<OriginFilter>('all');
  const [text, setText] = useState('');
  // The tools each model call asked for, when the server says which call asked for each tool call.
  const asked = useMemo(() => (calls.some((c) => c.kind === 'tool' && c.requestedBy !== undefined) ? askedTools(calls) : null), [calls]);
  const visible = useMemo(() => scopedCalls.filter((c) => matchesFilter(c, filter, text.trim(), c.kind === 'api' && asked ? (asked.get(c.callNo) ?? null) : undefined)), [scopedCalls, filter, text, asked]);
  const filterCounts = useMemo(() => {
    const n = countOrigins(scopedCalls.map(originOf));
    return { all: scopedCalls.length, live: n.live, rep: n.rep, over: n.over, inject: n.inject, fail: n.fail, block: n.block + n.stub } satisfies Record<OriginFilter, number>;
  }, [scopedCalls]);
  const [tab, setTabState] = useState<InspectorTab>(lastTab);
  const setTab = (t: InspectorTab) => {
    lastTab = t;
    setTabState(t);
  };
  const [showDiff, setShowDiff] = useState(false);
  const filterRef = useRef<HTMLInputElement>(null);
  // `/` filters the calls: from another view it opens Calls first, and the field takes focus once it is there.
  const [filterWanted, setFilterWanted] = useState(false);
  useEffect(() => {
    if (!filterWanted || (view ?? 'calls') !== 'calls') return;
    filterRef.current?.focus();
    setFilterWanted(false);
  }, [filterWanted, view]);
  const forkMenu = useMenu();
  // What the page offers beyond the run's record: Share's counts, Push, Run blame, Find the commit.
  // None of it applies while the run records, so it is asked for once it has ended, and again as runs change.
  const offers = useLoad(() => (exported || live ? null : client.offers(runId)), `${runId}:offers:${live ? 'live' : 'ended'}`, live ? 0 : tick).data ?? null;
  const actions = useActionRunner(runId, !!run.source, offers);

  const selectedRow = calls.find((c) => c.callNo === selected) ?? null;
  const detailKey = `${runId}:${selected}:${selectedRow?.outcome ?? 'pending'}`;
  const detail = useLoad<CallDetail>(() => (selected !== null && selectedRow ? client.call(runId, selected) : null), detailKey);
  const change = useChange(run, detail.data, forkAt);
  const chain = useAncestors(run);
  const ancestors = useMemo<CallIndex[]>(() => chain.map((d) => indexCalls(d.calls)), [chain]);
  const waited = useMemo(() => (typeof run.notWaitedMs === 'number' ? { ms: run.notWaitedMs, unknown: 0 } : notWaited(calls, ancestors)), [run.notWaitedMs, calls, ancestors]);
  const parent = chain[0] ?? null;
  const rescued: { callNo: number | null } | null = run.rescuedBy ? { callNo: run.rescuedBy.callNo ?? forkAt } : parent?.run.meta?.blame?.rescuedRunId === runId && run.run.divergence ? { callNo: run.run.divergence.callNo } : null;

  const select = useCallback((n: number) => navigate(href.run(runId, n, v), true), [runId, v]);
  const setView = (next: View) => navigate(href.run(runId, selected, next), true);
  const listFor = useCallback(() => (v === 'calls' ? visible : scopedCalls), [v, visible, scopedCalls]);
  const step = useCallback(
    (delta: number) => {
      const list = listFor();
      if (!list.length) return;
      const i = list.findIndex((c) => c.callNo === selected);
      const next = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta))];
      if (next) select(next.callNo);
    },
    [listFor, selected, select],
  );
  const canFork = !exported && !live && !actionsOff;
  // Stable, so a row does not redraw when the selection moves elsewhere.
  const selectedNow = useLatest(selected);
  const openAt = forkMenu.openAt;
  const openForkAt = useCallback(
    (n: number, el: HTMLElement) => {
      if (n !== selectedNow.current) select(n);
      openAt(el);
    },
    [selectedNow, select, openAt],
  );

  // The run's keys, while this page is open.
  const keyState = useLatest({ step, setTab, v, forkAt, lostAt, parentId: run.run.parentRunId, canFork, setView, setFilterWanted });
  useEffect(() => {
    runKeys.current = (e) => {
      const k = keyState.current;
      if (e.key === 'j' || e.key === 'ArrowDown') return k.step(1), true;
      if (e.key === 'k' || e.key === 'ArrowUp') return k.step(-1), true;
      if (/^[1-4]$/.test(e.key)) return k.setTab(TABS[Number(e.key) - 1]!), true;
      if (e.key === 'n' && (k.forkAt ?? k.lostAt) !== null) return select((k.forkAt ?? k.lostAt)!), true;
      if (e.key === 'p' && k.parentId) return navigate(href.run(k.parentId)), true;
      if (e.key === 'v') return k.setView(nextView(k.v)), true;
      if (e.key === 'f' && k.canFork) {
        const btn = document.getElementById('forkBtn');
        if (btn) forkMenu.openAt(btn);
        return true;
      }
      if (e.key === '/') {
        if (k.v !== 'calls') k.setView('calls');
        k.setFilterWanted(true);
        return true;
      }
      return false;
    };
    return () => {
      runKeys.current = null;
    };
  }, [runKeys, keyState, select, forkMenu]);

  // This run, in the palette.
  const findCommit = useLatest(actions.findCommit);
  useEffect(() => {
    const items: PaletteCommand[] = [];
    const replay = run.actions.find((a) => a.key === 'r');
    if (!exported && !actionsOff && replay && !live) items.push({ group: 'This run', label: `Replay ${shortId(runId)}`, hint: 'shadowlap replay', run: () => actions.run({ action: replay, callNo: null }) });
    if (canFork && selected !== null)
      items.push({
        group: 'This run',
        label: `Fork at #${selected}…`,
        hint: 'inject, override, fail, switch the model',
        run: () => {
          const btn = document.getElementById('forkBtn');
          if (btn) setTimeout(() => forkMenu.openAt(btn));
        },
      });
    if (!exported)
      items.push({
        group: 'This run',
        label: 'Share…',
        hint: 'HTML, pack, dataset, OpenTelemetry, HAR',
        run: () => {
          const btn = document.querySelector<HTMLElement>('.rhead .actions [aria-haspopup="menu"]');
          if (btn) setTimeout(() => btn.click());
        },
      });
    if (!exported && !actionsOff && !live && !run.source && app.hasKind(JOB_KINDS.bisect)) items.push({ group: 'This run', label: `${bisectLabel(offers?.bisect).label}…`, hint: 'shadowlap bisect', run: () => findCommit.current() });
    items.push({ group: 'This run', label: 'Provenance', hint: 'the run’s record, call by call', run: () => setView('provenance') });
    if (run.parent) items.push({ group: 'This run', label: 'Compare with parent', hint: shortId(run.parent.runId), run: () => navigate(href.compare(run.parent!.runId, runId)) });
    setRunCommands(items);
  }, [runId, selected, live, exported, actionsOff, canFork, run.parent?.runId, offers?.bisect?.failed]);
  useEffect(() => () => setRunCommands([]), [setRunCommands]);

  const stripCalls = useMemo<StripCall[]>(() => calls.map((c) => ({ n: c.callNo, origin: originOf(c), name: callName(c.kind, c.name), detail: stripDetail(c) })), [calls]);
  const inScopeFn = useMemo(() => {
    if (scope === 'all') return null;
    const ids = new Set(scopedCalls.map((c) => c.callNo));
    return (n: number) => ids.has(n);
  }, [scope, scopedCalls]);
  const present = useMemo(() => presentOrigins(countOrigins(stripCalls.map((c) => c.origin))), [stripCalls]);

  const tabs: Array<[View, string, number | undefined]> = [
    ['calls', 'Calls', scopedCalls.length],
    ['turns', 'Turns', scopedCalls.filter((c) => c.kind === 'api').length],
    ['context', 'Context', undefined],
    ['timeline', 'Timeline', undefined],
    ['forks', 'Forks', undefined],
    ['provenance', 'Provenance', undefined],
  ];

  return (
    <div className="rv">
      <RunHeader run={run} call={detail.data} selected={selected} rescued={!!rescued} offers={offers} forkMenu={forkMenu} onAction={actions.run} onFindCommit={actions.findCommit} />
      <Metrics run={run} notWaitedMs={waited.ms || null} notWaitedUnknown={waited.unknown} />
      <Banner run={run} blame={blame} rescued={rescued} checks={checksOf(run)} offers={offers} showDiff={showDiff} onToggleDiff={() => setShowDiff(!showDiff)} onSelect={select} onAction={actions.run} />
      {showDiff ? <DiffPanel run={run} /> : null}
      <section className="strip">
        {calls.length ? <Strip calls={stripCalls} selected={selected} forkAt={forkMark} lostAt={lostAt} inScope={inScopeFn} live={live} onSelect={select} /> : <div className="cells empty-strip">{live ? 'Waiting for the first call…' : 'No calls.'}</div>}
        <Legend origins={present} />
      </section>
      {scoped ? <ScopeBar run={run} scopes={scopeTree} scope={scope} onScope={setScope} /> : null}
      <div className="work">
        <section className="views" aria-label="Views of the run">
          <div className="tabs" role="tablist" aria-label="Views" ref={useActiveTabInView<HTMLDivElement>(v)}>
            {tabs.map(([key, label, count]) => (
              <button key={key} type="button" role="tab" aria-selected={v === key} onClick={() => setView(key)} title={CYCLE_VIEWS.includes(key) ? 'v cycles the views' : undefined}>
                {label}
                {count !== undefined ? <span className="count">{count.toLocaleString('en-US')}</span> : null}
              </button>
            ))}
          </div>
          {v === 'calls' ? <CallsToolbar counts={filterCounts} filter={filter} onFilter={setFilter} text={text} onText={setText} inputRef={filterRef} /> : null}
          {/* Each view starts at its top; Calls centres the selected call. */}
          <div className="vbody" tabIndex={-1} key={v}>
            {v === 'calls' ? <CallsTable calls={visible} asked={asked} selected={selected} scoped={scoped} forkAt={forkMark} lostAt={lostAt} ancestors={ancestors} live={live} canFork={canFork} onSelect={select} onFork={openForkAt} /> : null}
            {v === 'turns' ? <TurnsView calls={scopedCalls} selected={selected} scoped={scoped} onSelect={select} /> : null}
            {v === 'context' ? <ContextView run={run} calls={scopedCalls} selected={selected} onSelect={select} /> : null}
            {v === 'timeline' ? <TimelineView calls={scopedCalls} selected={selected} scoped={scoped} onSelect={select} /> : null}
            {v === 'forks' ? <ForksView runId={runId} /> : null}
            {v === 'provenance' ? <ProvenanceView run={run} selected={selected} /> : null}
          </div>
        </section>
        <Inspector runId={runId} call={selectedRow} calls={calls} models={run.models} detail={detail.data} error={detail.error?.message ?? null} tab={tab} onTab={setTab} onStep={step} change={change} live={live} flag={flagText(run.intervention ?? null)} onSelect={select} />
      </div>
      {actions.dialog}
    </div>
  );
}

