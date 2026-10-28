import { Worker } from 'node:worker_threads';
import type { Store } from '@shadowlap/engine';
import { HttpError } from './http.js';
import { serverIdle } from './idle.js';
import { runJob, type ReadAnswer, type ReadJob } from './read-jobs.js';
import type { FromReadWorker, ToReadWorker } from './read-worker.js';
import type { RouteRequest } from './router.js';
import type { Keeper } from './run-stats.js';

/**
 * Where the read models that read every call of a run, or of every run (read-jobs.ts), are worked
 * out: on worker threads beside the server, each reading the store through a connection of its own
 * that only reads, so the server's own thread answers every other request meanwhile (/api/meta, the
 * change feed, jobs) however long a first look at a big store takes. A store with no file (in
 * memory) can't be opened from another thread: its read models are worked out on the server's.
 *
 * Requests come first, in the order they came. A job about a run goes to the thread that read that
 * run last, which keeps its calls and its analysis; while that thread is busy with another request,
 * a free thread takes it once it has waited a moment (`READ_LIMITS.stealMs`), rather than wait for a
 * long one (a whole Compare of two long runs takes most of a minute). What can wait is done only
 * while another thread stays free for requests: the whole analysis of a long run whose first page
 * was answered from its first calls, and the warm-up, which works each finished run's totals out
 * ahead, newest first, a slice at a time (run-stats.ts `warmRunStats`). A page of a run's calls, a
 * call's details or a run's first page asked while the run's thread analyses that run, or works on
 * another request about it, is answered on a free thread from a part of the run (`borrowed`), and
 * only one that asks for the whole analysis (`whole`) waits for it. A request a free thread takes
 * leaves the run with the thread that holds it, and one that reads the whole of a long run
 * (`stealCallsMax`) is never taken from it. While what can wait holds one thread and a request the
 * other, a spare thread answers what comes behind them (`Slot.spare`). What a thread works out that
 * is worth keeping comes back here, and goes to the keeper's thread (keeper.ts) to be written.
 */

export interface ReadModels {
  /**
   * Works out a job. `affinity` names the run it reads: the thread that read that run last does, as
   * it keeps it; `calls`, how long that run is (whether another thread may take the job meanwhile).
   */
  run(job: ReadJob, o?: { affinity?: string; calls?: number }): Promise<ReadAnswer>;
  /** The warm-up has been through every run: a read model works out what is still unknown when it is asked for. */
  readonly warmed: boolean;
  /** Has the warm-up go through the runs again, from the newest (an answer said it was warming); a no-op while it runs. */
  warm(): void;
  /** Ends the threads, each having closed its connection to the store. */
  close(): Promise<void>;
}

/** What the threads take: tests lower these. */
export const READ_LIMITS = {
  /**
   * Threads: two, whatever the machine, so one is free for requests while the other works through
   * the warm-up, a batch of which (a long run's prompt cache) can take seconds.
   */
  size: 2,
  /** A slice of the warm-up, in milliseconds: the longest a request waits behind one. */
  warmSliceMs: 250,
  /**
   * How long a request waits for the thread that read its run last while that thread works on
   * another request, before a free thread takes it, in milliseconds.
   */
  stealMs: 100,
  /**
   * The longest run a free thread takes a request that reads the whole of from the thread that holds
   * it, in calls: a longer one waits for that thread, as reading it again elsewhere takes seconds (a
   * run of 100,000 calls' tools took 20.4 s on a thread that didn't hold it, 3.5 s on the one that did).
   */
  stealCallsMax: 20_000,
  /** How long a spare thread (`Slot.spare`) stays with nothing to do and nothing that can wait running, before it ends. */
  spareIdleMs: 10_000,
  /** How long a thread has to close its connection when the dashboard stops, before it is ended. */
  closeMs: 2000,
  /**
   * The longest a thread may work on one job, in milliseconds: past it the thread is ended, the
   * request is answered that it took too long, and a new thread takes the rest. A request, two
   * minutes; what can wait (a long run's whole analysis), ten.
   */
  jobMs: 120_000,
  backgroundMs: 600_000,
};

