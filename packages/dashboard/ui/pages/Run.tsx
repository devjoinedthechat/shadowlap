import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallDetail, RunDetail } from '../api.js';
import { Legend } from '../components/bits.js';
import { useMenu } from '../components/Popover.js';
import { Page } from '../components/Page.js';
import { Strip, stripDetail, type StripCall } from '../components/Strip.js';
import { callName, shortId } from '../format.js';
import { useLatest, useLoad } from '../hooks.js';
import { countOrigins, presentOrigins } from '../origins.js';
import { indexCalls, needsAncestors, notWaited, type CallIndex } from '../recorded.js';
import { CYCLE_VIEWS, href, nextView, type View } from '../route.js';
import { navigate } from '../router.js';
import { inScope, scopesOf } from '../scopes.js';
import { useApp, type PaletteCommand } from '../state.js';
import { useActionRunner } from '../run/actions.js';
import { CallsTable, CallsToolbar, matchesFilter, type OriginFilter } from '../run/CallsView.js';
import { ContextView } from '../run/ContextView.js';
import { ForksView } from '../run/ForksView.js';
import { Inspector, TABS, type InspectorTab } from '../run/Inspector.js';
import { blameOf, checksOf, forkAtOf, originOf } from '../run/model.js';
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
            {/no run|not part of it|404/.test(loaded.error.message) ? `No run ${id} in this store.` : `Could not load ${id}: ${loaded.error.message}`}{' '}
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
function useChange(run: RunDetail, detail: CallDetail | null, forkAt: number | null): { turn: number; firstAt: number } | null {
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
    for (let i = 0; i < mine.length; i++) if (i >= other.length || JSON.stringify(mine[i]) !== JSON.stringify(other[i])) return { turn: i, firstAt: forkAt };
    return null;
  }, [want, detail, theirs.data, forkAt]);
}

