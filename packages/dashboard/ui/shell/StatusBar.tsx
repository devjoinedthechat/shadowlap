import { Fragment, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useNow } from '../hooks.js';
import { storePath } from '../projects.js';
import { lessPending, usePendingHidden, useStillCounted, withoutPending, type PendingRun } from '../pending-delete.js';
import { isAttempt } from '../runs.js';
import { useApp } from '../state.js';
import { useTeamStore } from '../teamstore.js';
import type { RunListItem } from '../types.js';
import { JobChip } from './JobChip.js';
import { readOnlyWhy, STATUS_GIVES_WAY, statusParts, type StatusPart } from './status.js';

/** The runs the store holds and the attempts bundled under them, less those a delete waits to take (pending-delete.ts). */
function storeCounts(counts: { runs: number; attempts: number } | null | undefined, runs: readonly RunListItem[] | null, hidden: ReadonlySet<string>, gone: readonly PendingRun[]): { runs: number | null; attempts: number | null } {
  const shown = runs ? withoutPending(runs, hidden) : null;
  const listed = shown ? shown.filter((r) => !isAttempt(r)).length : null;
  return { runs: lessPending(counts?.runs, gone) ?? listed, attempts: lessPending(counts?.attempts, gone, 'attempts') ?? (shown ? shown.length - (listed ?? 0) : null) };
}

/**
 * Fits the bar to its width, measured: while it overflows, what it can do without gives way whole,
 * with its separator (status.ts says the order), the store's path, which leads, taking the one after
 * it. A separator left at the bar's end, after a hidden job's chip, goes too. Never cut mid-word.
 */
function fitStatus(bar: HTMLElement): void {
  const kids = [...bar.children] as HTMLElement[];
  for (const k of kids) if (k.style.display === 'none') k.style.display = '';
  if (!bar.getClientRects().length) return;
  for (const key of STATUS_GIVES_WAY) {
    if (bar.scrollWidth <= bar.clientWidth + 1) break;
    for (const k of kids) if (k.classList.contains(key) || (key === 'st-store' && k.matches('.sep.st-runs'))) k.style.display = 'none';
  }
  const last = kids.filter((k) => k.style.display !== 'none').at(-1);
  if (last?.classList.contains('sep')) last.style.display = 'none';
}

/** Fitted on each draw, as the bar's width or its words change (a hidden job's chip comes), and once the fonts land. */
function useFitStatus(bar: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    if (bar.current) fitStatus(bar.current);
  });
  useEffect(() => {
    const el = bar.current;
    if (!el) return;
    const fit = () => fitStatus(el);
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    sized?.observe(el);
    const changed = typeof MutationObserver === 'function' ? new MutationObserver(fit) : null;
    changed?.observe(el, { childList: true, subtree: true, characterData: true });
    void document.fonts?.ready.then(fit, () => undefined);
    return () => {
      sized?.disconnect();
      changed?.disconnect();
    };
  }, [bar]);
}

function Part({ p, sep }: { p: StatusPart; sep: boolean }) {
  return (
    <>
      {sep ? <span className={`sep ${p.key}`} /> : null}
      <span className={p.key} title={p.title}>
        {p.words.map((w, i) => (
          <Fragment key={i}>{typeof w === 'string' ? w : 'code' in w ? <code>{w.code}</code> : <b className="off">{w.off}</b>}</Fragment>
        ))}
      </span>
    </>
  );
}

/**
 * The status bar: the store and the counts (runs, then the attempts bundled under them); then a job
 * off the screen (`JobChip`), the connection while it is lost, read-only, the address or the team
 * store, and the version, each part giving way whole where the bar is short. A recording in progress
 * shows in the top bar's chip, not here.
 */
export function StatusBar({ inert = false }: { inert?: boolean }) {
  const { meta, runs, conn, exported, actionsOff } = useApp();
  // The team store's words say when it last synced.
  const now = useNow(10_000);
  const team = useTeamStore();
  const { runs: runCount, attempts } = storeCounts(meta?.counts, runs, usePendingHidden(), useStillCounted(meta));
  const { left, right } = statusParts({
    exported,
    store: meta?.dbPath ? { shown: storePath(meta), whole: meta.dbPath } : null,
    runs: runCount,
    attempts,
    exportedAt: meta?.exportedAt ?? null,
    conn,
    readOnly: readOnlyWhy({ meta, exported, actionsOff }),
    address: meta?.address ?? location.host,
    team,
    version: meta?.version ?? null,
    now,
  });
  const bar = useRef<HTMLElement>(null);
  useFitStatus(bar);
  return (
    <footer className="status" ref={bar} inert={inert}>
      {left.map((p, i) => (
        <Part key={p.key} p={p} sep={i > 0} />
      ))}
      <span className="sp" />
      <JobChip />
      {right.map((p, i) => (
        <Part key={p.key} p={p} sep={i > 0} />
      ))}
    </footer>
  );
}
