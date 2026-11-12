import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JUDGE_SCOPE } from '../../../engine/src/judge-scope.js';
import type { CallRow } from '../types.js';
import { displayOrigin } from '../origins.js';
import { useLatest } from '../hooks.js';
import { agentsShown, inScope, judgeNumbers, scopeChips } from '../scopes.js';
import { askedTools } from './calls.js';
import { keepFilter, keyCounts, matchesFilter, pendingMatches, pickedFilter, shownFilter, type CallFilter } from './call-filter.js';
import { openIn, setFolds, useFolds } from './folds.js';
import { pathOf, traceOf, traceRows, type Trace, type TraceGroup } from './groups.js';
import { callKind } from './kinds.js';
import type { Paging } from './paged-run.js';
import { isPending, listedCalls, type ListedCall } from './paging.js';
import { useStripCalls } from './RunStrip.js';

/** What a group's row counts among its calls, as the key draws them loud: a write and an error by kind, else what a fork changed. */
const LOUD_KINDS: ReadonlySet<string> = new Set(['k-write', 'k-err']);
const LOUD_ORIGINS: ReadonlySet<string> = new Set(['over', 'inject', 'fail', 'block', 'stub']);
const loudBy =
  (byKind: boolean) =>
  (c: ListedCall): string | null => {
    if (isPending(c)) return null;
    const code = byKind ? callKind(c) : displayOrigin(c);
    return (byKind ? LOUD_KINDS : LOUD_ORIGINS).has(code) ? code : null;
  };

/**
 * The run's scopes as its page narrows its calls by them (scopes.ts): the scope picked, its chips,
 * whether the views name the run's agents (`scoped`) and whether the bar shows (`bar`, agentsShown).
 * A judge's calls (`judge`, judgeNumbers: the server's `judgeCalls` too while a long run's pages
 * come) are none of the agent's: All leaves them out, and so do the strip, the key and the tabs'
 * counts, until the judge's chip is picked; then the views are the judge's, the strip adds its calls
 * and dims the rest, and Context and Timeline stay the agent's (`ownCalls`), saying so (`judgeOn`).
 * A judge's call picked picks the judge's chip: as the selection moves to it (a link to it), and at
 * every pick of one, though it is selected already (`pickScope`, which the page's select calls: its
 * finding's #n again, after All). The page never opens on one by itself (open-at.ts).
 */
function useScopes(calls: CallRow[], paging: Paging | null, selected: number | null) {
  const [scope, setScope] = useState('all');
  const judge = useMemo(() => judgeNumbers(calls, paging?.judge ?? null), [paging?.judge, calls]);
  const [seen, setSeen] = useState<number | null>(null);
  if (seen !== selected) {
    setSeen(selected);
    if (selected !== null && judge.has(selected)) setScope(JUDGE_SCOPE);
  }
  const judgeNow = useLatest(judge);
  const pickScope = useCallback((n: number) => (judgeNow.current.has(n) ? setScope(JUDGE_SCOPE) : undefined), [judgeNow]);
  const judgeOn = scope === JUDGE_SCOPE;
  const { scoped, bar } = useMemo(() => agentsShown(calls, judge), [calls, judge]);
  const scopeTree = useMemo(() => (scoped ? scopeChips(calls) : []), [scoped, calls]);
  const scopedCalls = useMemo(() => (scope === 'all' && !judge.size ? calls : calls.filter((c) => inScope(c, scope))), [calls, scope, judge]);
  // Context and Timeline under the judge's chip: the agent's calls.
  const ownCalls = useMemo(() => (judgeOn ? calls.filter((c) => inScope(c, 'all')) : scopedCalls), [judgeOn, calls, scopedCalls]);
  return { scope, setScope, pickScope, judge, judgeOn, scoped, bar, scopeTree, scopedCalls, ownCalls };
}

/** A long run's strings as All reads them: without the judge's calls. */
function agentCodes<T>(codes: readonly T[] | null, judge: ReadonlySet<number>): readonly T[] | null {
  return codes && judge.size ? codes.filter((_, i) => !judge.has(i + 1)) : codes;
}

/**
 * The strip's calls, and which of them the scope picked holds (the rest dimmed; null for All): a
 * judge's calls only under the judge's chip, where they are the ones it holds.
 */
function useStrip(calls: CallRow[], paging: Paging | null, s: { scope: string; judge: ReadonlySet<number>; judgeOn: boolean; scopedCalls: readonly CallRow[] }) {
  const all = useStripCalls(calls, paging?.origins, paging?.kinds);
  const { scope, judge, judgeOn, scopedCalls } = s;
  const shown = useMemo(() => (judgeOn || !judge.size ? all : all.filter((c) => !judge.has(c.n))), [all, judgeOn, judge]);
  const inStrip = useMemo(() => {
    if (scope === 'all') return null;
    const ids = judgeOn ? judge : new Set(scopedCalls.map((c) => c.callNo));
    return (n: number) => ids.has(n);
  }, [scope, judgeOn, judge, scopedCalls]);
  return { calls: shown, inScope: inStrip };
}

/**
 * A run's calls as its page lists them: the scope picked (scopes.ts, `useScopes`), the filter (the
 * strip's key, call-filter.ts, by kind on a recording, `byKind`) and its text, the trace's groups and
 * what is folded (groups.ts, folds.ts), what j and k step through (`visible`: every call listed, or
 * what a filter matches), the key's counts and the tabs'. While a long run's pages come, every call
 * is listed, a placeholder for each not read yet.
 */