/** The worker's script, beside this module once built; run from the TypeScript source (the tests), the built one. */
function workerScript(): URL {
  const here = new URL(import.meta.url);
  return here.pathname.endsWith('.ts') ? new URL('../dist/read-worker.js', here) : new URL('./read-worker.js', here);
}

interface Pending {
  id: number;
  job: ReadJob;
  affinity: string | null;
  /** When it was asked (Date.now()): a free thread takes it from a busy one once it has waited `stealMs`. */
  at: number;
  /** What can wait: done only when nothing is asked of the thread. */
  background: boolean;
  /**
   * Taken by a free thread from the thread that keeps its run while that thread analyses the run:
   * answered from a part of the run, it leaves the run that thread's, and the analysis it would ask
   * for (`then`) that thread's to finish.
   */
  borrowed?: boolean;
  /**
   * Taken by a free thread from the thread that holds its run, busy with another request: the run
   * stays that thread's, where the next request about it goes. Moved, it went to a thread that had
   * read it once, the run's next requests reading it again there.
   */
  taken?: boolean;
  /** How many calls its run has, when it is about one (`affinity`): whether a free thread may take it from the thread that holds the run. */
  calls?: number;
  resolve(a: ReadAnswer): void;
  reject(err: Error): void;
}

interface Slot {
  index: number;
  worker: Worker | null;
  ready: boolean;
  busy: Pending | null;
  /** Requests about a run this thread read last. */
  pinned: Pending[];
  /** What can wait for this thread: the whole analysis of the runs it answered from their first calls. */
  later: Pending[];
  /** Ends the thread when the job it is on runs past its time (`READ_LIMITS.jobMs`). */
  limit: ReturnType<typeof setTimeout> | null;
  /**
   * A third thread, started while what can wait (a long run's whole analysis, a slice of the warm-up)
   * holds one thread and a request the other: it takes requests only, and ends once nothing can wait
   * any more and it has had nothing to do for a while (`READ_LIMITS.spareIdleMs`). Without it, a
   * request that came behind both waited: with a run of 100,000 calls being analysed and a whole
   * Compare on the other thread, the Overview, Runs and the run's own first call waited 23.9 s.
   */
  spare?: true;
}

/** A run's thread is remembered for this many runs. */
const OWNERS = 64;

/** A job a part of its run answers, while the whole of it is analysed elsewhere: a page of its calls, a call, its first page. */
const answersFromPart = (job: ReadJob): boolean => (job.kind === 'calls' || job.kind === 'call' ? !job.whole : job.kind === 'run' && job.after === undefined);

/**
 * Whether a free thread takes `p` from the thread that holds its run, busy with `busy` (reading the run
 * `reading`): behind what can wait at once, behind a request once it has waited `stealMs`; one about the
 * run that thread is reading only when a part of the run answers it (it is borrowed), and one that
 * reads a whole run longer than `stealCallsMax` calls never from a thread busy with a request: that
 * thread holds the run and answers it soonest.
 */
function takes(busy: Pending, reading: string | null, p: Pending, now: number): boolean {
  if (!busy.background && now - p.at < READ_LIMITS.stealMs) return false;
  if (p.affinity === reading) return answersFromPart(p.job);
  return busy.background || answersFromPart(p.job) || (p.calls ?? 0) <= READ_LIMITS.stealCallsMax;
}

