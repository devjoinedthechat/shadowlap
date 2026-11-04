import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '@shadowlap/engine';
import { keepQueue } from './keep-queue.js';
import type { FromKeeper, ToKeeper } from './keeper.js';

/**
 * The thread that keeps what a store's read models work out (keeper.ts starts it): the rows the
 * server hands over, written a slice at a time through a connection of its own (keep-queue.ts), so
 * a wait for the store's write lock, or a commit that checkpoints its log, holds this thread and
 * never the server's.
 */

const port = parentPort!;
const { dbPath } = workerData as { dbPath: string };
let store: Store | null = null;
/** The store, opened with the first rows; one deleted meanwhile is never made anew to keep rows in (the queue drops them). */
const queue = keepQueue(() => (store ??= Store.openExisting(dbPath)));

port.on('message', (m: ToKeeper) => {
  if (m.type === 'stats') queue.stats(m.rows);
  else if (m.type === 'asks') queue.asks(m.rows);
  else {
    // The dashboard stops or lets go of the store: what waits is written as far as the store lets
    // it, and the connection closed before the thread ends, as Windows can't delete or move an open file.
    queue.flush();
    queue.close();
    try {
      store?.close();
    } catch {
      // closed already
    }
    port.postMessage({ type: 'closed' } satisfies FromKeeper);
    port.close();
  }
});
