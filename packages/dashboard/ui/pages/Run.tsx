import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JOB_KINDS, type CallDetail, type RunDetail } from '../api.js';
import { Legend, LoadFailed } from '../components/bits.js';
import { useMenu } from '../components/Popover.js';
import { Page } from '../components/Page.js';
import { Strip, stripDetail, type StripCall } from '../components/Strip.js';
import { callName, sameRun, shortId } from '../format.js';
import { runRefresh } from '../connection.js';
import { useActiveTabInView, useLatest, useLoad } from '../hooks.js';
import { followNewest, mergeRun, settledThrough } from '../live.js';
import { countOrigins, presentOrigins } from '../origins.js';
import { indexCalls, needsAncestors, notWaited, type CallIndex } from '../recorded.js';
import { CYCLE_VIEWS, href, nextView, type View } from '../route.js';
import { setOpenRunAbout } from '../title.js';
import { navigate } from '../router.js';
import { inScope, scopeChips, scopesOf } from '../scopes.js';
import { useApp, type PaletteCommand } from '../state.js';
import { useActionRunner } from '../run/actions.js';
import { CallsTable, CallsToolbar, matchesFilter, pendingMatches, type OriginFilter } from '../run/CallsView.js';
import { onShow } from '../components/OnShow.js';
import { ForkDifferences } from '../run/ForkDifferences.js';
import { Inspector, TABS, type InspectorTab } from '../run/Inspector.js';
import { flagText } from '../run/banner.js';
import { askedTools } from '../run/calls.js';
import { bisectLabel } from '../run/offers.js';
import { presetAttempt } from '../run/preset.js';
import { blameOf, checksOf, forkAtOf, forkMarkOf, originOf, withModelNames } from '../run/model.js';
import { firstFailedCall, openingCall } from '../run/open-at.js';
import { ancestorsOf, callTree, heads, unfolded } from '../run/groups.js';
import { useMarkRun, useRunLabels } from '../components/RunKey.js';
import { markKey, MARKS, type RunMark } from '../runkey.js';
import { Banner, DiffPanel, Metrics, RunLoading, ScopeBar } from '../run/parts.js';
import { usePagedRun } from '../run/paged-run.js';
import { followPages, isPending, listedCalls, type ListedCall } from '../run/paging.js';
import { runNotes } from '../run/notes.js';
import { RunNotes } from '../run/RunNotes.js';
import { RunHeader } from '../run/RunHeader.js';
import { ACTIONS } from '../labels.js';

/**
 * A run: its header and numbers, a banner for how it forked, where it was lost or that it is
 * recording, the strip of every call, scopes, the five views and Provenance, and the inspector. The
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
} satisfies Record<Exclude<View, 'calls'>, unknown>;
const { turns: TurnsView, context: ContextView, timeline: TimelineView, forks: ForksView, provenance: ProvenanceView } = VIEW_PARTS;

function warmViews(): void {
  for (const part of Object.values(VIEW_PARTS)) part.preload();
}

let lastTab: InspectorTab = 'conversation';

/** No group folded. */
const NO_FOLDS: ReadonlySet<number> = new Set();

/** The views that may hold nothing that takes the focus, which take it themselves, by what each shows. */
const PANE_NAMES: Partial<Record<View, string>> = { timeline: 'Timeline of the calls', turns: 'Turns of the conversation', context: 'Context of each model call' };

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
    if (loaded.error)
      return (
        <Page>
          <div className="empty tall">
            {/matches several runs/.test(loaded.error.message) ? `${id} matches several runs; use more of the id.` : /no run|not part of it|404/.test(loaded.error.message) ? `No run ${id} in ${client.exported ? 'this copy' : 'this store'}.` : `Could not load ${id}: ${loaded.error.message}`}{' '}
            <a className="more" href={href.runs()}>
              Back to Runs
            </a>
          </div>
        </Page>
      );
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

