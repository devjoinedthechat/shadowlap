import { Worker } from 'node:worker_threads';
import { withSecretNames, type SecretNamesRule } from '@shadowlap/engine';
import { storedRequestBody, storedResponse, unreadBody, unreadResult, type ResponseHead, type StoredBody } from './http.js';

/**
 * Where a captured call's body is stored from. Storing one masks its credentials by its shape
 * (storedRequestBody, storedResponse), which reads the whole body: a few to 60 milliseconds a
 * megabyte for what services send (JSON, a page, an event stream, lines of JSON), up to 400 for text
 * shaped to be slow (`{"a":` over and over, never closed), and a body can be hundreds of megabytes.
 * The sidecar's thread carries every agent's model streams and calls meanwhile, so a body of
 * BODY_THREADS.apartBytes or more is stored on a thread of its own, and the sidecar's goes on; a
 * shorter one holds it a few milliseconds, 25 at most, and is stored there. What is stored is the
 * same either way, and the call is answered once it is, as before. A thread that stops before it
 * answers (its memory ran out, or the sidecar closed) leaves the body stored as a placeholder, as a
 * masking that can't read one does.
 */

/** What the threads take: tests lower these. */
export const BODY_THREADS = {
  /** A body this many bytes long or longer is stored on a thread of its own. */
  apartBytes: 64 * 1024,
  /** Threads at most: one storing a body shaped to be slow leaves the next body to another. */
  size: 2,
};

/**
 * A body to store on a thread: a request's, read by its content type and the name of the call that
 * sends it, or an answer's; with a secret's names read under the run's rule (`secretNames`,
 * RunMeta.secretNames).
 */
type BodyWork = ({ kind: 'request'; bytes: Uint8Array; contentType: string | undefined; callName?: string } | { kind: 'response'; bytes: Uint8Array; head: ResponseHead }) & { secretNames: SecretNamesRule };

/** A body as a thread is given it, with the id its answer comes back with. */
export type BodyJob = BodyWork & { id: number };

/** What a thread answers: the request body as stored, the stored blob of a response, or that it couldn't store the body. */
export type BodyAnswer = { id: number; kind: 'request'; stored: StoredBody } | { id: number; kind: 'response'; blob: Uint8Array } | { id: number; kind: 'failed' };

interface Thread {
  worker: Worker;
  /** Each body given to it and not answered yet, by id. */
  waiting: Map<number, (answer: BodyAnswer | null) => void>;
}

/**
 * The thread's script: beside this module once built (dist/). Run from its TypeScript source (the
 * tests), this module starts the built script, since Node starts a worker from JavaScript.
 */
function workerScript(): URL {
  const here = new URL(import.meta.url);
  return here.pathname.endsWith('.ts') ? new URL('../dist/body-worker.js', here) : new URL('./body-worker.js', here);
}

export class BodyThreads {
  private readonly threads: Thread[] = [];
  private nextId = 1;
  private closed = false;

  /** A request body as stored (storedRequestBody), the call that sends it named (`callName`), a secret's names read under the run's rule (`secretNames`). */
  async request(bytes: Buffer, contentType: string | undefined, secretNames: SecretNamesRule = 2, callName?: string): Promise<StoredBody> {
    if (bytes.length < BODY_THREADS.apartBytes) return withSecretNames(secretNames, () => storedRequestBody(bytes, contentType, callName));
    const answer = await this.apart({ kind: 'request', bytes, contentType, secretNames, ...(callName === undefined ? {} : { callName }) });
    return answer?.kind === 'request' ? answer.stored : unreadBody();
  }

  /** An answer as stored (storedResponse), its blob, a secret's names read under the run's rule (`secretNames`). */
  async response(head: ResponseHead, bytes: Buffer, secretNames: SecretNamesRule = 2): Promise<Buffer> {
    if (bytes.length < BODY_THREADS.apartBytes) return withSecretNames(secretNames, () => storedResponse(head, bytes));
    const answer = await this.apart({ kind: 'response', bytes, head, secretNames });
    return answer?.kind === 'response' ? Buffer.from(answer.blob.buffer, answer.blob.byteOffset, answer.blob.byteLength) : unreadResult(head.status);
  }

  /** Ends the threads. A body one still stores is stored as a placeholder: its call is one whose agent has left. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.threads.splice(0).map((t) => t.worker.terminate()));
  }

  /** The body stored on a thread: the answer, or null when the thread stopped first or the threads have ended. */
  private apart(work: BodyWork): Promise<BodyAnswer | null> {
    if (this.closed) return Promise.resolve(null);
    const thread = this.thread();
    const id = this.nextId++;
    return new Promise((resolve) => {
      thread.waiting.set(id, resolve);
      // Copied over: the sidecar still forwards these bytes, or answers the agent with them.
      thread.worker.postMessage({ ...work, id } satisfies BodyJob);
    });
  }

  /** A thread with nothing to store, else a new one while there are fewer than BODY_THREADS.size, else the one with the least. */
  private thread(): Thread {
    const free = this.threads.find((t) => t.waiting.size === 0);
    if (free) return free;
    if (this.threads.length < BODY_THREADS.size) return this.start();
    return this.threads.reduce((least, t) => (t.waiting.size < least.waiting.size ? t : least));
  }

  private start(): Thread {
    // It never keeps the process running: a call waiting on it does, through its agent's connection.
    const worker = new Worker(workerScript());
    worker.unref();
    const thread: Thread = { worker, waiting: new Map() };
    worker.on('message', (answer: BodyAnswer) => {
      thread.waiting.get(answer.id)?.(answer);
      thread.waiting.delete(answer.id);
    });
    const stopped = () => {
      const at = this.threads.indexOf(thread);
      if (at >= 0) this.threads.splice(at, 1);
      for (const resolve of thread.waiting.values()) resolve(null);
      thread.waiting.clear();
    };
    worker.once('error', stopped);
    worker.once('exit', stopped);
    this.threads.push(thread);
    return thread;
  }
}
