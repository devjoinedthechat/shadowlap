import { useMemo, useSyncExternalStore } from 'react';

/**
 * Runs deleted from Runs' bulk bar, waiting out their toast. Until the toast goes they are gone from
 * Runs' table and its counts, the nav, the status bar, the sidebar and the palette, but still in the
 * store, so Undo needs nothing put back: it only takes them off the list (`cancel`). The days over
 * the table and the other pages keep them until the delete lands and they are read again. The toast
 * going sends the delete (`sendNow`). Leaving the page, or another project, sends what waits first
 * (`flush`), with keepalive as the page goes, so a request the page can't see out still lands; a
 * crash leaves the runs, the safe side. Once the server answers, the runs it deleted stay off the
 * lists until those are read again, and the counts the server gave before stop taking them only
 * once they are read again too (`useStillCounted`). No DOM here but the window's pagehide: the
 * tests import it.
 */

/** A run a delete waits to take: the counts it takes from while it waits. */
export interface PendingRun {
  runId: string;
  /** The chips it counts under, `all` aside: its kind's, `failed`, `local`. */
  chips: readonly string[];
  /** The attempts bundled under it, which go with it. */
  attempts: number;
  startedAt: number;
}

/** Sends a delete, as the page goes with keepalive: the ids the server deleted, or null when it failed (its runs come back). */
export type SendDelete = (keepalive: boolean) => Promise<readonly string[] | null>;

/** A delete waiting out its toast, being sent, or answered (`seq`, the order it landed in). */
interface Batch {
  runs: readonly PendingRun[];
  state: 'waiting' | 'sending' | 'landed';
  seq: number;
  send: SendDelete;
}

/** What a caller holds of a delete: for Undo and the toast going. */
export type PendingDelete = { readonly runs: readonly PendingRun[] };

/** How long the runs a delete took stay off lists not read again since: past it every list has been. */
const LANDED_MS = 60_000;

const batches = new Set<Batch>();
const listeners = new Set<() => void>();
let landings = 0;
let snapshot: { hidden: ReadonlySet<string>; batches: readonly Batch[] } = { hidden: new Set(), batches: [] };

function changed(): void {
  const all = [...batches];
  snapshot = { hidden: new Set(all.flatMap((b) => b.runs.map((r) => r.runId))), batches: all };
  for (const fn of listeners) fn();
}

/** Starts waiting to delete `runs`; `send` deletes them once the toast goes. */
export function begin(runs: readonly PendingRun[], send: SendDelete): PendingDelete {
  listenForPageHide();
  const b: Batch = { runs, state: 'waiting', seq: 0, send };
  batches.add(b);
  changed();
  return b;
}

/** Undo: takes a delete back while it waits, its runs on the lists again. False once it has gone to the server. */
export function cancel(handle: PendingDelete): boolean {
  const b = handle as Batch;
  if (!batches.has(b) || b.state !== 'waiting') return false;
  batches.delete(b);
  changed();
  return true;
}

/** Sends a delete that waits; null when it no longer waits (Undone, or sent already: never twice). */
export function sendNow(handle: PendingDelete, keepalive = false): Promise<void> | null {
  const b = handle as Batch;
  if (!batches.has(b) || b.state !== 'waiting') return null;
  b.state = 'sending';
  const land = (done: readonly string[] | null) => {
    const gone = new Set(done ?? []);
    b.runs = b.runs.filter((r) => gone.has(r.runId));
    b.state = 'landed';
    b.seq = ++landings;
    if (!b.runs.length) batches.delete(b);
    else
      setTimeout(() => {
        if (batches.delete(b)) changed();
      }, LANDED_MS);
    changed();
  };
  return b.send(keepalive).then(land, () => land(null));
}

/**
 * Sends every delete that waits: as the page goes (keepalive), or before the project changes (a
 * switch, adding a folder, removing a project), so it lands in the store its runs are in.
 */
export function flush(keepalive = false): Promise<void> {
  return Promise.all([...batches].flatMap((b) => sendNow(b, keepalive) ?? [])).then(() => undefined);
}

/** Whether any delete waits or is on its way. */
export function deleting(): boolean {
  return [...batches].some((b) => b.state !== 'landed');
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const current = () => snapshot;

/** The runs off the lists, now: for a list built once, as the palette's is when it opens. */
export const pendingHidden = (): ReadonlySet<string> => snapshot.hidden;

/** The runs off the lists: those a delete waits to take or took. */
export function usePendingHidden(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, current, current).hidden;
}

/** The order of the landing a count read now already holds, for each count object (`useStillCounted`). */
const readAt = new WeakMap<object, number>();

/**
 * The runs a count read from the server (`source`: the meta, a page's chip counts) still holds:
 * those a delete waits to take or is taking, and those it took after the count was read. A count
 * first drawn once a delete has landed holds it already.
 */
export function useStillCounted(source: object | null | undefined): readonly PendingRun[] {
  const { batches: all } = useSyncExternalStore(subscribe, current, current);
  if (source && !readAt.has(source)) readAt.set(source, landings);
  const since = source ? readAt.get(source)! : landings;
  return useMemo(() => all.filter((b) => b.state !== 'landed' || b.seq > since).flatMap((b) => b.runs), [all, since]);
}

/** A count less the runs a delete takes (`runs`), or their attempts too (`attempts`); none below 0. */
export function lessPending(n: number | null | undefined, runs: readonly PendingRun[], what: 'runs' | 'attempts' = 'runs'): number | null {
  if (n === null || n === undefined) return null;
  return Math.max(0, n - (what === 'runs' ? runs.length : runs.reduce((t, r) => t + r.attempts, 0)));
}

/** A list without the runs off it. */
export function withoutPending<T extends { runId: string }>(runs: readonly T[], hidden: ReadonlySet<string>): T[] {
  return hidden.size ? runs.filter((r) => !hidden.has(r.runId)) : [...runs];
}

/** The windows heard as they go: the page's own, one in a test's page. */
const heard = new WeakSet();

/**
 * Sends what waits as the page goes, its toast going with it (`SendDelete` with keepalive). A page
 * the browser keeps to bring back (`persisted`) comes back with nothing waiting, so nothing is sent
 * twice, and its lists are read again once the delete answers.
 */
function listenForPageHide(): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function' || heard.has(window)) return;
  heard.add(window);
  window.addEventListener('pagehide', () => void flush(true));
}