function Workspace({ run: answered, id, call, view }: { run: RunDetail; id: string; call: number | null; view: View | null }) {
  const app = useApp();
  // A long run's calls come a page at a time (paging.ts): `run` holds those read so far.
  const { run, paging } = usePagedRun(app.client, answered);
  // The tab's title reads the run's about line from the run as this page read it: the run list has no attempts.
  // Told again when a page of calls brings the run anew: unchanged, it changes nothing.
  useEffect(() => {
    setOpenRunAbout(run.run.runId, run.about ?? null);
  }, [run.run.runId, run.about]);
  useEffect(() => () => setOpenRunAbout(null), []);
  const { client, exported, actionsOff, setRunCommands, runKeys, runsTick } = app;
  const runId = run.run.runId;
  const live = run.run.status === 'running';
  // Each model named as the page names it everywhere: claude-opus-5, not opus-5 here and the full id there.
  const calls = useMemo(() => withModelNames(run.calls, run.models), [run.calls, run.models]);
  const forkAt = forkAtOf(run);
  // Flagged FORK on the strip and in Calls: not where a test replay diverged offline, which failed there.
  const forkMark = forkMarkOf(run);
  const blame = useMemo(() => blameOf(run), [run]);
  const lostAt = blame?.callNo ?? null;
  // The newest call: the last of the run's count while its pages come, never the last read.
  const last = paging ? paging.total : calls.length ? calls[calls.length - 1]!.callNo : null;
  // A failed run opens where it first failed, every call's origin read while a long run's pages come;
  // clock and random reads are never where a run opens (open-at.ts).
  const failed = run.state?.failed ?? run.run.status === 'failed';
  const failedAt = useMemo(() => (failed ? firstFailedCall(calls, paging?.origins ?? null) : null), [failed, calls, paging?.origins]);
  const fallback = useMemo(() => openingCall({ forkAt, lostAt, live, failed, calls, origins: paging?.origins ?? null, total: paging?.total ?? null }), [forkAt, lostAt, live, failed, calls, paging?.origins, paging?.total]);
  // While its pages come, a call of the run is one numbered up to its count, read yet or not.
  const isCall = (n: number) => (paging ? n >= 1 && n <= paging.total : calls.some((c) => c.callNo === n));
  const selected = call !== null && isCall(call) ? call : call !== null && live ? call : fallback;
  const v: View = view ?? 'calls';
  // The page that holds the selected call, read before the others.
  const need = paging?.need ?? null;
  useEffect(() => {
    if (need && selected !== null) need(selected, { pick: true });
  }, [need, selected]);

  // A short id settles on the full one; a run opened without a call lands on its fork, its lost call,
  // where it first failed, or its first call (openingCall).
  useEffect(() => {
    if (runId !== id || (call === null && selected !== null)) navigate(href.run(runId, call ?? selected, view), true);
  }, [runId, id, call, selected, view]);

  // Recording: the selection follows the newest call if it was on the newest (also when the last calls
  // and the end of the recording arrive together). The shell says when it ends, on any page (state.tsx).
  const prevLast = useRef(last);
  const prevStatus = useRef(run.run.status);
  useEffect(() => {
    const next = followNewest({ wasStatus: prevStatus.current, status: run.run.status, prevLast: prevLast.current, last, selected });
    if (next !== null) navigate(href.run(runId, next, view), true);
    prevLast.current = last;
    prevStatus.current = run.run.status;
  }, [last, selected, runId, view, run.run.status]);

  const [scope, setScope] = useState('all');
  const scopes = useMemo(() => scopesOf(calls), [calls]);
  const scopeTree = useMemo(() => scopeChips(calls), [calls]);
  const scoped = scopes.length > 0;
  const scopedCalls = useMemo(() => (scope === 'all' ? calls : calls.filter((c) => inScope(c, scope))), [calls, scope]);
  const [filter, setFilter] = useState<OriginFilter>('all');
  const [text, setText] = useState('');
  // The tools each model call asked for, when the server says which call asked for each tool call.
  const asked = useMemo(() => (calls.some((c) => c.kind === 'tool' && c.requestedBy !== undefined) ? askedTools(calls) : null), [calls]);
  // Every call while the pages come, a placeholder for each not read yet; within a scope, those read.
  const listed = useMemo<readonly ListedCall[]>(() => (paging && scope === 'all' ? listedCalls(calls, paging.total, paging.origins) : scopedCalls), [paging, scope, calls, scopedCalls]);
  // Light grouping (groups.ts): each call under the call it belongs to, folded where the reader folded
  // it; a filter lists what it matches flat, since the calls it leaves out are what the groups hang on.
  const filtering = filter !== 'all' || !!text.trim();
  const tree = useMemo(() => (filtering ? null : callTree(listed)), [filtering, listed]);
  const [foldedBy, setFoldedBy] = useState<{ runId: string; set: ReadonlySet<number> }>({ runId, set: NO_FOLDS });
  const folded = foldedBy.runId === runId ? foldedBy.set : NO_FOLDS;
  const setFolded = useCallback((next: ReadonlySet<number>) => setFoldedBy({ runId, set: next }), [runId]);
  const fold = useCallback((callNo: number) => {
    const next = new Set(folded);
    if (!next.delete(callNo)) next.add(callNo);
    setFolded(next);
  }, [folded, setFolded]);
  const shown = useMemo(() => (tree && folded.size ? unfolded(listed, tree, folded) : listed), [tree, folded, listed]);
  const visible = useMemo(() => (filtering ? listed.filter((c) => (isPending(c) ? pendingMatches(c, filter, text.trim()) : matchesFilter(c, filter, text.trim(), c.kind === 'api' && asked ? (asked.get(c.callNo) ?? null) : undefined))) : shown), [filtering, listed, shown, filter, text, asked]);
  // Fold all, and once anything is folded, Unfold all (the selected call's groups stay open, so not every group can be folded).
  const foldAll = useMemo(() => (tree?.grouped ? { all: folded.size > 0, onAll: (on: boolean) => setFolded(on ? new Set(heads(listed, tree)) : NO_FOLDS) } : null), [tree, listed, folded, setFolded]);
  // The selected call is always in view: the groups it sits in, folded, open again (j and k step over a folded group's calls).
  useEffect(() => {
    if (!tree || selected === null || !folded.size) return;
    const over = ancestorsOf(tree, selected).filter((h) => folded.has(h));
    if (!over.length) return;
    const next = new Set(folded);
    for (const h of over) next.delete(h);
    setFolded(next);
  }, [tree, selected, folded, setFolded]);
  const filterCounts = useMemo(() => {
    // Every call's origin from the run's page while the pages come.
    const all = paging?.origins && scope === 'all' ? paging.origins : null;
    const n = countOrigins(all ?? scopedCalls.map(originOf));
    return { all: all ? all.length : scopedCalls.length, live: n.live, rep: n.rep, over: n.over, inject: n.inject, fail: n.fail, block: n.block + n.stub } satisfies Record<OriginFilter, number>;
  }, [scopedCalls, paging?.origins, scope]);
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
  // What the page offers beyond the run's record: Share's counts, Push, Run blame, Find breaking commit.
  // None of it applies while the run records, so it is asked for once it has ended, and again as runs change.
  const offers = useLoad(() => (exported || live ? null : client.offers(runId)), `${runId}:offers:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data ?? null;
  const actions = useActionRunner(runId, !!run.source, offers);
  // The run's labels, and the good/bad key's press (+ and - from the keyboard too).
  const [labels, setLabels] = useRunLabels(runId, run.run.meta?.labels);
  const markRun = useMarkRun(useCallback((_id: string, next: string[]) => setLabels(next), [setLabels]));
  const canMark = !exported && !actionsOff;
  const mark = useCallback((m: RunMark, from?: HTMLElement) => markRun(runId, labels, m, from), [markRun, runId, labels]);
  // An error-path preset's attempt: the preset it played in and its verdict, from the presets of the session that decided it.
  const presets = useLoad(() => (run.run.meta?.chaos && !live ? client.runChaos(runId) : null), `${runId}:presets`, live ? 0 : runsTick).data ?? null;
  const preset = useMemo(() => presetAttempt(presets, run.run.runId), [presets, run.run.runId]);
  // What the run did that Shadowlap did not record, or answered as it went (notes.ts): the tools the
  // model called that it never recorded are read beside the server once the run has ended.
  const unrecorded = useLoad(() => (live ? null : client.unrecorded(runId)), `${runId}:unrecorded:${live ? 'live' : 'ended'}`, live ? 0 : runsTick).data ?? null;
  const notes = useMemo(() => runNotes({ unrecorded, preloads: run.run.meta?.preloads ?? null, websockets: run.websockets ?? null, extraReads: run.summary.extraReads ?? null, mode: run.run.mode }), [unrecorded, run.run.meta?.preloads, run.websockets, run.summary.extraReads, run.run.mode]);

  const selectedRow = calls.find((c) => c.callNo === selected) ?? null;
  const detailKey = `${runId}:${String(selected)}:${selectedRow?.outcome ?? 'pending'}`;
  const quick = useLoad<CallDetail>(() => (selected !== null && selectedRow ? client.call(runId, selected) : null), detailKey);
  // Deep in a long run still analysed, the details come at once from the calls around the call, its
  // conversation's number left out; asked again, they wait for the analysis and take their place.
  const whole = useLoad<CallDetail>(() => (selected !== null && quick.data?.around ? client.call(runId, selected, { whole: true }) : null), `${detailKey}:whole:${quick.data?.around ? 'part' : ''}`);
  const detail = whole.data ? whole : quick;
  const change = useChange(run, detail.data, forkAt);
  const chain = useAncestors(run);
  const ancestors = useMemo<CallIndex[]>(() => chain.map((d) => indexCalls(d.calls)), [chain]);
  const waited = useMemo(() => (typeof run.notWaitedMs === 'number' ? { ms: run.notWaitedMs, unknown: 0 } : notWaited(calls, ancestors)), [run.notWaitedMs, calls, ancestors]);
  const parent = chain[0] ?? null;
  const rescued: { callNo: number | null } | null = run.rescuedBy ? { callNo: run.rescuedBy.callNo ?? forkAt } : parent?.run.meta?.blame?.rescuedRunId === runId && run.run.divergence ? { callNo: run.run.divergence.callNo } : null;

  const select = useCallback((n: number) => navigate(href.run(runId, n, v), true), [runId, v]);
  const setView = (next: View) => (warmViews(), navigate(href.run(runId, selected, next), true));
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
  /** ← and → on the selected call in Calls; false when there is nothing to fold, open or go to. */
  const foldKey = (open: boolean): boolean => {
    if (!tree || selected === null) return false;
    const i = tree.index.get(selected);
    if (i === undefined) return false;
    const isHead = tree.kids[i]! > 0;
    if (!open) {
      if (isHead && !folded.has(selected)) return fold(selected), true;
      const up = tree.parent.get(selected);
      return up !== undefined ? (select(up), true) : false;
    }
    if (isHead && folded.has(selected)) return fold(selected), true;
    const next = isHead ? listed[i + 1] : undefined;
    return next ? (select(next.callNo), true) : false;
  };
  const keyState = useLatest({ step, setTab, v, forkAt, lostAt, failedAt, parentId: run.run.parentRunId, canFork, setView, setFilterWanted, canMark, mark, tree, foldKey });
  useEffect(() => {
    runKeys.current = (e) => {
      const k = keyState.current;
      if (e.key === 'j' || e.key === 'ArrowDown') return k.step(1), true;
      if (e.key === 'k' || e.key === 'ArrowUp') return k.step(-1), true;
      if (/^[1-4]$/.test(e.key)) return k.setTab(TABS[Number(e.key) - 1]!), true;
      // The call that needs a look: where it forked, where blame found it lost, else where it first failed.
      const at = k.forkAt ?? k.lostAt ?? k.failedAt;
      if (e.key === 'n' && at !== null) return select(at), true;
      if (e.key === 'p' && k.parentId) return navigate(href.run(k.parentId)), true;
      if (e.key === 'v') return k.setView(nextView(k.v)), true;
      // The good/bad key: + good, - bad, again to take it off.
      const m = markKey(e.key);
      if (m && k.canMark) return k.mark(m), true;
      // In Calls, as in a tree: ← folds the selected call's group, or goes to the call it sits under; → opens it, or goes to its first call.
      if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && k.v === 'calls' && k.tree) return k.foldKey(e.key === 'ArrowRight');
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
    if (!exported && !actionsOff && replay && !live) items.push({ group: 'This run', label: ACTIONS.replay.label, hint: `shadowlap replay ${shortId(runId)}`, job: true, run: () => actions.run({ action: replay, callNo: null }) });
    if (canFork && selected !== null)
      items.push({
        group: 'This run',
        label: `Fork at #${selected}…`,
        hint: 'inject, override, fail, switch model',
        job: true,
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
        job: true,
        run: () => {
          const btn = document.querySelector<HTMLElement>('.rhead .actions [aria-haspopup="menu"]');
          if (btn) setTimeout(() => btn.click());
        },
      });
    if (!exported && !actionsOff && !live && !run.source && app.hasKind(JOB_KINDS.bisect)) items.push({ group: 'This run', label: bisectLabel(offers?.bisect).label, hint: 'shadowlap bisect', job: true, run: () => findCommit.current() });
    // The good/bad key: what repair keeps working, and what it fixes.
    if (canMark)
      for (const m of MARKS) {
        const on = labels.includes(m);
        items.push({ group: 'This run', label: on ? `Take off ${m}` : `Label it ${m}`, hint: m === 'good' ? '+ · repair --keeps label:good' : '- · repair --fixes label:bad', run: () => mark(m) });
      }
    items.push({ group: 'This run', label: 'Provenance', hint: 'the run’s record, call by call', run: () => setView('provenance') });
    if (run.parent) items.push({ group: 'This run', label: 'Compare with parent', hint: shortId(run.parent.runId), run: () => navigate(href.compare(run.parent!.runId, runId)) });
    setRunCommands(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the commands change with what they show; the functions they call are new each render, and taking them in would register the commands again on every one
  }, [runId, selected, live, exported, actionsOff, canFork, run.parent?.runId, offers?.bisect?.failed, canMark, labels.join('\n')]);
  useEffect(() => () => setRunCommands([]), [setRunCommands]);

  const stripCalls = useMemo<StripCall[]>(() => {
    const strip = (c: (typeof calls)[number]): StripCall => ({ n: c.callNo, origin: originOf(c), name: callName(c.kind, c.name), detail: stripDetail(c) });
    const origins = paging?.origins;
    if (!origins) return calls.map(strip);
    // Every call from its origin while the pages come; its name once its page is read.
    const byNo = new Map(calls.map((c) => [c.callNo, c]));
    return origins.map((origin, i) => {
      const c = byNo.get(i + 1);
      return c ? strip(c) : { n: i + 1, origin, name: `#${i + 1}`, detail: 'not read yet' };
    });
  }, [calls, paging?.origins]);
  const inScopeFn = useMemo(() => {
    if (scope === 'all') return null;
    const ids = new Set(scopedCalls.map((c) => c.callNo));
    return (n: number) => ids.has(n);
  }, [scope, scopedCalls]);
  const present = useMemo(() => presentOrigins(countOrigins(stripCalls.map((c) => c.origin))), [stripCalls]);

  // While the pages come, Calls counts the run's calls and Turns says nothing until they are all read.
  const tabs: Array<[View, string, number | undefined]> = [
    ['calls', 'Calls', paging && scope === 'all' ? paging.total : scopedCalls.length],
    ['turns', 'Turns', paging ? undefined : scopedCalls.filter((c) => c.kind === 'api').length],
    ['context', 'Context', undefined],
    ['timeline', 'Timeline', undefined],
    ['forks', 'Forks', undefined],
    ['provenance', 'Provenance', undefined],
  ];

  return (
    <div className="rv">
      <RunHeader run={run} call={detail.data} selected={selected} rescued={!!rescued} offers={offers} forkMenu={forkMenu} onAction={actions.run} onFindCommit={actions.findCommit} preset={preset} labels={labels} setLabels={setLabels} onMark={mark} />
      <Metrics run={run} notWaitedMs={waited.ms || null} notWaitedUnknown={waited.unknown} />
      <Banner run={run} blame={blame} rescued={rescued} checks={checksOf(run)} offers={offers} showDiff={showDiff} onToggleDiff={() => setShowDiff(!showDiff)} onSelect={select} onAction={actions.run} preset={preset} />
      {showDiff ? <DiffPanel run={run} test={offers?.test ?? null} /> : null}
      <RunNotes notes={notes} onSelect={select} />
      {/* What a fork did differently from its parent, ranked as decisions ranks a change. */}
      {run.run.divergence && run.run.parentRunId && !live ? <ForkDifferences runId={runId} /> : null}
      <section className="strip">
        {stripCalls.length ? <Strip calls={stripCalls} selected={selected} forkAt={forkMark} lostAt={lostAt} inScope={inScopeFn} live={live} onSelect={select} /> : <div className="cells empty-strip">{live ? 'Waiting for the first call…' : 'No calls.'}</div>}
        <Legend origins={present} />
      </section>
      {scoped ? <ScopeBar run={run} scopes={scopeTree} scope={scope} onScope={setScope} /> : null}
      <div className="work">
        <section className="views" aria-label="Views of the run">
          <div className="tabs" role="tablist" aria-label="Views" ref={useActiveTabInView<HTMLDivElement>(v)} onPointerEnter={warmViews} onFocus={warmViews}>
            {tabs.map(([key, label, count]) => (
              <button key={key} type="button" role="tab" aria-selected={v === key} onClick={() => setView(key)} title={CYCLE_VIEWS.includes(key) ? 'v cycles the views' : undefined}>
                {label}
                {count !== undefined ? <span className="count">{count.toLocaleString('en-US')}</span> : null}
              </button>
            ))}
          </div>
          {v === 'calls' ? <CallsToolbar counts={filterCounts} filter={filter} onFilter={setFilter} text={text} onText={setText} inputRef={filterRef} fold={foldAll} /> : null}
          {paging ? (
            <div className="toolbar muted" role="status">
              {paging.gone
                ? `${paging.read.toLocaleString('en-US')} of ${paging.total.toLocaleString('en-US')} calls read; the run is no longer in ${client.exported ? 'this copy' : 'this store'}.`
                : paging.error
                ? `${paging.read.toLocaleString('en-US')} of ${paging.total.toLocaleString('en-US')} calls read; the next page could not be read (${paging.error}). It is tried again in a moment, or at once when you pick a call.`
                : `${paging.read.toLocaleString('en-US')} of ${paging.total.toLocaleString('en-US')} calls read so far; the rest are on their way.${text.trim() || scope !== 'all' || v !== 'calls' ? ' What shows is from those read.' : ''}`}
            </div>
          ) : null}
          {/* Each view starts at its top; Calls centres the selected call. The Timeline, the Turns of a
              run whose model called no tool and Context hold nothing that takes the focus, so the
              view takes it itself, to be scrolled by keyboard. */}
          <div className="vbody" key={v} {...(PANE_NAMES[v] ? { tabIndex: 0, role: 'region', 'aria-label': PANE_NAMES[v] } : { tabIndex: -1 })}>
            {v === 'calls' ? <CallsTable calls={visible} asked={asked} selected={selected} scoped={scoped} forkAt={forkMark} lostAt={lostAt} ancestors={ancestors} live={live} canFork={canFork} onSelect={select} onFork={openForkAt} onNeed={need} tree={tree} folded={folded} onFold={fold} /> : null}
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

