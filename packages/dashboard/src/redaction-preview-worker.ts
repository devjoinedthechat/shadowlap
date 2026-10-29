import { parentPort, workerData } from 'node:worker_threads';
import { Store, messageOf, previewRedaction, setPatternBudget } from '@shadowlap/engine';
import { BUSY, type PreviewAnswer, type PreviewWork } from './redaction-preview.js';

/**
 * The redaction preview, read on a thread of its own so the dashboard server goes on answering
 * meanwhile (redaction-preview.ts starts it): the store on a connection of its own, the run read
 * within the limits it was given, and the preview posted back, or why there is none. The server
 * ends this thread when a rule takes too long on one call, or the page stops waiting.
 */

const work = workerData as PreviewWork;
// The server ends this thread when one call takes longer than the preview's hard limit, and says
// which rule could: the engine's own budget would only end it sooner, with less to say.
setPatternBudget(Infinity);
const post = (m: PreviewAnswer) => parentPort?.postMessage(m);
let store: Store | null = null;
let answer: PreviewAnswer;
try {
  store = Store.open(work.dbPath);
  // Its time starts now: opening waited for any command holding the store.
  post({ type: 'open' });
  const deadline = Date.now() + work.limits.softMs;
  answer = { type: 'answer', ok: true, preview: previewRedaction(store, work.runId, work.rules, { maxCalls: work.limits.maxCalls, maxBytes: work.limits.maxBytes, deadline }) };
} catch (err) {
  const error = messageOf(err);
  answer = { type: 'answer', ok: false, error, busy: BUSY.test(error) };
} finally {
  // Closed before the answer goes: the server ends the thread once it has it, which can stop it
  // before a close after it, and Windows can't delete or move the store's file while it is open.
  store?.close();
}
post(answer);
