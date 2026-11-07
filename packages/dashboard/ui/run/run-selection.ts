import { useEffect, useMemo, useRef } from 'react';
import { followNewest } from '../live.js';
import { href, type View } from '../route.js';
import { navigate } from '../router.js';
import type { CallRow, RunDetail } from '../types.js';
import { openOn, rememberCall } from './open-at.js';
import type { Paging } from './paged-run.js';

/**
 * The page's address and what it remembers of where it is. A short id (`id`) settles on the full one,
 * and a link naming no call lands on the one the page shows; that call is kept for the session
 * (open-at.ts); and Run blame placing the loss while the page is open moves the selection and the
 * address there.
 */
function useOpenAt({ runId, id, call, selected, lostAt, view }: { runId: string; id: string; call: number | null; selected: number | null; lostAt: number | null; view: View | null }): void {
  useEffect(() => {
    if (runId !== id || (call === null && selected !== null)) navigate(href.run(runId, call ?? selected, view), true);
  }, [runId, id, call, selected, view]);
  useEffect(() => {
    if (runId === id && selected !== null) rememberCall(runId, selected);
  }, [runId, id, selected]);
  const lostBefore = useRef(lostAt);
  useEffect(() => {
    if (runId === id && lostBefore.current === null && lostAt !== null) navigate(href.run(runId, lostAt, view), true);
    lostBefore.current = lostAt;
  }, [lostAt, runId, id, view]);
}

export interface SelectionInput {
  run: RunDetail;
  /** The id the address names, and the call and view it names, if any. */
  id: string;
  call: number | null;
  view: View | null;
  /** The run's calls read so far, and its pages while they come. */
  calls: CallRow[];
  paging: Paging | null;
  /** Where the page may open: the fork, the lost call and the call the run's first fact names. */
  forkAt: number | null;
  lostAt: number | null;
  outcomeAt: number | null;
}

/**
 * The call a run's page shows: the one its address names, else a call picked on this run's page earlier
 * in the session, then the most telling (open-at.ts), and a recording follows its newest. It keeps the
 * address and the session's memory in step (`useOpenAt`), and reads the page that holds it first.
 */
export function useRunSelection({ run, id, call, view, calls, paging, forkAt, lostAt, outcomeAt }: SelectionInput): number | null {
  const runId = run.run.runId;
  const status = run.run.status;
  const live = status === 'running';
  // The newest call: the last of the run's count while its pages come, never the last read.
  const last = paging ? paging.total : calls.length ? calls[calls.length - 1]!.callNo : null;
  const fallback = useMemo(() => openOn(runId, { forkAt, lostAt, outcomeAt, live, calls, origins: paging?.origins ?? null, total: paging?.total ?? null }), [runId, forkAt, lostAt, outcomeAt, live, calls, paging?.origins, paging?.total]);
  // While its pages come, a call of the run is one numbered up to its count, read yet or not.
  const isCall = (n: number) => (paging ? n >= 1 && n <= paging.total : calls.some((c) => c.callNo === n));
  const selected = call !== null && isCall(call) ? call : call !== null && live ? call : fallback;
  // The page that holds the selected call, read before the others.
  const need = paging?.need ?? null;
  useEffect(() => {
    if (need && selected !== null) need(selected, { pick: true });
  }, [need, selected]);
  useOpenAt({ runId, id, call, selected, lostAt, view });
  // Recording: the selection follows the newest call if it was on the newest (also when the last calls
  // and the end of the recording arrive together). The shell says when it ends, on any page (state.tsx).
  const prevLast = useRef(last);
  const prevStatus = useRef(status);
  useEffect(() => {
    const next = followNewest({ wasStatus: prevStatus.current, status, prevLast: prevLast.current, last, selected });
    if (next !== null) navigate(href.run(runId, next, view), true);
    prevLast.current = last;
    prevStatus.current = status;
  }, [last, selected, runId, view, status]);
  return selected;
}
