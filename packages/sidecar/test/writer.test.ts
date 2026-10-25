import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { isBusy, StoreWriter } from '../src/writer.js';

/**
 * The sidecar's store writer: writes made in the order the calls made them, never waiting long on
 * the thread that streams answers, retried while another process holds the store, and replaced by
 * what stands in for them when they can't be made.
 */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-writer-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !ready(); await sleep(5)) if (Date.now() > end) throw new Error('timed out waiting');
}

/** A store at a fresh path, a second connection to it, and the rows a write leaves (a blob per write, named by its bytes). */
function opened(name: string) {
  const path = join(dir, `${name}.db`);
  const store = Store.open(path);
  const other = new DatabaseSync(path);
  const written = () => other.prepare(`SELECT bytes FROM blobs ORDER BY rowid`).all().map((r) => Buffer.from(r.bytes as Uint8Array).toString('utf8'));
  return { path, store, other, written };
}

describe('the store writer', () => {
  it('writes at once, in order, when the store is free', () => {
    const { store, other, written } = opened('free');
    const writer = new StoreWriter(store, { waitMs: 20, deadlineMs: 1_000 }, () => {});
    for (const w of ['one', 'two', 'three']) writer.write({ what: w, run: () => store.putBlob(Buffer.from(w)) });
    expect(writer.pending).toBe(0);
    expect(written()).toEqual(['one', 'two', 'three']);
    other.close();
    store.close();
  });

  it('waits on a timer while another process holds the store, the writes behind keeping their turn', async () => {
    const { store, other, written } = opened('held');
    const logs: string[] = [];
    const writer = new StoreWriter(store, { waitMs: 10, deadlineMs: 5_000 }, (l) => logs.push(l));
    other.exec('BEGIN IMMEDIATE');
    const started = Date.now();
    for (const w of ['one', 'two', 'three']) writer.write({ what: w, run: () => store.putBlob(Buffer.from(w)) });
    // Each attempt waited 10 ms at most: the thread is free.
    expect(Date.now() - started).toBeLessThan(200);
    expect(writer.pending).toBe(3);
    await sleep(100);
    expect(writer.pending).toBe(3);
    other.exec('COMMIT');
    await until(() => writer.pending === 0);
    expect(written()).toEqual(['one', 'two', 'three']);
    expect(logs).toEqual([]);
    other.close();
    store.close();
  });

  it('gives a write up after its deadline: tried once more, then what stands in for it, and says so', async () => {
    const { store, other, written } = opened('deadline');
    const logs: string[] = [];
    const failed: Array<[string, boolean]> = [];
    const writer = new StoreWriter(store, { waitMs: 5, deadlineMs: 150 }, (l) => logs.push(l));
    other.exec('BEGIN IMMEDIATE');
    writer.write({ what: "call 1's answer", run: () => store.putBlob(Buffer.from('answer')), instead: () => store.putBlob(Buffer.from('error end')), failed: (reason, replaced) => failed.push([reason, replaced]) });
    await until(() => failed.length === 1, 3_000);
    // Still locked: nothing could stand in for it either.
    expect(failed[0][1]).toBe(false);
    expect(failed[0][0]).toMatch(/locked/);
    expect(logs.join('\n')).toMatch(/call 1's answer could not be written/);
    other.exec('COMMIT');
    // The writes after it are made as usual.
    writer.write({ what: 'next', run: () => store.putBlob(Buffer.from('next')) });
    expect(written()).toEqual(['next']);
    other.close();
    store.close();
  });

  it('replaces a write that fails for another reason, after trying it once more, and tells its run why', () => {
    const { store, other, written } = opened('failing');
    let tries = 0;
    const failed: Array<[string, boolean]> = [];
    const writer = new StoreWriter(store, { waitMs: 5, deadlineMs: 1_000 }, () => {});
    writer.write({
      what: "call 1's answer",
      run: () => {
        tries++;
        store.putBlob(Buffer.from('half written'));
        throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      },
      instead: (reason) => store.putBlob(Buffer.from(`error end: ${reason}`)),
      failed: (reason, replaced) => failed.push([reason, replaced]),
    });
    expect(tries).toBe(2);
    // Each attempt was one transaction: what it wrote before failing is gone.
    expect(written()).toEqual(['error end: disk I/O error']);
    expect(failed).toEqual([['disk I/O error', true]]);
    other.close();
    store.close();
  });

  it('drops an optional write that fails, without a word', () => {
    const { store, other, written } = opened('optional');
    const logs: string[] = [];
    const writer = new StoreWriter(store, { waitMs: 5, deadlineMs: 1_000 }, (l) => logs.push(l));
    writer.write({ what: 'a cache entry', optional: true, run: () => { throw new Error('no room'); } });
    writer.write({ what: 'after', run: () => store.putBlob(Buffer.from('after')) });
    expect(written()).toEqual(['after']);
    expect(logs).toEqual([]);
    other.close();
    store.close();
  });

  it('flushes what waits, waiting for the lock as a write may, and takes nothing once stopped', async () => {
    const { path, store, other, written } = opened('flush');
    const writer = new StoreWriter(store, { waitMs: 5, deadlineMs: 5_000 }, () => {});
    // Another thread holds the store for 300 ms, as another process would, and says when it let go.
    const holder = new Worker(
      `const { DatabaseSync } = require('node:sqlite'); const { parentPort, workerData } = require('node:worker_threads');
       const db = new DatabaseSync(workerData); db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('held');
       setTimeout(() => { const at = Date.now(); db.exec('COMMIT'); db.close(); parentPort.postMessage(at); }, 300);`,
      { eval: true, workerData: path },
    );
    await new Promise<void>((resolve) => holder.once('message', () => resolve()));
    writer.write({ what: 'waits', run: () => store.putBlob(Buffer.from('waits')) });
    expect(writer.pending).toBe(1);
    writer.flush();
    const flushed = Date.now();
    expect(writer.pending).toBe(0);
    // The flush waited for the other thread to let go of the store, then wrote.
    const letGo = await new Promise<number>((resolve) => holder.once('message', (at: number) => resolve(at)));
    expect(flushed).toBeGreaterThanOrEqual(letGo);
    writer.stop();
    writer.write({ what: 'too late', run: () => store.putBlob(Buffer.from('too late')) });
    expect(written()).toEqual(['waits']);
    await holder.terminate();
    other.close();
    store.close();
  });

  it("tells a run's writes from another's, and says on its timer when a run's have all been made", async () => {
    const { store, other, written } = opened('settled');
    const writer = new StoreWriter(store, { waitMs: 5, deadlineMs: 5_000 }, () => {});
    other.exec('BEGIN IMMEDIATE');
    const put = (w: string, runId: string, part: 'run' | 'calls') => writer.write({ what: w, of: { runId, part }, run: () => store.putBlob(Buffer.from(w)) });
    put('R start', 'R', 'run');
    put('R call', 'R', 'calls');
    put('S call', 'S', 'calls');
    expect([writer.holds('R'), writer.holds('R', 'calls'), writer.holds('S', 'run'), writer.holds('T')]).toEqual([true, true, false, false]);
    const done: string[] = [];
    void writer.settled('R').then(() => done.push('R'));
    void writer.settled().then(() => done.push('all'));
    void writer.settled('T').then(() => done.push('T'));
    await sleep(60);
    // Nothing of R can be made while the store is held, and nothing of T was ever waiting.
    expect(done).toEqual(['T']);
    other.exec('COMMIT');
    await until(() => done.length === 3);
    expect(done).toEqual(['T', 'R', 'all']);
    expect(written()).toEqual(['R start', 'R call', 'S call']);
    other.close();
    store.close();
  });

  it("settles a run's writes on demand, with every write queued before them, and never from inside a write", async () => {
    const { path, store, other, written } = opened('settle');
    const writer = new StoreWriter(store, { waitMs: 5, deadlineMs: 5_000 }, () => {});
    const holder = new Worker(
      `const { DatabaseSync } = require('node:sqlite'); const { parentPort, workerData } = require('node:worker_threads');
       const db = new DatabaseSync(workerData); db.exec('BEGIN IMMEDIATE'); parentPort.postMessage('held');
       setTimeout(() => { db.exec('COMMIT'); db.close(); parentPort.postMessage('let go'); }, 200);`,
      { eval: true, workerData: path },
    );
    await new Promise<void>((resolve) => holder.once('message', () => resolve()));
    const put = (w: string, runId: string, part: 'run' | 'calls', also?: () => void) =>
      writer.write({
        what: w,
        of: { runId, part },
        run: () => {
          store.putBlob(Buffer.from(w));
          also?.();
        },
      });
    put('S call', 'S', 'calls');
    put('R start', 'R', 'run');
    // A write that reads its own run, as a write of a run's metadata does: no settling from within it.
    put('R end', 'R', 'run', () => writer.settle('R'));
    put('R call', 'R', 'calls');
    writer.settle('R', 'run');
    // R's record waited for the lock, after S's call; R's call, queued after, went on as the timer has it.
    expect(written().slice(0, 3)).toEqual(['S call', 'R start', 'R end']);
    await until(() => writer.pending === 0);
    expect(written()).toEqual(['S call', 'R start', 'R end', 'R call']);
    await holder.terminate();
    other.close();
    store.close();
  });

  it('reads SQLITE_BUSY and SQLITE_LOCKED as busy, extended codes included', () => {
    expect(isBusy({ errcode: 5 })).toBe(true);
    expect(isBusy({ errcode: 517 })).toBe(true);
    expect(isBusy({ errcode: 6 })).toBe(true);
    expect(isBusy({ errcode: 10 })).toBe(false);
    expect(isBusy(new Error('x'))).toBe(false);
  });
});
