import { parentPort, workerData } from 'node:worker_threads';
import { Store, messageOf } from '@shadowlap/engine';
import { closedStore, indexRecordings, indexSearchSlice, RETRY_MAX_MS, RETRY_MS, SLICE_MS } from './search-hits.js';

/**
 * The thread a store's search index is brought up to date on (search-index.ts starts it), so the
 * server's own thread reads none of what it indexes: the store on a connection of its own, slice
 * after slice while the index is behind, each waiting a moment at most for another command's write;
 * between two slices, what the server asks: look again (runs arrived), or take in what the runs
 * still recording said, which a search waits for. A store another command is writing (gc's VACUUM,
 * a pull) is tried again a second later, then two, up to eight, or at once when the server asks.
 */

export interface SearchWorkerData {
  dbPath: string;
}

export type ToSearchWorker = { type: 'look' } | { type: 'recordings'; id: number } | { type: 'close' };

export type FromSearchWorker = { type: 'ready' } | { type: 'failed'; error: string } | { type: 'recorded'; id: number } | { type: 'closed' };

const port = parentPort!;
const post = (m: FromSearchWorker) => port.postMessage(m);

let store: Store | null = null;
try {
  // Only a store that is there: this thread starts a while after it is asked for, by when the store
  // may have been deleted (its project removed with its recordings), and must not be made again.
  store = Store.openExisting((workerData as SearchWorkerData).dbPath);
  post({ type: 'ready' });
} catch (err) {
  post({ type: 'failed', error: messageOf(err) });
}

let timer: ReturnType<typeof setTimeout> | null = null;
let retry = RETRY_MS;

/** The next slice in `ms`: 0 lets what the server asked in between come first. */
function next(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(slice, ms);
}

function slice(): void {
  timer = null;
  if (!store) return;
  let wait: number | null;
  try {
    const { behind, busy } = indexSearchSlice(store, SLICE_MS);
    wait = busy ? retry : behind > 0 ? 0 : null;
    retry = busy ? Math.min(retry * 2, RETRY_MAX_MS) : RETRY_MS;
  } catch (err) {
    // Anything but a closed store (a read SQLite refused for a moment) is tried again later.
    wait = closedStore(err) ? null : retry;
    retry = Math.min(retry * 2, RETRY_MAX_MS);
  }
  if (wait !== null) next(wait);
}

port.on('message', (m: ToSearchWorker) => {
  if (m.type === 'close') {
    if (timer) clearTimeout(timer);
    timer = null;
    // Closed before the thread ends: Windows can't delete or move the store's file while it is open.
    store?.close();
    store = null;
    post({ type: 'closed' });
    return;
  }
  if (m.type === 'recordings') {
    try {
      if (store) indexRecordings(store);
    } catch {
      // the slices try again
    }
    post({ type: 'recorded', id: m.id });
  }
  // Asked to look: at once, even while waiting out another command's write.
  retry = RETRY_MS;
  next(0);
});

if (store) next(0);
