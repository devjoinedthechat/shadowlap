import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { KEEP_RETRY_MS, storeKeeper } from '../src/keeper.js';
import { addRun } from './read-model-store.js';

/**
 * What the read-model threads work out to keep, written through the server's connection. A write
 * that finds the store held by another command gives up after a moment, so the server's thread
 * never waits on it; its rows used to be dropped then. They wait now, and are written once the store
 * is free.
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

describe('keeping what the read models work out', () => {
  it('writes the rows at once while the store is free', () => {
    const run = addRun(store, { startedAt: 1, calls: 'l' });
    const keep = storeKeeper(() => store);
    keep.stats([{ runId: run, key: 'k1', stats: TOTALS }]);
    keep.asks([{ runId: run, key: 'k1', ask: null }]);
    expect([count('run_stats'), count('run_asks')]).toEqual([1, 1]);
    keep.close();
  });

  it('keeps the rows while another command holds the store, and writes them once it lets go', () => {
    const runs = Array.from({ length: 1200 }, (_, i) => addRun(store, { startedAt: i + 1, calls: 'l' }));
    vi.useFakeTimers();
    const keep = storeKeeper(() => store);
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
    const keep = storeKeeper(() => store);
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
