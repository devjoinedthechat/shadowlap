import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useChange } from '../components/Conversation.js';
import type { CallDetail, CallRow, RunDetail } from '../api.js';
import { LoadFailed } from '../components/bits.js';
import { Tabs } from '../components/Tabs.js';
import { tipCard, tipText } from '../components/HoverCard.js';
import { useMenu } from '../components/Popover.js';
import { Page } from '../components/Page.js';
import { Unshown } from '../shell/unshown.js';
import { NotFoundPage } from './NotFound.js';
import { sameRun } from '../format.js';
import { runRefresh } from '../connection.js';
import { useActiveTabInView, useLatest, useLoad } from '../hooks.js';
import { mergeRun, settledThrough } from '../live.js';
import { indexCalls, needsAncestors, notWaited, type CallIndex } from '../recorded.js';
import { href, nextView, VIEWS, type View } from '../route.js';
import { setOpenRunAbout } from '../title.js';
import { navigate } from '../router.js';
import { useApp } from '../state.js';
import { useActionRunner } from '../run/actions.js';
import { CallsTable } from '../run/CallsView.js';
import { useCallList } from '../run/call-list.js';
import { onShow } from '../components/OnShow.js';
import { Inspector, TABS, type InspectorTab } from '../run/Inspector.js';
import { flagText } from '../run/banner.js';
import { blameOf, checksOf, forkAtOf, forkMarkOf, withModelNames } from '../run/model.js';
import { InspectorPlace, useFindingPanel, usePickInView } from '../run/InspectorPanel.js';
import { byKind } from '../run/kinds.js';
import { useStripCalls } from '../run/RunStrip.js';
import { StripBar } from '../run/StripKey.js';
import { firstFailedCall } from '../run/open-at.js';
import { useMarkRun, useRunLabels } from '../components/RunKey.js';
import type { RunMark } from '../runkey.js';
import { RunLoading, RunMetrics, ScopeBar, useJudgedAt } from '../run/parts.js';
import { FindingsBar } from '../run/FindingsBar.js';
import { usePagedRun } from '../run/paged-run.js';
import { followPages } from '../run/paging.js';
import { useRunExtras } from '../run/run-extras.js';
import { useRunSelection } from '../run/run-selection.js';
import { useRunCommands } from '../run/run-commands.js';
import { useWholeStep } from '../run/NextStepButton.js';
import { RunHeader } from '../run/RunHeader.js';
import { useRunKeys } from '../run/run-keys.js';
import { shortcut } from '../shortcuts.js';
import { lastRunsHref } from '../runs-view.js';

/**
 * A run: its header and numbers, a banner for how it forked, where it was lost or that it is
 * recording, the strip of every call, scopes, the five views, Provenance and Decisions, and the inspector. The
 * URL holds the call and the view; a run still recording grows as calls arrive.
 */

/**
 * The views but Calls, by the view each draws, each in a script of its own that loads the first time
 * it shows (`onShow`). None loads as the page opens, so opening a run loads the page's own code
 * alone (test/ui-bundle-size.test.ts). Every one of them loads once the pointer or the focus reaches
 * the Views tabs, or the view first changes (`warmViews`), so a switch to one draws it at once. One
 * whose code didn't come says so in the view, with Retry.
 */
const VIEW_OPTIONS = { failed: <LoadFailed what="view" /> };
export const VIEW_PARTS = {
  turns: onShow(() => import('../run/TurnsView.js').then((m) => m.TurnsView), VIEW_OPTIONS),
  context: onShow(() => import('../run/ContextView.js').then((m) => m.ContextView), VIEW_OPTIONS),
  timeline: onShow(() => import('../run/TimelineView.js').then((m) => m.TimelineView), VIEW_OPTIONS),
  forks: onShow(() => import('../run/ForksView.js').then((m) => m.ForksView), VIEW_OPTIONS),
  provenance: onShow(() => import('../run/ProvenanceView.js').then((m) => m.ProvenanceView), VIEW_OPTIONS),
  decisions: onShow(() => import('../run/DecisionsView.js').then((m) => m.DecisionsView), VIEW_OPTIONS),
} satisfies Record<Exclude<View, 'calls'>, unknown>;
const { turns: TurnsView, context: ContextView, timeline: TimelineView, forks: ForksView, provenance: ProvenanceView, decisions: DecisionsView } = VIEW_PARTS;

