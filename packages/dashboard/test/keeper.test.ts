import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { KEEP_RETRY_MS, keepQueue } from '../src/keep-queue.js';
import { storeKeeper } from '../src/keeper.js';
import { addRun } from './read-model-store.js';

/**
 * What the read-model threads work out to keep, written on a thread of its own (keeper.ts), so the
 * server's thread never waits for the store's write lock or a checkpoint. A write that finds the
 * store held by another command gives up after a moment, and its rows wait to be written once the
 * store is free; they used to be dropped.
 */

let dir: string;
let dbPath: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-keeper-'));
  dbPath = join(dir, 'shadowlap.db');
  store = Store.open(dbPath);
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const TOTALS = JSON.stringify({ codes: 'l', models: [], notWaitedMs: 0 });
const count = (table: string) => Number(store.query(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);

describe('the rows the keeper’s thread writes', () => {
  it('writes the rows at once while the store is free', () => {
    const run = addRun(store, { startedAt: 1, calls: 'l' });
    const keep = keepQueue(() => store);
    keep.stats([{ runId: run, key: 'k1', stats: TOTALS }]);
    keep.asks([{ runId: run, key: 'k1', ask: null }]);
    expect([count('run_stats'), count('run_asks')]).toEqual([1, 1]);
    keep.close();
  });

  it('keeps the rows while another command holds the store, and writes them once it lets go', () => {
    const runs = Array.from({ length: 1200 }, (_, i) => addRun(store, { startedAt: i + 1, calls: 'l' }));
    vi.useFakeTimers();
    const keep = keepQueue(() => store);
    // Another command writing the store: a batch of the search index, gc's VACUUM, a pull.
    const other = new DatabaseSync(dbPath);
    other.exec('BEGIN IMMEDIATE');
    keep.stats(runs.map((runId) => ({ runId, key: 'k1', stats: TOTALS })));
    keep.asks([{ runId: runs[0], key: 'k1', ask: null }]);
    expect(count('run_stats')).toBe(0);
    // While it still holds the store, the next try finds it held too, and nothing is lost.
    vi.advanceTimersByTime(KEEP_RETRY_MS);
    expect(count('run_stats')).toBe(0);
    other.exec('COMMIT');
    other.close();
    // The try after it writes every row, a slice at a time.
    vi.advanceTimersByTime(2 * KEEP_RETRY_MS);
    vi.runAllTimers();
    expect([count('run_stats'), count('run_asks')]).toEqual([1200, 1]);
    keep.close();
  });

  it('writes nothing once closed, and drops what waits', () => {
    const run = addRun(store, { startedAt: 1, calls: 'l' });
    vi.useFakeTimers();
    const keep = keepQueue(() => store);
    const other = new DatabaseSync(dbPath);
    other.exec('BEGIN IMMEDIATE');
    keep.stats([{ runId: run, key: 'k1', stats: TOTALS }]);
    other.exec('COMMIT');
    other.close();
    keep.close();
    vi.runAllTimers();
    keep.stats([{ runId: run, key: 'k2', stats: TOTALS }]);
    expect(count('run_stats')).toBe(0);
  });
});

describe('the keeper’s thread', () => {
  /** Until `done` holds, as the thread writes: what it has written is what the store holds. */
  const until = async (done: () => boolean) => {
    while (!done()) await new Promise((r) => setTimeout(r, 20));
  };

  it('writes the rows on a thread of its own, the server’s writing none of them', async () => {
    const runs = Array.from({ length: 1200 }, (_, i) => addRun(store, { startedAt: i + 1, calls: 'l' }));
    const own = vi.spyOn(Store.prototype, 'saveRunStats');
    const asks = vi.spyOn(Store.prototype, 'saveRunAsks');
    const keep = storeKeeper(dbPath);
    try {
      keep.stats(runs.map((runId) => ({ runId, key: 'k1', stats: TOTALS })));
      keep.asks([{ runId: runs[0], key: 'k1', ask: null }]);
      await until(() => count('run_stats') === 1200 && count('run_asks') === 1);
      // Written there, through its own connection: this thread's store wrote nothing.
      expect([own.mock.calls.length, asks.mock.calls.length]).toEqual([0, 0]);
    } finally {
      own.mockRestore();
      asks.mockRestore();
      await keep.close();
    }
  });

  it('hands rows over while another command holds the store, and they are written once it lets go', async () => {
    const run = addRun(store, { startedAt: 1, calls: 'l' });
    const other = new DatabaseSync(dbPath);
    other.exec('BEGIN IMMEDIATE');
    const keep = storeKeeper(dbPath);
    try {
      // Handed over at once, the store held or not: nothing here waits for it.
      keep.stats([{ runId: run, key: 'k1', stats: TOTALS }]);
      expect(count('run_stats')).toBe(0);
      other.exec('COMMIT');
      await until(() => count('run_stats') === 1);
    } finally {
      other.close();
      await keep.close();
    }
  });

  it('writes what waits as the dashboard stops, and makes no store where one was deleted', async () => {
    const run = addRun(store, { startedAt: 1, calls: 'l' });
    const keep = storeKeeper(dbPath);
    keep.stats([{ runId: run, key: 'k1', stats: TOTALS }]);
    await keep.close();
    expect(count('run_stats')).toBe(1);
    // Rows for a store gone: dropped, and no file made in its place.
    const gone = join(dir, 'gone', 'shadowlap.db');
    const late = storeKeeper(gone);
    late.stats([{ runId: run, key: 'k1', stats: TOTALS }]);
    await late.close();
    expect(existsSync(gone)).toBe(false);
  });
});
