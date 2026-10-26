import { Worker } from 'node:worker_threads';
import type { Store } from '@shadowlap/engine';
import { catchUpSearch, indexRecordings } from './search-hits.js';
import type { FromSearchWorker, ToSearchWorker } from './search-worker.js';

/**
 * Where a store's search index is brought up to date (search-hits.ts says what goes in it): for a
 * store with a file, on a thread of its own with a connection of its own (search-worker.ts), so the
 * server's thread reads and writes none of it (a 10,000-run store took 36 s of its time, in slices
 * whatever the traffic); for a store in memory, which no other thread can open, on the server's
 * thread while it answers no request. Searches are answered from what the index holds, by the read
 * models (read-jobs.ts `search`).
 */
export interface SearchIndex {
  /** Has the index brought up to date: runs that arrived or ended, calls a recording made. */
  look(): void;
  /**
   * Takes in what the runs still recording said since the index last looked, for 20 ms at most:
   * what a search waits for, so a recording's newest call is in its answer. Waits `waitMs` at most
   * for the thread, which may be in the middle of a slice.
   */
  recordings(waitMs?: number): Promise<void>;
  close(): Promise<void>;
}

/** What the thread is given: tests lower these. */
export const SEARCH_LIMITS = {
  /** How long a search waits for the recordings to be taken in before it answers from what the index holds. */
  recordingsMs: 300,
  /** How long the thread has to close its connection when the dashboard stops, before it is ended. */
  closeMs: 2000,
  /** After the thread stopped: the first wait before it is started again, doubled each time after, up to a minute. */
  restartMs: 1000,
};

/** The worker's script, beside this module once built; run from the TypeScript source (the tests), the built one. */
function workerScript(): URL {
  const here = new URL(import.meta.url);
  return here.pathname.endsWith('.ts') ? new URL('../dist/search-worker.js', here) : new URL('./search-worker.js', here);
}

export class SearchIndexer implements SearchIndex {
  private worker: Worker | null = null;
  private readonly waiting = new Map<number, () => void>();
  private nextId = 1;
  private stops = 0;
  private startAfter = 0;
  private closing: Promise<void> | null = null;

  constructor(private readonly o: { dbPath: string; log?: (line: string) => void; script?: URL }) {
    // From the start, so the first search finds the index caught up.
    this.look();
  }

  look(): void {
    this.post({ type: 'look' });
  }

  recordings(waitMs = SEARCH_LIMITS.recordingsMs): Promise<void> {
    const id = this.nextId++;
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      this.waiting.set(id, done);
      if (!this.post({ type: 'recordings', id })) done();
    });
  }

  /** Posts to the thread, starting it when it isn't running; false when it can't be now. */
  private post(m: ToSearchWorker): boolean {
    const worker = this.worker ?? this.start();
    worker?.postMessage(m);
    return !!worker;
  }

  private start(): Worker | null {
    if (this.closing || Date.now() < this.startAfter) return null;
    const worker = new Worker(this.o.script ?? workerScript(), { workerData: { dbPath: this.o.dbPath } });
    this.worker = worker;
    worker.on('message', (m: FromSearchWorker) => {
      if (m.type === 'recorded') this.waiting.get(m.id)?.();
      else if (m.type === 'ready') this.stops = 0;
      else if (m.type === 'failed') this.lost(worker, m.error);
    });
    worker.once('error', (err) => this.lost(worker, err.message));
    worker.once('exit', (code) => this.lost(worker, `it ended with code ${code}`));
    return worker;
  }

  /** A thread that stopped: what waits for it goes on, and the next search starts another, after a while if this keeps happening. */
  private lost(worker: Worker, why: string): void {
    if (this.worker !== worker) return;
    this.worker = null;
    void worker.terminate().catch(() => undefined);
    for (const done of [...this.waiting.values()]) done();
    if (this.closing) return;
    this.stops++;
    this.startAfter = Date.now() + Math.min(60_000, SEARCH_LIMITS.restartMs * 2 ** (this.stops - 1));
    this.o.log?.(`the search index's thread stopped: ${why}`);
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      const worker = this.worker;
      this.worker = null;
      for (const done of [...this.waiting.values()]) done();
      if (!worker) return;
      // Its connection closed first; ended regardless after a while.
      await new Promise<void>((resolve) => {
        worker.on('message', (m: FromSearchWorker) => m.type === 'closed' && resolve());
        worker.once('exit', () => resolve());
        setTimeout(resolve, SEARCH_LIMITS.closeMs).unref();
        worker.postMessage({ type: 'close' } satisfies ToSearchWorker);
      });
      await worker.terminate().catch(() => undefined);
    })());
  }
}

/** The search index of a store in memory, brought up to date on the server's thread while it answers no request. */
export class LocalSearch implements SearchIndex {
  constructor(private readonly store: () => Store) {
    this.look();
  }

  look(): void {
    try {
      catchUpSearch(this.store());
    } catch {
      // a store that can't be read now is looked at again with the next search
    }
  }

  recordings(): Promise<void> {
    try {
      indexRecordings(this.store());
    } catch {
      // the slices try again
    }
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
