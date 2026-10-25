import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { answeringRequest } from '../src/idle.js';
import { startDashboard } from '../src/index.js';
import { catchUpSearch, searchBehind } from '../src/search-hits.js';
import { addRun, DAY, type CallSpec } from './read-model-store.js';

/**
 * A store's search index is brought up to date beside the requests: for a store with a file on a
 * thread of its own, with a connection of its own, so the server's thread reads and writes none of it
 * (a 10,000-run store took 36 s of its time, in 50 ms slices every 20 ms whatever the traffic); for a
 * store in memory, which no other thread can open, on the server's thread while it answers no request.
 */

const NOW = Date.UTC(2026, 9, 1, 10, 15);
const TEXT = 'Order A-1042 was charged twice. Refund the second charge, tell the customer when the money is back, and note the ticket so the next agent sees what was done.';
const say = (n: number, scope: string): CallSpec => ({ code: 'l', scope, request: { model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: `${TEXT} Ticket T-${n}.` }] } });

describe('the search index of a store with a file', () => {
  let dir: string;
  let dbPath: string;
  let store: Store;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sl-search-index-'));
    dbPath = join(dir, 'shadowlap.db');
    store = Store.open(dbPath);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is brought up to date on a thread of its own, the server’s thread answering requests and nothing else', async () => {
    const RUNS = 1200;
    store.transaction(() => {
      for (let i = 0; i < RUNS; i++) addRun(store, { startedAt: NOW - DAY + i * 1000, calls: Array.from({ length: 8 }, (_, k) => say(i * 8 + k, `s${k}`)) });
    });
    const d = await startDashboard({ store, dbPath, port: 0 });
    // From once it has started: what its thread does meanwhile is answer the searches.
    const delay = monitorEventLoopDelay({ resolution: 5 });
    const before = performance.eventLoopUtilization();
    delay.enable();
    try {
      // The palette's question, asked again until the index has every run.
      const t0 = performance.now();
      let asked = 0;
      for (;;) {
        const res = await fetch(`${d.url}/api/search?q=refund&limit=10`, { headers: { 'x-shadowlap-token': d.token } });
        const answer = (await res.json()) as { hits: unknown[]; indexing?: { runs: number } };
        asked++;
        if (!answer.indexing) {
          expect(answer.hits).toHaveLength(10);
          break;
        }
        expect(performance.now() - t0, 'the index never caught up').toBeLessThan(120_000);
        await new Promise((r) => setTimeout(r, 100));
      }
      const took = performance.now() - t0;
      const used = performance.eventLoopUtilization(before);
      delay.disable();
      // Written through the thread's own connection, every run of it.
      expect(searchBehind(store)).toBe(0);
      expect(store.searchStates().size).toBe(RUNS);
      process.stdout.write(`search index of ${RUNS} runs caught up in ${(took / 1000).toFixed(1)} s (${asked} searches); the server's thread busy ${(used.utilization * 100).toFixed(0)}% of it, its event loop held up ${(delay.percentile(99) / 1e6).toFixed(0)} ms at the 99th percentile, ${(delay.max / 1e6).toFixed(0)} ms at most\n`);
      // On the server's thread, the index took most of its time (it ran 50 ms of every 70).
      expect(used.utilization).toBeLessThan(0.25);
    } finally {
      await d.close();
    }
  }, 180_000);
});

describe('the search index of a store in memory', () => {
  it('is brought up to date on the server’s thread only while it answers no request', async () => {
    const store = Store.open(':memory:');
    try {
      for (let i = 0; i < 5; i++) addRun(store, { startedAt: NOW - DAY + i * 1000, calls: [say(i, 's1')] });
      const answering = answeringRequest();
      catchUpSearch(store);
      await new Promise((r) => setTimeout(r, 150));
      // A request is being answered: no slice ran.
      expect(searchBehind(store)).toBe(5);
      answering();
      for (let i = 0; i < 100 && searchBehind(store) > 0; i++) await new Promise((r) => setTimeout(r, 20));
      expect(searchBehind(store)).toBe(0);
    } finally {
      store.close();
    }
  });
});
