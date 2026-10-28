import { Worker } from 'node:worker_threads';
import type { Keeper } from './run-stats.js';

/** What the server hands the keeper's thread: rows to keep, or that it stops. */
export type ToKeeper = { type: 'stats'; rows: Parameters<Keeper['stats']>[0] } | { type: 'asks'; rows: Parameters<Keeper['asks']>[0] } | { type: 'close' };
/** What the keeper's thread says back: that it has written what it could and closed the store. */
export type FromKeeper = { type: 'closed' };

/** How long the keeper's thread has to write what waits and close the store as the dashboard stops, before it is ended. */
export const KEEPER_CLOSE_MS = 2000;

/** The thread's script, beside this module once built; run from the TypeScript source (the tests), the built one. */
function workerScript(): URL {
  const here = new URL(import.meta.url);
  return here.pathname.endsWith('.ts') ? new URL('../dist/keeper-worker.js', here) : new URL('./keeper-worker.js', here);
}

/**
 * Keeps what a store's read-model threads work out (run totals, what recordings' users asked) on a
 * thread of its own (keeper-worker.ts), started with the first rows: the server's thread only hands
 * them over. It wrote them itself once, and a write waited there for the store's write lock while the
 * search index wrote (up to `CACHE_WAIT_MS`), or committed through a checkpoint of the store's log:
 * with the search index catching up beside the warm-up of 10,000 runs, 35 of 1,134 writes held the
 * server's thread 20 to 100 ms, every request with it. A thread that stops is started again with the
 * next rows.
 */
export function storeKeeper(dbPath: string, o: { log?: (line: string) => void; script?: URL } = {}): Keeper & { close(): Promise<void> } {
  let worker: Worker | null = null;
  let closing: Promise<void> | null = null;
  const start = (): Worker | null => {
    if (closing) return null;
    if (worker) return worker;
    const w = new Worker(o.script ?? workerScript(), { workerData: { dbPath } });
    // Never what keeps a process running: the dashboard's close ends it, with what waits written.
    w.unref();
    w.once('error', (err) => {
      o.log?.(`the thread keeping what the read models work out stopped: ${err.message}`);
      if (worker === w) worker = null;
    });
    w.once('exit', () => {
      if (worker === w) worker = null;
    });
    worker = w;
    return w;
  };
  const send = (m: Exclude<ToKeeper, { type: 'close' }>): void => {
    if (m.rows.length) start()?.postMessage(m);
  };
  return {
    stats: (rows) => send({ type: 'stats', rows }),
    asks: (rows) => send({ type: 'asks', rows }),
    close: () =>
      (closing ??= (async () => {
        const w = worker;
        worker = null;
        if (!w) return;
        await new Promise<void>((resolve) => {
          w.on('message', (m: FromKeeper) => m.type === 'closed' && resolve());
          w.once('exit', () => resolve());
          setTimeout(resolve, KEEPER_CLOSE_MS).unref();
          w.postMessage({ type: 'close' } satisfies ToKeeper);
        });
        await w.terminate().catch(() => undefined);
      })()),
  };
}