export class ReadPool implements ReadModels {
  private readonly slots: Slot[];
  /** Requests any thread may answer, oldest first. */
  private readonly shared: Pending[] = [];
  private readonly owners = new Map<string, number>();
  private nextId = 1;
  private warming: 'running' | 'done' = 'running';
  private closing: Promise<void> | null = null;
  /** A look again, once the oldest request waiting for a busy thread has waited `stealMs`. */
  private stealing: ReturnType<typeof setTimeout> | null = null;
  /** The spare thread's end, once it has had nothing to do for `spareIdleMs` (`spareIdle`). */
  private spareTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly o: {
      dbPath: string;
      /** Keeps what a thread worked out, through the server's own connection. */
      keep: Keeper;
      size?: number;
      log?: (line: string) => void;
      /** The threads' script: read-worker.ts built, unless a test gives one of its own. */
      script?: URL;
    },
  ) {
    const size = Math.max(1, o.size ?? READ_LIMITS.size);
    this.slots = Array.from({ length: size }, (_, index) => ({ index, worker: null, ready: false, busy: null, pinned: [], later: [], limit: null }));
    // The threads start with the dashboard, so the page's first request finds one ready; and the
    // warm-up with them, so the first look at the Overview finds totals kept.
    for (const slot of this.slots) this.spawn(slot);
    this.dispatch();
  }

  get warmed(): boolean {
    return this.warming === 'done';
  }

  warm(): void {
    if (this.closing || this.warming === 'running') return;
    this.warming = 'running';
    this.dispatch();
  }

  run(job: ReadJob, o: { affinity?: string; calls?: number } = {}): Promise<ReadAnswer> {
    if (this.closing) return Promise.reject(new HttpError(503, 'the dashboard is stopping'));
    return new Promise<ReadAnswer>((resolve, reject) => {
      const p: Pending = { id: this.nextId++, job, affinity: o.affinity ?? null, at: Date.now(), background: false, ...(o.calls !== undefined ? { calls: o.calls } : {}), resolve, reject };
      const owner = p.affinity === null ? undefined : this.owners.get(p.affinity);
      if (owner !== undefined) this.slots[owner]!.pinned.push(p);
      else this.shared.push(p);
      this.dispatch();
    });
  }

  /**
   * Gives each thread with nothing to do the next thing to do: what was asked of it, then of any,
   * then what waits for a busy one (`unpin`). What can wait runs on one thread at a time, and only
   * while another stays free for the next request: a long run's whole analysis first (on the thread
   * that read the run), then a slice of the warm-up. With one thread, it runs when that one is free.
   */
  private dispatch(): void {
    if (this.closing) return;
    const now = Date.now();
    for (const slot of this.slots) {
      if (slot.busy) continue;
      const next = slot.pinned.shift() ?? this.shared.shift() ?? this.unpin(now);
      if (next) this.start(slot, next);
    }
    const background = this.slots.some((s) => s.busy?.background);
    // What can wait holds a thread and every other is busy: a spare thread takes what came behind them.
    if (background && !this.slots.some((s) => !s.busy) && !this.slots.some((s) => s.spare)) {
      const next = this.shared.shift() ?? this.unpin(now);
      if (next) this.start(this.addSpare(), next);
    }
    this.lookAgain(now);
    this.spareIdle(background);
    if (background) return;
    const idle = this.slots.filter((s) => !s.busy && !s.spare);
    if (idle.length < Math.min(2, this.slots.filter((s) => !s.spare).length)) return;
    const analysing = idle.find((s) => s.later.length);
    if (analysing) return this.start(analysing, analysing.later.shift()!);
    const warm = this.warmSlice();
    if (warm) this.start(idle[0]!, warm);
  }

  /** A spare thread (`Slot.spare`), started for the request about to be given it. */
  private addSpare(): Slot {
    const slot: Slot = { index: this.slots.length, worker: null, ready: false, busy: null, pinned: [], later: [], limit: null, spare: true };
    this.slots.push(slot);
    this.spawn(slot);
    return slot;
  }

  /** Ends the spare thread once nothing can wait any more and it has had nothing to do for `spareIdleMs`. */
  private spareIdle(background: boolean): void {
    const spare = this.slots.find((s) => s.spare);
    if (!spare || spare.busy || background) {
      if (this.spareTimer) clearTimeout(this.spareTimer);
      this.spareTimer = null;
      return;
    }
    if (this.spareTimer) return;
    this.spareTimer = setTimeout(() => {
      this.spareTimer = null;
      const s = this.slots.find((x) => x.spare);
      if (!s || s.busy || this.slots.some((x) => x.busy?.background)) return;
      this.slots.splice(this.slots.indexOf(s), 1);
      for (const [runId, index] of this.owners) if (index === s.index) this.owners.delete(runId);
      this.shared.unshift(...s.pinned.splice(0));
      const worker = s.worker;
      s.worker = null;
      if (worker) {
        worker.postMessage({ type: 'close' } satisfies ToReadWorker);
        setTimeout(() => void worker.terminate().catch(() => undefined), READ_LIMITS.closeMs).unref();
      }
      this.dispatch();
    }, READ_LIMITS.spareIdleMs);
    this.spareTimer.unref();
  }

  /**
   * A request waiting for the thread that read its run last, while that thread is busy: a free
   * thread takes it, reading the run again rather than waiting for what that thread is on. Behind
   * what can wait it is taken at once (at 100,000 calls the page at #50,000 waited 13.8 s for the
   * analysis); behind another request once it has waited `stealMs` (a 30-call run's page waited 77 s
   * for a whole Compare of two runs of 100,000 calls while the other thread was free). One about the
   * run that thread is analysing, or reading for another request, is borrowed when a part of the run
   * answers it (a page of its calls, a call, its first page), leaving the run that thread's; one that
   * needs the whole of it waits for that thread.
   */
  private unpin(now: number): Pending | undefined {
    for (const s of this.slots) {
      const busy = s.busy;
      if (!busy) continue;
      const reading = busy.background ? (busy.job.kind === 'analyse' ? busy.job.runId : null) : busy.affinity;
      const i = s.pinned.findIndex((p) => takes(busy, reading, p, now));
      if (i < 0) continue;
      const p = s.pinned.splice(i, 1)[0]!;
      if (p.affinity === reading) p.borrowed = true;
      p.taken = true;
      return p;
    }
    return undefined;
  }

  /** While a thread is free and a request waits for a busy one, looks again once the oldest of them has waited `stealMs`. */
  private lookAgain(now: number): void {
    if (this.stealing || !this.slots.some((s) => !s.busy)) return;
    let oldest = Infinity;
    for (const s of this.slots) if (s.busy) for (const p of s.pinned) oldest = Math.min(oldest, p.at);
    if (oldest === Infinity) return;
    this.stealing = setTimeout(
      () => {
        this.stealing = null;
        this.dispatch();
      },
      Math.max(1, oldest + READ_LIMITS.stealMs - now),
    );
    this.stealing.unref();
  }

  /** A slice of the warm-up, while it has runs left to go through. */
  private warmSlice(): Pending | undefined {
    if (this.warming !== 'running') return undefined;
    return {
      id: this.nextId++,
      job: { kind: 'warm', budgetMs: READ_LIMITS.warmSliceMs },
      affinity: null,
      at: Date.now(),
      background: true,
      resolve: (a) => {
        if (a.warm?.done) this.warming = 'done';
      },
      // A thread that can't warm the store (its file gone) stops trying; a request starts it again.
      reject: () => {
        this.warming = 'done';
      },
    };
  }

  private start(slot: Slot, p: Pending): void {
    slot.busy = p;
    if (p.affinity !== null && !p.borrowed && !p.taken && !slot.spare) this.own(p.affinity, slot.index);
    if (!slot.worker) this.spawn(slot);
    else if (slot.ready) this.post(slot, { type: 'job', id: p.id, job: p.job });
    this.time(slot, p);
  }

  /** Ends the thread when `p` runs past its time: a job that never ends would hold the thread, and every request for its runs, for good. */
  private time(slot: Slot, p: Pending): void {
    if (slot.limit) clearTimeout(slot.limit);
    const ms = p.background ? READ_LIMITS.backgroundMs : READ_LIMITS.jobMs;
    slot.limit = setTimeout(() => {
      slot.limit = null;
      const worker = slot.worker;
      if (slot.busy !== p || !worker) return;
      const s = ms / 1000;
      this.lost(slot, worker, `a ${p.job.kind} job took more than ${s >= 60 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} s`}`, true);
    }, ms);
    slot.limit.unref();
  }

  private own(runId: string, index: number): void {
    this.owners.delete(runId);
    this.owners.set(runId, index);
    if (this.owners.size > OWNERS) this.owners.delete(this.owners.keys().next().value!);
  }

  private post(slot: Slot, m: ToReadWorker): void {
    slot.worker?.postMessage(m);
  }

  private spawn(slot: Slot): void {
    const worker = new Worker(this.o.script ?? workerScript(), { workerData: { dbPath: this.o.dbPath } });
    slot.worker = worker;
    slot.ready = false;
    worker.on('message', (m: FromReadWorker) => this.heard(slot, worker, m));
    worker.once('error', (err) => this.lost(slot, worker, err.message));
    worker.once('exit', (code) => this.lost(slot, worker, `it ended with code ${code}`));
  }

  private heard(slot: Slot, worker: Worker, m: FromReadWorker): void {
    if (slot.worker !== worker) return;
    switch (m.type) {
      case 'ready':
        slot.ready = true;
        if (slot.busy) this.post(slot, { type: 'job', id: slot.busy.id, job: slot.busy.job });
        else this.dispatch();
        return;
      case 'failed':
        return this.lost(slot, worker, m.error);
      case 'keep':
        // Before the answer that worked it out: what a later job reads finds it kept.
        try {
          if (m.stats) this.o.keep.stats(m.stats);
          if (m.asks) this.o.keep.asks(m.asks);
        } catch (err) {
          this.o.log?.(`could not keep what a read-model thread worked out: ${err instanceof Error ? err.message : String(err)}`);
        }
        return;
      case 'answer':
      case 'error': {
        const p = slot.busy;
        if (!p || p.id !== m.id) return;
        slot.busy = null;
        if (slot.limit) clearTimeout(slot.limit);
        slot.limit = null;
        // A thread built before a kind of job it is given answers nothing for it: that fails, rather than waits for good.
        if (m.type === 'answer' && !m.answer) {
          this.o.log?.(`a read-model thread answered nothing for a ${p.job.kind} job: is the dashboard built?`);
          p.reject(new Error(`no answer for a ${p.job.kind} job`));
        } else if (m.type === 'answer') {
          // A long run answered from its first calls is analysed whole when the thread is free: the
          // thread that holds it, so one answered on another thread (borrowed, taken) leaves it to that one.
          const then = m.answer.then;
          if (then && !p.borrowed && !p.taken && !slot.spare && !slot.later.some((x) => x.job.kind === then.kind && 'runId' in x.job && 'runId' in then && x.job.runId === then.runId)) {
            slot.later.push({ id: this.nextId++, job: then, affinity: null, at: Date.now(), background: true, resolve: () => undefined, reject: () => undefined });
          }
          p.resolve(m.answer);
        } else {
          this.o.log?.(`a read model failed: ${m.error}`);
          p.reject(new Error(m.error.split('\n')[0] ?? m.error));
        }
        return this.dispatch();
      }
      case 'closed':
        return;
    }
  }

  /**
   * A thread that stopped, or was ended because its job ran past its time (`late`): what it was doing
   * fails, what was asked of it goes to the others, and a new one starts when needed.
   */
  private lost(slot: Slot, worker: Worker, why: string, late = false): void {
    if (slot.worker !== worker) return;
    slot.worker = null;
    slot.ready = false;
    if (slot.limit) clearTimeout(slot.limit);
    slot.limit = null;
    void worker.terminate().catch(() => undefined);
    const busy = slot.busy;
    slot.busy = null;
    this.shared.unshift(...slot.pinned.splice(0));
    slot.later.length = 0;
    for (const [runId, index] of this.owners) if (index === slot.index) this.owners.delete(runId);
    if (this.closing) return;
    this.o.log?.(`a read-model thread stopped: ${why}`);
    // A thread that can't open the store fails each job given to it, one at a time, and the warm-up
    // stops at its first: what waits drains, and nothing starts threads for good.
    busy?.reject(late ? new HttpError(503, `${why}, so it was stopped`) : new Error(`the read model's thread stopped: ${why}`));
    this.dispatch();
  }

  close(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.stealing) clearTimeout(this.stealing);
      this.stealing = null;
      if (this.spareTimer) clearTimeout(this.spareTimer);
      this.spareTimer = null;
      const stopping = new HttpError(503, 'the dashboard is stopping');
      for (const p of this.shared.splice(0)) p.reject(stopping);
      await Promise.all(
        this.slots.map(async (slot) => {
          for (const p of [...slot.pinned.splice(0), ...slot.later.splice(0)]) p.reject(stopping);
          const worker = slot.worker;
          if (!worker) return;
          // Its connection closed first, once the job it is on is done; ended regardless after a while.
          const closed = new Promise<void>((resolve) => {
            worker.on('message', (m: FromReadWorker) => m.type === 'closed' && resolve());
            worker.once('exit', () => resolve());
            setTimeout(resolve, READ_LIMITS.closeMs).unref();
          });
          worker.postMessage({ type: 'close' } satisfies ToReadWorker);
          await closed;
          if (slot.limit) clearTimeout(slot.limit);
          slot.limit = null;
          slot.busy?.reject(stopping);
          slot.busy = null;
          slot.worker = null;
          await worker.terminate().catch(() => undefined);
        }),
      );
    })());
  }
}