function warmViews(): void {
  for (const part of Object.values(VIEW_PARTS)) part.preload();
}

let lastTab: InspectorTab = 'conversation';

const VIEW_NAMES: Readonly<Record<View, string>> = { calls: 'Calls', turns: 'Turns', context: 'Context', timeline: 'Timeline', forks: 'Forks', provenance: 'Provenance', decisions: 'Decisions' };

/** The call `n` jumps to where it is the fork or the lost call, and the card on the banner's call that shows it. */
function jumpOf(forkAt: number | null, lostAt: number | null): { n: number; card: string } | null {
  if (forkAt !== null) return { n: forkAt, card: 'Jump to fork' };
  return lostAt !== null ? { n: lostAt, card: 'Jump to lost call' } : null;
}

/** The Views tabs: `v`'s key on the tab it shows next, whose card names it, and Provenance's card, its name over what it holds. */
function viewTabs(v: View, calls: number, turns: number | undefined) {
  const next = nextView(v);
  return VIEWS.map((key) => {
    const mark = key === next ? shortcut('view') : undefined;
    const tip = key === 'provenance' ? tipCard(VIEW_NAMES[key], [], 'The run’s record: what made it, where it came from, what a copy would mask, and each call’s fingerprint.') : mark?.['aria-keyshortcuts'] ? tipText(VIEW_NAMES[key]) : undefined;
    return { key, label: VIEW_NAMES[key], count: key === 'calls' ? calls : key === 'turns' ? turns : undefined, tip, mark };
  });
}

/** The view shown: Calls as the page draws it (`children`), every other one from its part. */
function ViewSwitch({ v, run, calls, selected, scoped, byKind: kinds, onSelect, children }: { v: View; run: RunDetail; calls: CallRow[]; selected: number | null; scoped: boolean; byKind: boolean; onSelect: (n: number) => void; children: ReactNode }) {
  switch (v) {
    case 'calls':
      return children;
    case 'turns':
      return <TurnsView calls={calls} selected={selected} scoped={scoped} onSelect={onSelect} />;
    case 'context':
      return <ContextView run={run} calls={calls} selected={selected} onSelect={onSelect} />;
    case 'timeline':
      return <TimelineView calls={calls} selected={selected} scoped={scoped} byKind={kinds} onSelect={onSelect} />;
    case 'forks':
      return <ForksView runId={run.run.runId} />;
    case 'provenance':
      return <ProvenanceView run={run} selected={selected} />;
    case 'decisions':
      return <DecisionsView runId={run.run.runId} selected={selected} onSelect={onSelect} />;
  }
}

/**
 * The views that may hold nothing that takes the focus, which take it themselves, to be scrolled by
 * keyboard. Calls is one: its only stops, the selected call's fork button and the fold marks, go with
 * a filter that leaves the call out, a run that can't fork, or a scroll that takes its row from the window.
 */
const PANE_VIEWS: readonly View[] = ['calls', 'timeline', 'turns', 'context'];

