import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallRow } from '../types.js';
import { displayOrigin } from '../origins.js';
import { agentsShown, inScope, scopeChips } from '../scopes.js';
import { askedTools } from './calls.js';
import { keepFilter, keyCounts, matchesFilter, pendingMatches, pickedFilter, shownFilter, type CallFilter } from './call-filter.js';
import { openIn, setFolds, useFolds } from './folds.js';
import { pathOf, traceOf, traceRows, type Trace, type TraceGroup } from './groups.js';
import { callKind } from './kinds.js';
import type { Paging } from './paged-run.js';
import { isPending, listedCalls, type ListedCall } from './paging.js';

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
 * A run's calls as its page lists them: the scope picked (scopes.ts), the filter (the strip's key,
 * call-filter.ts, by kind on a recording, `byKind`) and its text, the trace's groups and what is
 * folded (groups.ts, folds.ts), what j and k step through (`visible`: every call listed, or what a
 * filter matches) and the key's counts. While a long run's pages come, every call is listed, a
 * placeholder for each not read yet.
 */
export function useCallList({ runId, calls, paging, selected, byKind, live, spend }: { runId: string; calls: CallRow[]; paging: Paging | null; selected: number | null; byKind: boolean; live: boolean; spend: boolean }) {
  const [scope, setScope] = useState('all');
  const scopeTree = useMemo(() => scopeChips(calls), [calls]);
  const scoped = useMemo(() => agentsShown(calls), [calls]);
  const scopedCalls = useMemo(() => (scope === 'all' ? calls : calls.filter((c) => inScope(c, scope))), [calls, scope]);
  // The key's counts within the scope, of the whole run while its pages come.
  const codes = paging && scope === 'all' ? (byKind ? paging.kinds : paging.origins) : null;
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
  // Every call while the pages come, a placeholder for each not read yet; within a scope, those read.
  const listed = useMemo<readonly ListedCall[]>(() => (paging && scope === 'all' ? listedCalls(calls, paging.total, paging.origins, paging.kinds) : scopedCalls), [paging, scope, calls, scopedCalls]);
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
  return { scope, setScope, scopeTree, scoped, scopedCalls, filter, setFilter, text, setText, asked, listed, trace: grouped, rows, held, shown, fold, visible, counts };
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