/**
 * The read models of a store with no file (in memory), worked out on the server's own thread, as no
 * other can open it: each answer whole, what is not known yet worked out as it is asked for (a store
 * in memory is a small one); what can wait right after the answer, and the warm-up in slices of
 * 50 ms while the server answers no request (idle.ts).
 */
export class LocalReads implements ReadModels {
  private warming: 'running' | 'done' = 'running';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private readonly store: () => Store) {
    this.schedule(0);
  }

  get warmed(): boolean {
    return this.warming === 'done';
  }

  warm(): void {
    if (this.stopped || this.warming === 'running') return;
    this.warming = 'running';
    this.schedule(0);
  }

  private schedule(ms: number): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // A request is being answered: its answer goes first.
      if (!serverIdle()) return this.schedule(20);
      void runJob(this.store(), { kind: 'warm', budgetMs: 50 }).then(
        (a) => {
          if (a.warm?.done) this.warming = 'done';
          else this.schedule(20);
        },
        // The store was closed: the dashboard stopped.
        () => {
          this.warming = 'done';
        },
      );
    }, ms);
    this.timer.unref();
  }

  async run(job: ReadJob): Promise<ReadAnswer> {
    const store = this.store();
    const a = await runJob(store, job, { whole: true });
    const then = a.then;
    if (then) setImmediate(() => void runJob(store, then).catch(() => undefined));
    return a;
  }

  close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return Promise.resolve();
  }
}

