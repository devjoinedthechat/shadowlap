import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '@shadowlap/engine';
import { runJob, type ReadAnswer, type ReadJob } from './read-jobs.js';
import { keepWith } from './run-stats.js';

/**
 * A thread the dashboard works its read models out on (read-pool.ts starts them), so its own thread
 * goes on answering meanwhile: the store on a connection of its own that only reads, a job at a time,
 * each answered as JSON text. What it works out that is worth keeping (run totals, what recordings'
 * users asked) goes to the server's thread, whose connection writes it to the store.
 *
 * It answers each job by the handler its kind is registered with, from the tables read-jobs.ts lists
 * (read-registry.ts): importing runJob loads them all, every feature's with them, so a thread answers
 * every kind the server's own thread does.
 */

export interface ReadWorkerData {
  dbPath: string;
}

export type ToReadWorker = { type: 'job'; id: number; job: ReadJob } | { type: 'close' };

export type FromReadWorker =
  | { type: 'ready' }
  | { type: 'failed'; error: string }
  | { type: 'answer'; id: number; answer: ReadAnswer }
  | { type: 'error'; id: number; error: string }
  | { type: 'keep'; stats?: Array<{ runId: string; key: string; stats: string }>; asks?: Array<{ runId: string; key: string; ask: string | null }> }
  | { type: 'closed' };

const port = parentPort!;
const post = (m: FromReadWorker) => port.postMessage(m);
const words = (err: unknown) => (err instanceof Error ? (err.stack ?? err.message) : String(err));

let store: Store | null = null;
try {
  store = Store.openReadOnly((workerData as ReadWorkerData).dbPath);
  keepWith(store, { stats: (rows) => post({ type: 'keep', stats: rows }), asks: (rows) => post({ type: 'keep', asks: rows }) });
  post({ type: 'ready' });
} catch (err) {
  post({ type: 'failed', error: words(err) });
}

port.on('message', (m: ToReadWorker) => {
  if (m.type === 'close') {
    // Closed before the thread ends: Windows can't delete or move the store's file while it is open.
    store?.close();
    store = null;
    post({ type: 'closed' });
    return;
  }
  const open = store;
  if (!open) return post({ type: 'error', id: m.id, error: 'the store is closed' });
  runJob(open, m.job).then(
    (answer) => post({ type: 'answer', id: m.id, answer }),
    (err: unknown) => post({ type: 'error', id: m.id, error: words(err) }),
  );
});
