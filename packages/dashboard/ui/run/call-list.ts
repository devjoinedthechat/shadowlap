import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CallRow } from '../types.js';
import { countOrigins } from '../origins.js';
import { inScope, scopeChips, scopesOf } from '../scopes.js';
import { askedTools } from './calls.js';
import { matchesFilter, pendingMatches, type OriginFilter } from './CallsView.js';
import { ancestorsOf, callTree, heads, unfolded } from './groups.js';
import { originOf } from './model.js';
import type { Paging } from './paged-run.js';
import { isPending, listedCalls, type ListedCall } from './paging.js';

/** No group folded. */
const NO_FOLDS: ReadonlySet<number> = new Set();

/**
 * A run's calls as its page lists them: the scope picked (scopes.ts), the filter and its text, the
 * groups and what is folded (groups.ts), what Calls shows (`visible`) and the filter's counts. While a
 * long run's pages come, every call is listed, a placeholder for each not read yet.
 */
export function useCallList({ runId, calls, paging, selected }: { runId: string; calls: CallRow[]; paging: Paging | null; selected: number | null }) {
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
  return { scope, setScope, scopeTree, scoped, scopedCalls, filter, setFilter, text, setText, asked, listed, tree, folded, fold, visible, foldAll, filterCounts };
}
