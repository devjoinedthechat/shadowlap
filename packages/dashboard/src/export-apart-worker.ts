import { parentPort, workerData } from 'node:worker_threads';
import { Store } from '@shadowlap/engine';
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
const post = (m: ExportAnswer) => parentPort?.postMessage(m);
let store: Store | null = null;
try {
  store = Store.open(work.dbPath);
  // Its time starts now: opening waited for any command holding the store.
  post({ type: 'open' });
  const result = exportHtml({ store, runIds: work.runIds, redact: work.redact, version: work.version, ...(work.prices ? { prices: work.prices } : {}), ...(work.uiDir ? { uiDir: work.uiDir } : {}) });
  post({ type: 'answer', ok: true, result });
} catch (err) {
  const error = err instanceof Error ? err.message : String(err);
  post({ type: 'answer', ok: false, error, busy: BUSY.test(error) });
} finally {
  store?.close();
}