/** The error a read model's answer that is no 200 is, in its own words: a missing run, a bad request. */
function answerError(a: ReadAnswer): HttpError {
  let error = `HTTP ${a.status}`;
  try {
    error = (JSON.parse(a.body) as { error?: string }).error ?? error;
  } catch {
    // the status says it
  }
  return new HttpError(a.status, error);
}

/** A read model's answer as data, for a route that answers with more than it: an answer that is no 200 is thrown, as sendAnswer throws it. */
export function answerData<T>(a: ReadAnswer): T {
  if (a.status !== 200) throw answerError(a);
  return JSON.parse(a.body) as T;
}

/**
 * Answers a request with a read model's answer: its JSON as worked out, with its ETag (`etag` when
 * the route gives one of its own), so a browser that has it gets a 304; an answer that is still
 * warming without one, since asked again it has more. A missing run or a bad request is an HttpError,
 * which the server answers as it answers any.
 */
export function sendAnswer(r: RouteRequest, a: ReadAnswer, o: { etag?: string | null } = {}): void {
  if (a.status !== 200) throw answerError(a);
  const etag = a.warming ? null : o.etag !== undefined ? o.etag : a.etag;
  if (etag && r.req.headers['if-none-match'] === etag) {
    r.res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    r.res.end();
    return;
  }
  r.res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(a.body)), 'cache-control': etag ? 'no-cache' : 'no-store', ...(etag ? { etag } : {}) });
  r.res.end(a.body);
}