function Workspace({ run, id, call, view }: { run: RunDetail; id: string; call: number | null; view: View | null }) {
  const app = useApp();
  const { client, toast, exported, actionsOff, setRunCommands, runKeys, setPalette } = app;
  const runId = run.run.runId;
  const live = run.run.status === 'running';
  const calls = run.calls;
  const forkAt = forkAtOf(run);
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

  // Recording: the selection follows the newest call if it was on the newest; a toast when it ends.
  const prevLast = useRef(last);
  const prevStatus = useRef(run.run.status);
  useEffect(() => {
    if (live && last !== null && prevLast.current !== null && last !== prevLast.current && selected === prevLast.current) navigate(href.run(runId, last, view), true);
    prevLast.current = last;
    if (prevStatus.current === 'running' && run.run.status !== 'running') toast(`Recording finished · ${shortId(runId)} · ${calls.length} ${calls.length === 1 ? 'call' : 'calls'}`);
    prevStatus.current = run.run.status;
  }, [last, live, selected, runId, view, run.run.status, calls.length, toast]);

  const [scope, setScope] = useState('all');
  const scopes = useMemo(() => scopesOf(calls), [calls]);
  const scoped = scopes.length > 0;
  const scopedCalls = useMemo(() => (scope === 'all' ? calls : calls.filter((c) => inScope(c, scope))), [calls, scope]);
  const [filter, setFilter] = useState<OriginFilter>('all');
  const [text, setText] = useState('');
  const visible = useMemo(() => scopedCalls.filter((c) => matchesFilter(c, filter, text.trim())), [scopedCalls, filter, text]);
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
  const forkMenu = useMenu();
  const actions = useActionRunner(runId);

  const selectedRow = calls.find((c) => c.callNo === selected) ?? null;
  const detailKey = `${runId}:${selected}:${selectedRow?.outcome ?? 'pending'}`;
  const detail = useLoad<CallDetail>(() => (selected !== null && selectedRow ? client.call(runId, selected) : null), detailKey);
  const change = useChange(run, detail.data, forkAt);
  const chain = useAncestors(run);
  const ancestors = useMemo<CallIndex[]>(() => chain.map((d) => indexCalls(d.calls)), [chain]);
  const waited = useMemo(() => (typeof run.notWaitedMs === 'number' ? { ms: run.notWaitedMs, unknown: 0 } : notWaited(calls, ancestors)), [run.notWaitedMs, calls, ancestors]);
  const parent = chain[0] ?? null;
  const rescued = run.rescuedBy ? { callNo: run.rescuedBy.callNo } : parent?.run.meta?.blame?.rescuedRunId === runId && run.run.divergence ? { callNo: run.run.divergence.callNo } : null;

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
  const openForkAt = useCallback(
    (n: number, el: HTMLElement) => {
      if (n !== selected) select(n);
      forkMenu.openAt(el);
    },
    [selected, select, forkMenu],
  );

  // The run's keys, while this page is open.
  const keyState = useLatest({ step, setTab, v, forkAt, lostAt, parentId: run.run.parentRunId, canFork, setView, filterRef });
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
        setTimeout(() => k.filterRef.current?.focus());
        return true;
      }
      return false;
    };
    return () => {
      runKeys.current = null;
    };
  }, [runKeys, keyState, select, forkMenu]);

  // This run, in the palette.
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
    items.push({ group: 'This run', label: 'Provenance', hint: 'the run’s record, call by call', run: () => setView('provenance') });
    if (run.parent) items.push({ group: 'This run', label: 'Compare with parent', hint: shortId(run.parent.runId), run: () => navigate(href.compare(run.parent!.runId, runId)) });
    setRunCommands(items);
  }, [runId, selected, live, exported, actionsOff, canFork, run.parent?.runId]);
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
      <RunHeader run={run} call={detail.data} selected={selected} rescued={!!rescued} forkMenu={forkMenu} onAction={actions.run} />
      <Metrics run={run} notWaitedMs={waited.ms || null} notWaitedUnknown={waited.unknown} />
      <Banner run={run} blame={blame} rescued={rescued} checks={checksOf(run)} showDiff={showDiff} onToggleDiff={() => setShowDiff(!showDiff)} onSelect={select} onAction={actions.run} />
      {showDiff ? <DiffPanel run={run} /> : null}
      <section className="strip">
        {calls.length ? <Strip calls={stripCalls} selected={selected} forkAt={forkAt} lostAt={lostAt} inScope={inScopeFn} live={live} onSelect={select} /> : <div className="cells empty-strip">{live ? 'Waiting for the first call…' : 'No calls.'}</div>}
        <Legend origins={present} />
      </section>
      {scoped ? <ScopeBar run={run} scopes={scopes} scope={scope} onScope={setScope} /> : null}
      <div className="work">
        <section className="views" aria-label="Views of the run">
          <div className="tabs" role="tablist" aria-label="Views">
            {tabs.map(([key, label, count]) => (
              <button key={key} type="button" role="tab" aria-selected={v === key} onClick={() => setView(key)} title={CYCLE_VIEWS.includes(key) ? 'v cycles the views' : undefined}>
                {label}
                {count !== undefined ? <span className="count">{count.toLocaleString('en-US')}</span> : null}
              </button>
            ))}
          </div>
          {v === 'calls' ? <CallsToolbar counts={filterCounts} filter={filter} onFilter={setFilter} text={text} onText={setText} inputRef={filterRef} /> : null}
          <div className="vbody" tabIndex={-1}>
            {v === 'calls' ? <CallsTable calls={visible} selected={selected} scoped={scoped} forkAt={forkAt} lostAt={lostAt} ancestors={ancestors} live={live} canFork={canFork} onSelect={select} onFork={openForkAt} /> : null}
            {v === 'turns' ? <TurnsView calls={scopedCalls} selected={selected} scoped={scoped} onSelect={select} /> : null}
            {v === 'context' ? <ContextView run={run} calls={scopedCalls} selected={selected} onSelect={select} /> : null}
            {v === 'timeline' ? <TimelineView calls={scopedCalls} selected={selected} scoped={scoped} onSelect={select} /> : null}
            {v === 'forks' ? <ForksView runId={runId} /> : null}
            {v === 'provenance' ? <ProvenanceView run={run} /> : null}
          </div>
        </section>
        <Inspector runId={runId} call={selectedRow} detail={detail.data} error={detail.error?.message ?? null} tab={tab} onTab={setTab} onStep={step} change={change} live={live} />
      </div>
      {actions.dialog}
    </div>
  );
}

