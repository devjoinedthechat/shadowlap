import { Worker } from 'node:worker_threads';
import type { Store } from '@shadowlap/engine';
import { HttpError } from './http.js';
import { deleteRuns, type DeleteResult } from './runs-list.js';

/**
 * Deleting runs (`DELETE /api/runs/:id`, `POST /api/runs/delete`), done where it can't hold up the
 * dashboard server: every call of each run goes, with its search index and the attempts bundled
 * under it, then the recorded data nothing uses any more. A run of 100,000 calls held the server's
 * thread 6.7 s, and a delete of 50 runs at 10,000 runs 1.3 s. A store with a file is changed on a
 * thread of its own, through a connection of its own (delete-worker.ts), one delete at a time; a
 * store in memory, which no other thread can open, on the server's, as before.
 */

/** What the thread is given: the store's file and the ids asked for. */
export interface DeleteWork {
  dbPath: string;
  ids: unknown;
}

/** What it posts back: what `deleteRuns` says, or why it could not delete. */
export type DeleteAnswer = { ok: true; result: DeleteResult | { error: string } } | { ok: false; error: string; busy: boolean };

/** The worker's script, beside this module once built; run from the TypeScript source (the tests), the built one. */
function workerScript(): URL {
  const here = new URL(import.meta.url);
  return here.pathname.endsWith('.ts') ? new URL('../dist/delete-worker.js', here) : new URL('./delete-worker.js', here);
}

/** The delete under way: the next waits for it, so two never wait on each other for the store. */
let last: Promise<unknown> = Promise.resolve();

/**
 * Deletes `ids` as `deleteRuns` does, on a thread of its own against the store at `dbPath`, or on
 * this one for a store in memory (`store`). Rejects with a 503 when another command holds the store
 * past its busy timeout, or with what the thread said (500).
 */
export function deleteRunsApart(store: Store, dbPath: string | null | undefined, ids: unknown): Promise<DeleteResult | { error: string }> {
  if (!dbPath || dbPath === ':memory:') return Promise.resolve(deleteRuns(store, ids));
  const run = (): Promise<DeleteResult | { error: string }> =>
    new Promise((resolve, reject) => {
      const worker = new Worker(workerScript(), { workerData: { dbPath, ids } satisfies DeleteWork });
      let settled = false;
      const settle = (done: () => void) => {
        if (settled) return;
        settled = true;
        void worker.terminate().catch(() => undefined);
        done();
      };
      worker.on('message', (m: DeleteAnswer) => settle(() => (m.ok ? resolve(m.result) : reject(new HttpError(m.busy ? 503 : 500, m.busy ? 'the store is busy with another command: delete it again in a moment' : `could not delete: ${m.error}`)))));
      worker.once('error', (err) => settle(() => reject(new HttpError(500, `deleting stopped: ${err.message}`))));
      worker.once('exit', (code) => settle(() => reject(new HttpError(500, `deleting stopped before it was done (exit code ${code})`))));
    });
  const next = last.then(run, run);
  last = next.catch(() => undefined);
  return next;
}
