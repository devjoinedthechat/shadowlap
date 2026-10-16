import { parentPort, workerData } from 'node:worker_threads';
import { Store, previewRedaction } from '@shadowlap/engine';
import { BUSY, type PreviewAnswer, type PreviewWork } from './redaction-preview.js';

/**
 * The redaction preview, read on a thread of its own so the dashboard server goes on answering
 * meanwhile (redaction-preview.ts starts it): the store on a connection of its own, the run read
 * within the limits it was given, and the preview posted back, or why there is none. The server
 * ends this thread when a rule takes too long on one call, or the page stops waiting.
 */

const work = workerData as PreviewWork;
const post = (m: PreviewAnswer) => parentPort?.postMessage(m);
let store: Store | null = null;
try {
  store = Store.open(work.dbPath);
  // Its time starts now: opening waited for any command holding the store.
  post({ type: 'open' });
  const deadline = Date.now() + work.limits.softMs;
  post({ type: 'answer', ok: true, preview: previewRedaction(store, work.runId, work.rules, { maxCalls: work.limits.maxCalls, maxBytes: work.limits.maxBytes, deadline }) });
} catch (err) {
  const error = err instanceof Error ? err.message : String(err);
  post({ type: 'answer', ok: false, error, busy: BUSY.test(error) });
} finally {
  store?.close();
}