export function RunPage({ id, call, view }: { id: string; call: number | null; view: View | null }) {
  const { client, runsTick, live } = useApp();
  // Opened by a short id, the page settles on the full one (the workspace rewrites the URL). That is
  // the run already loaded: the load keeps the id the page opened with, and asks by the full id from
  // then on, so the run and everything on its page aren't loaded a second time.
  const opened = useRef<{ key: string; runId: string | null }>({ key: id, runId: null });
  if (id !== opened.current.key && id !== opened.current.runId) opened.current = { key: id, runId: null };
  // Loaded again when runs move (this one may have ended or changed), and while it records, when its
  // own calls do: another run recording asks this page for nothing.
  const recording = live.find((l) => (opened.current.runId ? l.runId === opened.current.runId : sameRun(opened.current.key, l.runId))) ?? null;
  // What the page has: a recording it follows whole asks only for the calls after those that won't
  // change, and so does the run once it has ended: its end is merged in, where reading it again from
  // its first page left the page on that page's last call (#200 of 20,124) and read every call again.
  // A recording too long for one page is paged as a run that has ended is (usePagedRun): read whole
  // before it showed, every poll started the read again, and a recording of 60,000 calls showed no
  // row until it ended, after 3,500 pages (800 MB). As it grows, its count comes with the poll and
  // its calls a page at a time; its page, which works out the whole run (0.8 s at 60,000 calls), is
  // asked again no sooner than ten times as long as it took, and at once when it ends.
  const had = useRef<{ key: string; run: RunDetail; part: RunDetail | null } | null>(null);
  const pageAsked = useRef({ at: 0, took: 0 });
  const loaded = useLoad(
    () => {
      const key = opened.current.key;
      const asked = opened.current.runId ?? key;
      const prev = had.current?.key === key ? had.current : null;
      const whole = !!prev && prev.run.callsNext === null && prev.run.calls.length >= prev.run.callsTotal && (prev.run.run.status === 'running' || prev.part !== null);
      const paged = !!prev && !whole && prev.run.run.status === 'running' && recording !== null && prev.run.run.runId === recording.runId;
      if (paged && Date.now() - pageAsked.current.at < Math.max(RUN_PAGE_EVERY_MS, pageAsked.current.took * 10)) return Promise.resolve(grown(prev.run, recording.calls));
      if (!prev || !whole || (recording !== null && prev.run.run.runId !== recording.runId)) {
        const t0 = Date.now();
        return client.run(asked).then((d) => {
          pageAsked.current = { at: Date.now(), took: Date.now() - t0 };
          return d;
        });
      }
      return client.run(asked, settledThrough(prev.run.calls)).then(async (part) => {
        // The same answer again (a 304): the page as it was, so nothing redraws.
        if (part === prev.part) return prev.run;
        const merged = mergeRun(prev.run, part);
        const run = merged.callsNext !== null ? await followPages(client, merged) : merged;
        had.current = { key, run, part };
        return run;
      });
    },
    opened.current.key,
    runRefresh(runsTick, recording),
  );
  const run = loaded.data;
  if (run && had.current?.run !== run) had.current = { key: opened.current.key, run, part: null };
  if (run && opened.current.runId === null && sameRun(opened.current.key, run.run.runId)) opened.current.runId = run.run.runId;
  if (!run) {
    if (loaded.error) {
      const several = /matches several runs/.test(loaded.error.message);
      // A run that isn't there: the crumbs and the tab's title name only Runs (Unshown).
      const missing = !several && /no run|not part of it|404/.test(loaded.error.message);
      if (missing && client.exported)
        return (
          <>
            <Unshown at={`run:${id}`} />
            <NotFoundPage header what={`No run ${id} in this copy.`} back={[lastRunsHref(), 'Open Runs']} />
          </>
        );
      return (
        <Page>
          {missing ? <Unshown at={`run:${id}`} /> : null}
          <div className="empty tall">
            {several ? `${id} matches several runs; use more of the id.` : missing ? `No run ${id} in this store.` : `Could not load ${id}: ${loaded.error.message}`}{' '}
            <a className="more" href={lastRunsHref()}>
              Back to Runs
            </a>
          </div>
        </Page>
      );
    }
    return <RunLoading />;
  }
  return <Workspace run={run} id={id} call={call} view={view} />;
}

/** At least this long between two asks of a long recording's page: its calls come between them a page at a time. */
const RUN_PAGE_EVERY_MS = 2000;

