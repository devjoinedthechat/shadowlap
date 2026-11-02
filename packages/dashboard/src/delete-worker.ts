import { parentPort, workerData } from 'node:worker_threads';
import { Store, messageOf } from '@shadowlap/engine';
import type { DeleteAnswer, DeleteWork } from './delete-apart.js';
import { BUSY } from './redaction-preview.js';
import { deleteRuns } from './runs-list.js';

/**
 * Deletes runs on a thread of its own, so the dashboard server goes on answering meanwhile
 * (delete-apart.ts starts it): the store on a connection of its own, the runs deleted as the Runs
 * page deletes them (`deleteRuns`), and what came of it posted back, or why it could not.
 */

const work = workerData as DeleteWork;
const post = (m: DeleteAnswer) => parentPort?.postMessage(m);
let store: Store | null = null;
let answer: DeleteAnswer;
try {
  // Only a store that is there: one deleted meanwhile is not made again.
  store = Store.openExisting(work.dbPath);
  answer = { ok: true, result: deleteRuns(store, work.ids) };
} catch (err) {
  const error = messageOf(err);
  answer = { ok: false, error, busy: BUSY.test(error) };
} finally {
  // Closed before the answer goes: the server ends the thread once it has it, and Windows can't
  // delete or move the store's file while it is open.
  store?.close();
}
post(answer);
