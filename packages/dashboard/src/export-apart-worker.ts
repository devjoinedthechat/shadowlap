import { parentPort, workerData } from 'node:worker_threads';
import { setPatternBudget, Store } from '@shadowlap/engine';
import type { ExportAnswer, ExportWork } from './export-apart.js';
import { BUSY } from './redaction-preview.js';
import { exportHtml } from './static.js';

/**
 * The HTML download, made on a thread of its own so the dashboard server goes on answering meanwhile
 * (export-apart.ts starts it): the store on a connection of its own, the file made as `shadowlap
 * export html --lineage` makes it, and posted back, or why there is none. The server ends this
 * thread when making the file takes too long.
 */

const work = workerData as ExportWork;
// The server ends this thread when making the file takes longer than its hard limit, and says a
// rule may: the engine's own budget would only end it sooner, with less to say.
setPatternBudget(Infinity);
const post = (m: ExportAnswer) => parentPort?.postMessage(m);
let store: Store | null = null;
let answer: ExportAnswer;
try {
  store = Store.open(work.dbPath);
  // Its time starts now: opening waited for any command holding the store.
  post({ type: 'open' });
  const result = exportHtml({ store, runIds: work.runIds, redact: work.redact, version: work.version, ...(work.prices ? { prices: work.prices } : {}), ...(work.uiDir ? { uiDir: work.uiDir } : {}) });
  answer = { type: 'answer', ok: true, result };
} catch (err) {
  const error = err instanceof Error ? err.message : String(err);
  answer = { type: 'answer', ok: false, error, busy: BUSY.test(error) };
} finally {
  // Closed before the answer goes: the server ends the thread once it has it, which can stop it
  // before a close after it, and Windows can't delete or move the store's file while it is open.
  store?.close();
}
post(answer);