/** A long recording's page with the count the poll says: the calls after those it had are read as they come (usePagedRun). */
function grown(run: RunDetail, calls: number): RunDetail {
  return calls > run.callsTotal ? { ...run, callsTotal: calls } : run;
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

/** What changed a run's conversation: a fork, or a test's replay that diverged, which changed its request without forking (the message says "this replay"). */
const changedBy = (run: RunDetail): 'fork' | 'replay' => (run.run.meta?.test ? 'replay' : 'fork');

function Workspace({ run: answered, id, call, view }: { run: RunDetail; id: string; call: number | null; view: View | null }) {
  const app = useApp();
  // A long run's calls come a page at a time (paging.ts): `run` holds those read so far, its next step whole once that is known.
  const { run: paged, paging } = usePagedRun(app.client, answered);
  const run = useWholeStep(paged);
  // The tab's title reads the run's about line from the run as this page read it: the run list has no attempts.
  // Told again when a page of calls brings the run anew: unchanged, it changes nothing.
  useEffect(() => {
    setOpenRunAbout(run.run.runId, run.about ?? null);
  }, [run.run.runId, run.about]);
  useEffect(() => () => setOpenRunAbout(null), []);
  const { client, exported, actionsOff, runKeys } = app;
  const runId = run.run.runId;
  const live = run.run.status === 'running';
  // Each model named as the page names it everywhere: claude-opus-5, not opus-5 here and the full id there.
  const calls = useMemo(() => withModelNames(run.calls, run.models), [run.calls, run.models]);
  const forkAt = forkAtOf(run);
  // Flagged FORK on the strip and in Calls: not where a test replay diverged offline, which failed there.
  const forkMark = forkMarkOf(run);
  const blame = useMemo(() => blameOf(run), [run]);
  const lostAt = blame?.callNo ?? null;
  // A failed run opens where it first failed, every call's origin read while a long run's pages come;
  // clock and random reads are never where a run opens (open-at.ts).
  const failedAt = useMemo(() => ((run.state?.failed ?? run.run.status === 'failed') ? firstFailedCall(calls, paging?.origins ?? null) : null), [run.state?.failed, run.run.status, calls, paging?.origins]);
  // Its verdict by checks, which a long run's analysis may give after its first answer: its first fact and findings say it.
  const { judged, outcomeAt } = useJudgedAt(run);
  // The call the page shows, the address and the session's memory kept in step with it (run-selection.ts).
  const selected = useRunSelection({ run, id, call, view, calls, paging, forkAt, lostAt, outcomeAt });
  const v: View = view ?? 'calls';
  const need = paging?.need ?? null;
  // The calls as Calls lists them: the scope, the filter, the groups and what is folded (call-list.ts).
  // A recording's or a capture's strip, key and filter go by what each call was; every other run's by origin (kinds.ts).
  const kinds = useMemo(() => byKind(run), [run]);
  const { scope, setScope, scopeTree, scoped, scopedCalls, filter, setFilter, text, setText, asked, listed, tree, folded, fold, visible, counts } = useCallList({ runId, calls, paging, selected, byKind: kinds });
  const [tab, setTabState] = useState<InspectorTab>(lastTab);
  const setTab = (t: InspectorTab) => {
    lastTab = t;
    setTabState(t);
  };
  // A finding's diff in the inspector's place, until it is hidden or a call is picked (InspectorPanel.tsx).
  const { panel, showDiff, onToggleDiff, close: closePanel } = useFindingPanel(runId);
  const filterRef = useRef<HTMLInputElement>(null);
  // `/` filters the calls: from another view it opens Calls first, and the field takes focus once it is there.
  const [filterWanted, setFilterWanted] = useState(false);
  useEffect(() => {
    if (!filterWanted || (view ?? 'calls') !== 'calls') return;
    filterRef.current?.focus();
    setFilterWanted(false);
  }, [filterWanted, view]);
  const forkMenu = useMenu();
  // What the page reads beside the run once it has ended: its offers, a preset's attempt, its notes and the
  // fork that rescued it (run-extras.ts).
  const chain = useAncestors(run);
  const { offers, preset, notes, rescued } = useRunExtras(run, chain[0] ?? null, forkAt);
  const actions = useActionRunner(runId, !!run.source, offers, run.forkAt);
  // The run's labels, and the good/bad key's press (+ and - from the keyboard too).
  const [labels, setLabels] = useRunLabels(runId, run.run.meta?.labels);
  const markRun = useMarkRun(useCallback((_id: string, next: string[]) => setLabels(next), [setLabels]));
  const canMark = !exported && !actionsOff;
  const mark = useCallback((m: RunMark, from?: HTMLElement) => markRun(runId, labels, m, from), [markRun, runId, labels]);

  const selectedRow = calls.find((c) => c.callNo === selected) ?? null;
  const detailKey = `${runId}:${String(selected)}:${selectedRow?.outcome ?? 'pending'}`;
  const quick = useLoad<CallDetail>(() => (selected !== null && selectedRow ? client.call(runId, selected) : null), detailKey);
  // Deep in a long run still analysed, the details come at once from the calls around the call, its
  // conversation's number left out; asked again, they wait for the analysis and take their place.
  const whole = useLoad<CallDetail>(() => (selected !== null && quick.data?.around ? client.call(runId, selected, { whole: true }) : null), `${detailKey}:whole:${quick.data?.around ? 'part' : ''}`);
  const detail = whole.data ? whole : quick;
  const change = useChange({ parent: run.run.parentRunId, forkAt, detail: detail.data, by: changedBy(run) });
  const ancestors = useMemo<CallIndex[]>(() => chain.map((d) => indexCalls(d.calls)), [chain]);
  const waited = useMemo(() => (typeof run.notWaitedMs === 'number' ? { ms: run.notWaitedMs, unknown: 0 } : notWaited(calls, ancestors)), [run.notWaitedMs, calls, ancestors]);

  const select = useCallback((n: number) => (closePanel(), navigate(href.run(runId, n, v), true)), [runId, v, closePanel]);
  // A row picked below 1160px brings the inspector, under the calls, into view.
  const pickRow = usePickInView(select, selected, detail);
  const setView = (next: View) => (warmViews(), navigate(href.run(runId, selected, next), true));
  // A pick in the key, or a word typed in Filter calls, shows Calls from another view.
  const toCalls = () => (v === 'calls' ? undefined : setView('calls'));
  const listFor = useCallback(() => (v === 'calls' ? visible : scopedCalls), [v, visible, scopedCalls]);
  const step = useCallback(
    (delta: number): number | null => {
      const list = listFor();
      if (!list.length) return null;
      const i = list.findIndex((c) => c.callNo === selected);
      const next = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + delta))];
      if (next) select(next.callNo);
      return next?.callNo ?? null;
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
  useRunKeys(runKeys, { runId, v, selected, step, setTab: (n) => setTab(TABS[n]!), select, setView, setFilterWanted, forkAt, lostAt, failedAt, parentId: run.run.parentRunId, canMark, mark: (m) => mark(m), tree, folded, listed, fold, runs: app.runs, toast: app.toast });

  // This run, in the palette.
  useRunCommands({ run, selected, canFork, canMark, labels, mark, offers, judged, actions, forkMenu, setView });

  const stripCalls = useStripCalls(calls, paging?.origins, paging?.kinds);
  const inScopeFn = useMemo(() => {
    if (scope === 'all') return null;
    const ids = new Set(scopedCalls.map((c) => c.callNo));
    return (n: number) => ids.has(n);
  }, [scope, scopedCalls]);

  // While the pages come, Calls counts the run's calls and Turns says nothing until they are all read.
  const tabs = viewTabs(v, paging && scope === 'all' ? paging.total : scopedCalls.length, paging ? undefined : scopedCalls.filter((c) => c.kind === 'api').length);

  return (
    <div className="rv">
      <RunHeader run={run} call={detail.data} selected={selected} rescued={!!rescued} offers={offers} forkMenu={forkMenu} onAction={actions.run} onFindCommit={actions.findCommit} preset={preset} labels={labels} setLabels={setLabels} onMark={mark} facts={<RunMetrics run={run} judged={judged} notWaitedMs={waited.ms || null} notWaitedUnknown={waited.unknown} preset={preset} rescued={!!rescued} />} judged={judged} />
      <FindingsBar run={run} judged={judged} blame={blame} rescued={rescued} checks={checksOf(run)} offers={offers} showDiff={showDiff} onToggleDiff={onToggleDiff} onSelect={select} onAction={actions.run} preset={preset} jump={jumpOf(forkAt, lostAt)} notes={notes} />
      <StripBar strip={{ calls: stripCalls, byKind: kinds, selected, forkAt: forkMark, lostAt, inScope: inScopeFn, live, onSelect: select }} counts={counts} filter={filter} onFilter={setFilter} text={text} onText={setText} inputRef={filterRef} toCalls={toCalls} />
      {scoped ? <ScopeBar run={run} scopes={scopeTree} scope={scope} onScope={setScope} /> : null}
      <div className="work">
        <section className="views" aria-label="Views of the run">
          <Tabs label="Views" idPrefix="vtab" panelId="vbody" items={tabs} value={v} onChange={setView} listRef={useActiveTabInView<HTMLDivElement>(v)} onPointerEnter={warmViews} onFocus={warmViews} />
          {paging ? (
            <div className="toolbar muted" role="status">
              {paging.gone
                ? `${paging.read.toLocaleString('en-US')} of ${paging.total.toLocaleString('en-US')} calls read; the run is no longer in ${client.exported ? 'this copy' : 'this store'}.`
                : paging.error
                ? `${paging.read.toLocaleString('en-US')} of ${paging.total.toLocaleString('en-US')} calls read; the next page could not be read (${paging.error}). It is tried again in a moment, or at once when you pick a call.`
                : `${paging.read.toLocaleString('en-US')} of ${paging.total.toLocaleString('en-US')} calls read so far; the rest are on their way.${text.trim() || scope !== 'all' || v !== 'calls' ? ' What shows is from those read.' : ''}`}
            </div>
          ) : null}
          {/* Each view starts at its top; Calls centres the selected call. Calls, the Timeline, the Turns
              of a run whose model called no tool and Context may hold nothing that takes the focus, so
              the view takes it itself, to be scrolled by keyboard. */}
          <div className="vbody" id="vbody" key={v} role="tabpanel" aria-labelledby={`vtab-${v}`} tabIndex={PANE_VIEWS.includes(v) ? 0 : -1}>
            <ViewSwitch v={v} run={run} calls={scopedCalls} selected={selected} scoped={scoped} byKind={kinds} onSelect={select}>
              <CallsTable calls={visible} asked={asked} selected={selected} scoped={scoped} forkAt={forkMark} lostAt={lostAt} ancestors={ancestors} live={live} canFork={canFork} onSelect={pickRow} onFork={openForkAt} onNeed={need} tree={tree} folded={folded} onFold={fold} />
            </ViewSwitch>
          </div>
        </section>
        <InspectorPlace panel={panel} run={run} test={offers?.test ?? null} onClose={closePanel} onPick={select}>
          <Inspector runId={runId} call={selectedRow} calls={calls} models={run.models} detail={detail.data} error={detail.error?.message ?? null} tab={tab} onTab={setTab} onStep={step} change={change} live={live} flag={flagText(run.intervention ?? null)} onSelect={select} />
        </InspectorPlace>
      </div>
      {actions.dialog}
    </div>
  );
}

