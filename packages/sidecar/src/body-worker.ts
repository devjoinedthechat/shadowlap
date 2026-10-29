import { parentPort } from 'node:worker_threads';
import type { BodyAnswer, BodyJob } from './body-threads.js';
import { storedRequestBody, storedResponse } from './http.js';

/**
 * A thread that stores captured calls' bodies (body-threads.ts starts it): each masked as the
 * sidecar's own thread masks one, and posted back as stored. One it can't store (a body too long to
 * read as text) is answered as failed, and the next is stored as ever.
 */
parentPort?.on('message', (job: BodyJob) => {
  let answer: BodyAnswer;
  const moved: ArrayBuffer[] = [];
  try {
    const bytes = Buffer.from(job.bytes.buffer, job.bytes.byteOffset, job.bytes.byteLength);
    if (job.kind === 'request') answer = { id: job.id, kind: 'request', stored: storedRequestBody(bytes, job.contentType) };
    else {
      // A buffer of its own, moved to the sidecar's thread rather than copied there.
      const stored = storedResponse(job.head, bytes);
      const blob = new Uint8Array(stored.byteLength);
      blob.set(stored);
      moved.push(blob.buffer);
      answer = { id: job.id, kind: 'response', blob };
    }
  } catch {
    answer = { id: job.id, kind: 'failed' };
  }
  parentPort?.postMessage(answer, moved);
});
