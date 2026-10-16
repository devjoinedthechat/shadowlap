import { parentPort, workerData } from 'node:worker_threads';
import { Store, previewRedaction } from '@shadowlap/engine';
import type { PreviewAnswer, PreviewWork } from './redaction-preview.js';

/**
 * The redaction preview, read on a thread of its own so the dashboard server goes on answering
 * meanwhile (redaction-preview.ts starts it): the store on a connection of its own, the run read
 * within the limits it was given, and the preview posted back, or why there is none. The server
 * ends this thread when a rule takes too long on one call, or the page stops waiting.
 */

const work = workerData as PreviewWork;
let answer: PreviewAnswer;
let store: Store | null = null;
try {
  const deadline = Date.now() + work.limits.softMs;
  store = Store.open(work.dbPath);
  answer = { ok: true, preview: previewRedaction(store, work.runId, work.rules, { maxCalls: work.limits.maxCalls, maxBytes: work.limits.maxBytes, deadline }) };
} catch (err) {
  answer = { ok: false, error: err instanceof Error ? err.message : String(err) };
} finally {
  store?.close();
}
parentPort?.postMessage(answer);
