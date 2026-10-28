import type { QueuedWrites, StoreOf } from '@shadowlap/engine';

/**
 * How the sidecar's writes wait for the store. `waitMs`: the longest one attempt holds the thread for
 * another process's write lock, since the agent's answers stream on the same thread. `deadlineMs`:
 * how long a write keeps being tried, on a timer, before it counts as failed.
 */
export interface StoreWrites {
  waitMs?: number;
  deadlineMs?: number;
}

export const DEFAULT_STORE_WRITES: Required<StoreWrites> = { waitMs: 50, deadlineMs: 10_000 };

/** What of a run a write is: its record (its start, its metadata, its divergence, its end) or its calls. */
export type RunPart = 'run' | 'calls';

/** One write to the store: what it is, the write itself, and what stands in for it when it can't be made. */
export interface StoreWrite {
  /** What it writes, for the log and the run's warning: `call 3's end`. */
  what: string;
  run: () => void;
  /**
   * The run it writes, and what of it: a read of that part of the run in this process makes it
   * first (settle), and waiting for the run (settled) waits for it.
   */
  of?: { runId: string; part: RunPart };
  /** Written in its place when it fails for good (an error end in place of a call's end, saying why), where that can be written. */
  instead?: (reason: string) => void;
  /** Told once when it failed for good, with why; `replaced` when `instead` was written. */
  failed?: (reason: string, replaced: boolean) => void;
  /** Dropped without a word when it fails: a fingerprint the cache can do without. */
  optional?: boolean;
  /**
   * Tried on the timer for as long as another process holds the store, past `deadlineMs`, until the
   * writer stops: a write that must land once it is free (a run's end, without which the run reads as
   * running). What makes writes on demand (settle, flush) still gives it up after the deadline.
   */
  retain?: boolean;
}

interface Queued extends StoreWrite {
  since: number;
}

