import type { Store } from '@shadowlap/engine';
import type { Keeper } from './run-stats.js';

type StatsRow = Parameters<Keeper['stats']>[0][number];
type AskRow = Parameters<Keeper['asks']>[0][number];

/** The rows one write keeps: a backlog is written a slice at a time, the server's thread free between two. */
const SLICE = 500;
/** At most this many rows wait to be kept; past it the oldest go (their numbers stay in the threads' memory). */
export const KEEP_WAITING_MAX = 50_000;
/** How long the rows wait after a write found the store held, doubled while it still is, up to `KEEP_RETRY_MAX_MS`. */
export const KEEP_RETRY_MS = 2000;
export const KEEP_RETRY_MAX_MS = 8000;

/**
 * Writes what a store's read-model threads work out to keep (run totals, what recordings' users
 * asked) through the server's own connection. A write that finds the store held by another command
 * (a batch of the search index, gc's VACUUM, a pull) waits for it only a moment (`CACHE_WAIT_MS`), so
 * the server's thread never waits on it: its rows then wait, and are written once the store is free,
 * two seconds on, then four, up to eight. They were dropped before, the threads keeping them in
 * memory only: in a gate under load, with the search index catching up beside them, 3,440 of 10,000
 * runs' totals worked out were never kept, for the next dashboard to work out again.
 */
export function storeKeeper(store: () => Store): Keeper & { close(): void } {
  const stats: StatsRow[] = [];
  const asks: AskRow[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retry = KEEP_RETRY_MS;
  let closed = false;
  const later = (ms: number): void => {
    if (timer || closed) return;
    timer = setTimeout(write, ms);
    timer.unref();
  };
  /** Writes a slice of what waits, of each kind; the next slice on a later turn, or later still while the store is held. */
  function write(): void {
    timer = null;
    if (closed) return;
    try {
      const s = store();
      const a = stats.slice(0, SLICE);
      const b = asks.slice(0, SLICE);
      const kept = (!a.length || s.saveRunStats(a)) && (!b.length || s.saveRunAsks(b));
      if (!kept) {
        // What was written of it stays written: writing it again replaces it with the same.
        later(retry);
        retry = Math.min(retry * 2, KEEP_RETRY_MAX_MS);
        return;
      }
      retry = KEEP_RETRY_MS;
      stats.splice(0, a.length);
      asks.splice(0, b.length);
      if (stats.length || asks.length) later(0);
    } catch {
      // A store closed meanwhile (the dashboard stopping, the store deleted): nothing to keep it in.
      stats.length = 0;
      asks.length = 0;
    }
  }
  const add = <T>(list: T[], rows: readonly T[]): void => {
    if (closed || !rows.length) return;
    list.push(...rows);
    if (list.length > KEEP_WAITING_MAX) list.splice(0, list.length - KEEP_WAITING_MAX);
    // Written at once, unless rows already wait for the store or for their turn.
    if (!timer) write();
  };
  return {
    stats: (rows) => add(stats, rows),
    asks: (rows) => add(asks, rows),
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      stats.length = 0;
      asks.length = 0;
    },
  };
}