export function useCallList({ runId, calls, paging, selected, byKind, live, spend }: { runId: string; calls: CallRow[]; paging: Paging | null; selected: number | null; byKind: boolean; live: boolean; spend: boolean }) {
  const scopes = useScopes(calls, paging, selected);
  const { scope, judge, scopedCalls } = scopes;
  const strip = useStrip(calls, paging, scopes);
  // The key's counts within the scope, of the whole run but the judge's calls while its pages come.
  const codes = useMemo(() => (paging && scope === 'all' ? agentCodes(byKind ? paging.kinds : paging.origins, judge) : null), [paging, scope, byKind, judge]);
  const counts = useMemo(() => keyCounts(scopedCalls, codes, byKind), [scopedCalls, codes, byKind]);
  const [pick, setPick] = useState<CallFilter>(pickedFilter);
  const setFilter = useCallback((f: CallFilter) => {
    keepFilter(f);
    setPick(f);
  }, []);
  const filter = shownFilter(pick, counts.counts, byKind);
  const [text, setText] = useState('');
  // The tools each model call asked for, when the server says which call asked for each tool call.
  const asked = useMemo(() => (calls.some((c) => c.kind === 'tool' && c.requestedBy !== undefined) ? askedTools(calls) : null), [calls]);
  // Every call but the judge's while the pages come, a placeholder for each not read yet; within a scope, those read.
  const listed = useMemo<readonly ListedCall[]>(() => {
    if (!paging || scope !== 'all') return scopedCalls;
    const every = listedCalls(calls, paging.total, paging.origins, paging.kinds);
    return judge.size ? every.filter((c) => !judge.has(c.callNo)) : every;
  }, [paging, scope, calls, scopedCalls, judge]);
  // The tabs' counts: Calls, the run's calls but the judge's while the pages come; Turns says nothing until they are all read.
  const tabCounts = { calls: paging && scope === 'all' ? paging.total - judge.size : scopedCalls.length, turns: paging ? undefined : scopedCalls.filter((c) => c.kind === 'api').length };
  // The trace (groups.ts): a model call's tool calls under it, a sub-agent's and a batch item's calls
  // under a row of their own. A filter lists what it matches flat, as the calls it leaves out are what
  // the groups hang on.
  const filtering = filter !== 'all' || !!text.trim();
  const loud = useMemo(() => loudBy(byKind), [byKind]);
  const trace = useMemo(() => (filtering ? null : traceOf(listed, { base: scope === 'all' ? null : scope, loud, spend, live })), [filtering, listed, scope, loud, spend, live]);
  const grouped = trace?.grouped ? trace : null;
  const folds = useFolds(runId);
  const opening = useOpening(runId, grouped, grouped ? scope : null, selected, folds);
  const shown = useCallback((g: TraceGroup) => opening.has(g.key) || openIn(folds, g), [opening, folds]);
  const fold = useCallback((g: TraceGroup) => setFolds(runId, [g.key], !shown(g)), [runId, shown]);
  // The rows Calls draws, and the folded group that holds the selection, drawn with its ground.
  const rows = useMemo(() => (grouped ? traceRows(grouped, shown, null).rows : null), [grouped, shown]);
  const held = useMemo(() => (grouped && selected !== null ? (pathOf(grouped, selected).find((g) => !shown(g)) ?? null) : null), [grouped, selected, shown]);
  const visible = useMemo(() => (filtering ? listed.filter((c) => (isPending(c) ? pendingMatches(c, filter, text.trim()) : matchesFilter(c, filter, text.trim(), c.kind === 'api' && asked ? (asked.get(c.callNo) ?? null) : undefined))) : listed), [filtering, listed, filter, text, asked]);
  return { ...scopes, strip, filter, setFilter, text, setText, asked, listed, trace: grouped, rows, held, shown, fold, visible, counts, tabCounts };
}

/** For whom the selection's groups were opened: the run, the call, the grouping (its scope, or none while flat) and the groups. */
interface Opened {
  runId: string;
  selected: number | null;
  grouping: string | null;
  keys: ReadonlySet<string>;
}

const NOT_OPENED: Opened = { runId: '', selected: null, grouping: null, keys: new Set() };

/**
 * The groups that hold the selected call, opened when it is selected, when the run changes, when the
 * list is grouped again and when its place in them first shows (its page came, its item formed); never
 * on a fold, a refresh or another page. They open in the render that draws the rows, so the selected
 * row is drawn from the first (the window keeps it in view by its key), and are kept open in the
 * session's folds after it. Each opens once for a selection, so folding one of them later holds.
 */
function useOpening(runId: string, trace: Trace<ListedCall> | null, grouping: string | null, selected: number | null, folds: ReadonlyMap<string, boolean>): ReadonlySet<string> {
  const done = useRef<Opened>(NOT_OPENED);
  const path = useMemo(() => (trace && selected !== null ? pathOf(trace, selected) : []), [trace, selected]);
  const was = done.current;
  const fresh = was.runId !== runId || was.selected !== selected || was.grouping !== grouping;
  const openKey = path
    .filter((g) => (fresh || !was.keys.has(g.key)) && !openIn(folds, g))
    .map((g) => g.key)
    .join('\n');
  useEffect(() => {
    const w = done.current;
    const anew = w.runId !== runId || w.selected !== selected || w.grouping !== grouping;
    const add = path.filter((g) => anew || !w.keys.has(g.key)).map((g) => g.key);
    if (add.length) setFolds(runId, add, true);
    if (anew || add.length) done.current = { runId, selected, grouping, keys: new Set(anew ? add : [...w.keys, ...add]) };
  }, [runId, selected, grouping, path]);
  return useMemo(() => new Set(openKey ? openKey.split('\n') : []), [openKey]);
}