/** SQLITE_BUSY or SQLITE_LOCKED, extended codes included: another connection holds the lock. */
export function isBusy(err: unknown): boolean {
  const code = (err as { errcode?: unknown } | null)?.errcode;
  return typeof code === 'number' && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

/**
 * The sidecar's writes to the store, made one after another in the order its calls made them. Most
 * are made at once. One that can't take the store's lock within `waitMs` (another process is
 * writing: the dashboard, gc, another recording) waits on a timer, never on the thread the agent's
 * answers stream on, and every write after it waits behind it, so a call's end is never written
 * before its start, nor a call before an earlier one. A write that fails, or is still locked out
 * after `deadlineMs`, is tried once more; then what stands in for it is written where it can be (an
 * error end in place of a call's end), and its run is told. Nothing here throws to the request a
 * write belongs to.
 *
 * It is the store's queue of this process's writes (QueuedWrites): what reads or changes a run in
 * this process makes that run's waiting writes first (settle), as long as the lock may be waited
 * for, so it always finds what was said of the run; and `settled` waits for a run's writes on the
 * writer's own timer, which never holds the thread.
 */
export class StoreWriter implements QueuedWrites {
  private readonly queue: Queued[] = [];
  private timer: NodeJS.Timeout | null = null;
  private backoff = 0;
  private stopped = false;
  /** Set while a write is made: a read it makes of the store must not make the writes behind it first. */
  private making = false;
  /** Those waiting for a run's writes (or every write) to be made: settled. */
  private readonly waiting: Array<{ runId: string | undefined; done: () => void }> = [];
  private readonly waitMs: number;
  private readonly deadlineMs: number;

  constructor(
    private readonly store: StoreOf<'recording'>,
    opts: StoreWrites,
    private readonly log: (line: string) => void,
  ) {
    this.waitMs = Math.max(0, opts.waitMs ?? DEFAULT_STORE_WRITES.waitMs);
    this.deadlineMs = Math.max(this.waitMs, opts.deadlineMs ?? DEFAULT_STORE_WRITES.deadlineMs);
  }

  /** Makes the write at once when nothing is waiting, else after what is. */
  write(write: StoreWrite): void {
    if (this.stopped) return;
    this.queue.push({ ...write, since: Date.now() });
    if (this.queue.length === 1 && this.timer === null) this.drain();
  }

  /** How many writes are waiting for the store. */
  get pending(): number {
    return this.queue.length;
  }

  /** Whether a write of the run waits: of `part` of it, or of any part. */
  holds(runId: string, part?: RunPart): boolean {
    return this.queue.some((w) => w.of?.runId === runId && (part === undefined || w.of.part === part));
  }

  /**
   * Makes every waiting write now, waiting for the lock as long as one write may, so what reads the
   * store next (a replay of a run, the store closing) finds them. A write that still can't be made
   * fails as any other does.
   */
  flush(): void {
    this.makeWhile(() => this.queue.length > 0);
  }

  /**
   * Makes the run's waiting writes (of `part` of it, or all of them) and every write before them, as
   * flush makes them: the store calls this before a read or change of the run (QueuedWrites). Nothing
   * when none waits, and nothing while a write is being made.
   */
  settle(runId: string, part?: RunPart): void {
    if (this.making || !this.holds(runId, part)) return;
    this.makeWhile(() => this.holds(runId, part));
  }

  /**
   * Resolves once no write of the run waits, or none at all without one: each made or given up. It
   * waits on the writer's timer, never on the thread the agents' answers stream on, so a caller
   * that waits for a run's writes before it reads the run never holds an answer up.
   */
  settled(runId?: string): Promise<void> {
    if (this.stopped || !(runId === undefined ? this.queue.length > 0 : this.holds(runId))) return Promise.resolve();
    return new Promise((resolve) => this.waiting.push({ runId, done: resolve }));
  }

  /** Makes what is waiting, then takes no more writes: the sidecar has closed, and its store may close next. */
  stop(): void {
    this.flush();
    this.stopped = true;
    this.wake();
  }

  /** Makes waiting writes, oldest first, while `more` says so, each waiting for the lock as long as one write may. */
  private makeWhile(more: () => boolean): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const until = Date.now() + this.deadlineMs;
    while (more()) {
      const head = this.queue[0]!;
      const error = this.attempt(head.run, Math.max(this.waitMs, until - Date.now()));
      if (error === null) this.queue.shift();
      else this.giveUp(head, error);
    }
    this.backoff = 0;
    this.wake();
    // What still waits behind them goes on as before, on the timer.
    if (this.queue.length && !this.stopped) this.drain();
  }

  private drain(): void {
    this.timer = null;
    while (this.queue.length && !this.stopped) {
      const head = this.queue[0]!;
      const error = this.attempt(head.run, this.waitMs);
      if (error === null) {
        this.queue.shift();
        this.backoff = 0;
        continue;
      }
      if (isBusy(error) && (head.retain || Date.now() - head.since < this.deadlineMs)) {
        // Locked out for now: tried again later, the writes behind it keeping their turn.
        this.backoff = Math.min(500, this.backoff ? this.backoff * 2 : 25);
        this.timer = setTimeout(() => this.drain(), this.backoff);
        this.timer.unref();
        this.wake();
        return;
      }
      this.giveUp(head, error);
    }
    this.wake();
  }

  /** Tells those waiting for writes that are no longer waiting (settled), in the order they asked. */
  private wake(): void {
    const still = (w: { runId: string | undefined }) => !this.stopped && (w.runId === undefined ? this.queue.length > 0 : this.holds(w.runId));
    const done = this.waiting.filter((w) => !still(w));
    if (!done.length) return;
    this.waiting.splice(0, this.waiting.length, ...this.waiting.filter(still));
    for (const w of done) w.done();
  }

  /** A write that failed for good: tried once more, then what stands in for it, and its run told. */
  private giveUp(head: Queued, error: unknown): void {
    this.queue.shift();
    const again = this.attempt(head.run, this.waitMs);
    if (again === null || head.optional) return;
    const reason = describe(again);
    const instead = head.instead;
    const replaced = instead !== undefined && this.attempt(() => instead(reason), this.waitMs) === null;
    this.log(`store: ${head.what} could not be written (${describe(error)})${replaced ? '; kept as an error' : ''}`);
    try {
      head.failed?.(reason, replaced);
    } catch {
      // telling the run is best effort
    }
  }

  /** One attempt, as a transaction; the error when it failed (nothing was written then), else null. */
  private attempt(run: () => void, waitMs: number): unknown {
    this.making = true;
    try {
      this.store.tryWrite(run, waitMs);
      return null;
    } catch (err) {
      return err ?? new Error('the write failed');
    } finally {
      this.making = false;
    }
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return (message.split('\n')[0] ?? '').slice(0, 200);
}
