import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CallRow } from '../types.js';
import { agentsShown, inScope, scopeChips } from '../scopes.js';
import { askedTools } from './calls.js';
import { keepFilter, keyCounts, matchesFilter, pendingMatches, pickedFilter, shownFilter, type CallFilter } from './call-filter.js';
import { ancestorsOf, callTree, unfolded } from './groups.js';
import type { Paging } from './paged-run.js';
import { isPending, listedCalls, type ListedCall } from './paging.js';

/** No group folded. */
const NO_FOLDS: ReadonlySet<number> = new Set();

/**
 * A run's calls as its page lists them: the scope picked (scopes.ts), the filter (the strip's key,
 * call-filter.ts, by kind on a recording, `byKind`) and its text, the groups and what is folded
 * (groups.ts), what Calls shows (`visible`) and the key's counts. While a long run's pages come, every
 * call is listed, a placeholder for each not read yet.
 */
export function useCallList({ runId, calls, paging, selected, byKind }: { runId: string; calls: CallRow[]; paging: Paging | null; selected: number | null; byKind: boolean }) {
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
  // The selected call is always in view: the groups it sits in, folded, open again (j and k step over a folded group's calls).
  useEffect(() => {
    if (!tree || selected === null || !folded.size) return;
    const over = ancestorsOf(tree, selected).filter((h) => folded.has(h));
    if (!over.length) return;
    const next = new Set(folded);
    for (const h of over) next.delete(h);
    setFolded(next);
  }, [tree, selected, folded, setFolded]);
  return { scope, setScope, scopeTree, scoped, scopedCalls, filter, setFilter, text, setText, asked, listed, tree, folded, fold, visible, counts };
}
