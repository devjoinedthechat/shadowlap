import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storeApiRequest } from '../src/manifest.js';
import { indexSearch, searchCalls, searchIndexBehind, updateSearchIndex } from '../src/search.js';
import { Store } from '../src/store.js';

/**
 * The search index is brought up to date a batch at a time and remembers where it stopped: a run
 * still recording is indexed from its newest calls, never again from its first, and a slice with a
 * budget stops when the budget is spent and leaves the rest to the next one.
 */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const identity = (callNo: number) => ({ kind: 'tool' as const, name: 'lookup_order', fingerprint: `f${callNo}`, occurrence: 0 });

/** A tool call whose arguments say `note` and, when given, whose answer says `result`. */
function toolCall(runId: string, callNo: number, note: string, result?: string, end: { outcome?: 'ok' | 'error'; retryable?: boolean } = {}): void {
  store.appendCallStart({ runId, callNo, ...identity(callNo), origin: 'live', effect: 'read', requestRef: store.putJson({ args: { note } }), meta: {}, at: callNo });
  if (result !== undefined) answer(runId, callNo, result, end);
}

/** The answer to a call made before: a later `attempt` is the agent's retry. */
function answer(runId: string, callNo: number, result: string, end: { outcome?: 'ok' | 'error'; retryable?: boolean; attempt?: number } = {}): void {
  store.appendCallEnd(identity(callNo), { runId, callNo, attempt: end.attempt ?? 0, responseRef: store.putJson({ result }), outcome: end.outcome ?? 'ok', meta: end.retryable ? { retryable: true } : {}, at: callNo + 1 });
}

/** A model call in one conversation: each request repeats the turns before it and adds one. */
function modelCall(runId: string, callNo: number, turns: string[]): void {
  const requestRef = storeApiRequest(store, { model: 'claude-sonnet-4-5', max_tokens: 1024, messages: turns.map((content, i) => ({ role: i % 2 ? 'assistant' : 'user', content })) });
  store.appendCallStart({ runId, callNo, kind: 'api', name: 'POST /v1/messages', fingerprint: `m${callNo}`, occurrence: 0, origin: 'live', effect: null, requestRef, meta: {}, at: callNo });
}

const newRun = () => store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } }).runId;

describe('the search index', () => {
  it('indexes a run still recording from where it stopped, never again from its first call', () => {
    const runId = newRun();
    for (let n = 1; n <= 50; n++) toolCall(runId, n, `zebra ${n}`, `stripe ${n}`);
    updateSearchIndex(store);
    expect(searchCalls(store, 'zebra', { limit: 100 })).toHaveLength(50);

    const reads = vi.spyOn(store, 'getCalls');
    for (let n = 51; n <= 53; n++) toolCall(runId, n, `zebra ${n}`, `stripe ${n}`);
    expect(updateSearchIndex(store)).toBe(1);
    // Only the calls after the last one indexed were read: no read of the whole run.
    expect(reads.mock.calls.every(([, range]) => range !== undefined)).toBe(true);
    expect(reads.mock.calls.some(([, range]) => range?.after === 50)).toBe(true);
    reads.mockRestore();
    // Each call indexed once: the prefix was not indexed a second time.
    expect(searchCalls(store, 'zebra', { limit: 100 })).toHaveLength(53);
    expect(searchCalls(store, 'stripe', { limit: 100 })).toHaveLength(53);
    expect(updateSearchIndex(store)).toBe(0);
  });

  it('indexes a call’s answer once it arrives, and the answer the agent’s retry got rather than the failure it retried', () => {
    const runId = newRun();
    toolCall(runId, 1, 'first', 'stripe one');
    // On its way when the index looks.
    toolCall(runId, 2, 'second');
    // A failure the agent may retry.
    toolCall(runId, 3, 'third', 'overloaded, try again', { outcome: 'error', retryable: true });
    updateSearchIndex(store);
    expect(searchCalls(store, 'second').map((h) => h.field)).toEqual(['arguments']);
    expect(searchCalls(store, 'overloaded')).toEqual([]);

    answer(runId, 2, 'stripe two');
    answer(runId, 3, 'stripe three', { attempt: 1 });
    updateSearchIndex(store);
    expect(searchCalls(store, 'stripe', { limit: 10 }).map((h) => h.callNo).sort()).toEqual([1, 2, 3]);
    expect(searchCalls(store, 'overloaded')).toEqual([]);

    // Once the run has ended, what a call has is final: its status moves on without indexing it again.
    store.endRun(runId, 'completed');
    expect(searchIndexBehind(store)).toBe(1);
    updateSearchIndex(store);
    expect(searchIndexBehind(store)).toBe(0);
    expect(searchCalls(store, 'stripe', { limit: 10 })).toHaveLength(3);
    expect(store.searchState(runId)).toEqual({ calls: 3, status: 'completed', progress: null });
  });

  it('indexes the turns each model call adds, also across batches', () => {
    const runId = newRun();
    const turns: string[] = [];
    // 450 model calls in one conversation: three batches, each request repeating all before it.
    for (let n = 1; n <= 450; n++) {
      turns.push(n === 1 ? 'You are a careful refund agent.' : `turn ${n} says quokka`);
      modelCall(runId, n, turns);
    }
    store.endRun(runId, 'completed');
    let slices = 0;
    while (indexSearch(store, { budgetMs: 0 }).behind > 0) slices++;
    // A slice with no time to spare still does a batch, and goes on from there the next time.
    expect(slices).toBeGreaterThan(1);
    // The system prompt was sent with every call and is indexed once.
    expect(searchCalls(store, '"careful refund agent"').filter((h) => h.field === 'prompt')).toHaveLength(1);
    expect(searchCalls(store, 'quokka', { limit: 1000 })).toHaveLength(449);
  });

  it('stops a slice when its budget is spent and says how many runs it is still behind on', () => {
    const runs = Array.from({ length: 5 }, () => {
      const runId = newRun();
      for (let n = 1; n <= 3; n++) toolCall(runId, n, `ibex ${n}`, 'done');
      store.endRun(runId, 'completed');
      return runId;
    });
    expect(searchIndexBehind(store)).toBe(5);
    // No time to spare: one call of the newest run, and the next slice goes on from there.
    const first = indexSearch(store, { budgetMs: 0 });
    expect(first).toEqual({ batches: 1, behind: 5 });
    expect(store.searchState(runs[4])).toMatchObject({ calls: 1 });
    expect(indexSearch(store, { budgetMs: 0 }).behind).toBe(5);
    expect(store.searchState(runs[4])).toMatchObject({ calls: 2 });
    expect(indexSearch(store).behind).toBe(0);
    expect(new Set(searchCalls(store, 'ibex', { limit: 100 }).map((h) => h.runId))).toEqual(new Set(runs));
  });

  it('indexes again from its start a run an earlier shadowlap indexed whole while it recorded', () => {
    const runId = newRun();
    toolCall(runId, 1, 'first', 'stripe one');
    toolCall(runId, 2, 'second');
    // As an earlier shadowlap left it: the whole run, the call on its way without its answer.
    store.replaceSearchDocs(runId, 2, 'running', [
      { callNo: 1, field: 'arguments', text: 'lookup_order note first' },
      { callNo: 1, field: 'result', text: 'result stripe one' },
      { callNo: 2, field: 'arguments', text: 'lookup_order note second' },
    ]);
    answer(runId, 2, 'stripe two');
    store.endRun(runId, 'completed');
    updateSearchIndex(store);
    expect(searchCalls(store, 'stripe', { limit: 10 }).map((h) => h.callNo).sort()).toEqual([1, 2]);
    expect(searchCalls(store, 'first')).toHaveLength(1);
  });

  it('waits only a moment for another command’s write when asked to, writes nothing then, and goes on once the store is free', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-search-busy-'));
    const was = store;
    store = Store.open(join(dir, 'store.db'));
    const holder = new DatabaseSync(join(dir, 'store.db'));
    try {
      const runs = [newRun(), newRun()];
      for (const runId of runs) {
        for (let n = 1; n <= 3; n++) toolCall(runId, n, `ibex ${n}`, 'done');
        store.endRun(runId, 'completed');
      }
      // Another command writing the store: gc's VACUUM, a pull, an import.
      holder.exec('BEGIN IMMEDIATE');
      const t0 = Date.now();
      expect(indexSearch(store, { briefly: true })).toEqual({ batches: 0, behind: 2, busy: true });
      // Not the 10 s a write waits otherwise: a dashboard indexes on the thread that answers its pages.
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(store.searchStates().size).toBe(0);
      expect((store as unknown as { db: DatabaseSync }).db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 10_000 });
      holder.exec('ROLLBACK');
      expect(indexSearch(store, { briefly: true })).toEqual({ batches: 2, behind: 0 });
      expect(searchCalls(store, 'ibex', { limit: 10 })).toHaveLength(6);
    } finally {
      holder.close();
      store.close();
      store = was;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a batch to another process that indexed the run meanwhile', () => {
    const runId = newRun();
    toolCall(runId, 1, 'first', 'stripe one');
    store.endRun(runId, 'completed');
    const before = store.searchState(runId);
    expect(store.addSearchDocs(runId, { expected: before, next: { calls: 1, status: 'completed', progress: null }, docs: [{ callNo: 1, field: 'result', text: 'stripe one' }] })).toBe(true);
    // A second writer that read the same state before is refused, so nothing is indexed twice.
    expect(store.addSearchDocs(runId, { expected: before, next: { calls: 1, status: 'completed', progress: null }, docs: [{ callNo: 1, field: 'result', text: 'stripe one' }] })).toBe(false);
    expect(store.searchDocs('"stripe"', 10)).toHaveLength(1);
  });

  it('deletes a run’s documents by the rows that map them to it, and maps an index from before them as the store opens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-search-rows-'));
    const path = join(dir, 'store.db');
    const was = store;
    store = Store.open(path);
    try {
      const runs = [newRun(), newRun(), newRun()];
      for (const runId of runs) {
        for (let n = 1; n <= 3; n++) toolCall(runId, n, `ibex ${n}`, 'done');
        store.endRun(runId, 'completed');
      }
      updateSearchIndex(store);
      // A call's arguments and its result: two documents a call.
      const mapped = (runId: string) => Number(store.query(`SELECT COUNT(*) AS n FROM search_rows WHERE run_id = ?`, runId)[0].n);
      expect(runs.map(mapped)).toEqual([6, 6, 6]);
      store.deleteRun(runs[0]);
      expect(new Set(store.searchDocs('"ibex"', 100).map((h) => h.runId))).toEqual(new Set(runs.slice(1)));
      expect(mapped(runs[0])).toBe(0);

      // An index an earlier shadowlap wrote, without the map: mapped once, as the store opens.
      store.close();
      const earlier = new DatabaseSync(path);
      earlier.exec('DROP TABLE search_rows');
      earlier.close();
      store = Store.open(path);
      expect(runs.slice(1).map(mapped)).toEqual([6, 6]);
      store.deleteRun(runs[1]);
      expect(store.searchDocs('"ibex"', 100).map((h) => h.runId)).toEqual([runs[2], runs[2], runs[2]]);
      // Indexed again from its start, a run keeps one copy of each document, also of one an earlier
      // shadowlap wrote there since, without its row.
      const later = new DatabaseSync(path);
      later.prepare(`INSERT INTO search_docs (text, run_id, call_no, field) VALUES ('lookup_order note ibex 4', ?, 4, 'arguments')`).run(runs[2]);
      later.close();
      expect(store.searchDocs('"ibex"', 100)).toHaveLength(4);
      store.replaceSearchDocs(runs[2], 3, 'completed', [{ callNo: 1, field: 'arguments', text: 'lookup_order note ibex 1' }]);
      expect(store.searchDocs('"ibex"', 100)).toHaveLength(1);
      expect(mapped(runs[2])).toBe(1);
    } finally {
      store.close();
      store = was;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deletes a run whole or not at all: a failure in its index keeps the run, and the text it recorded stays findable only with it', () => {
    const [kept, gone] = [newRun(), newRun()];
    for (const runId of [kept, gone]) {
      for (let n = 1; n <= 3; n++) toolCall(runId, n, `okapi ${n}`, 'done');
      store.endRun(runId, 'completed');
    }
    updateSearchIndex(store);
    // Inside a transaction someone else opened, as a pull replaces a run: it nests.
    store.transaction(() => store.deleteRun(gone));
    expect(store.getRun(gone)).toBeNull();
    expect(new Set(store.searchDocs('"okapi"', 100).map((h) => h.runId))).toEqual(new Set([kept]));
    // An index that can't be written (a Node whose SQLite has no full-text search reads it as no such module).
    (store as unknown as { db: DatabaseSync }).db.exec('ALTER TABLE search_rows RENAME TO search_rows_away');
    expect(() => store.deleteRun(kept)).toThrow(/search_rows/);
    (store as unknown as { db: DatabaseSync }).db.exec('ALTER TABLE search_rows_away RENAME TO search_rows');
    expect(store.getRun(kept)?.runId).toBe(kept);
    expect(store.getCalls(kept)).toHaveLength(3);
    expect(store.searchDocs('"okapi"', 100).map((h) => h.runId)).toEqual([kept, kept, kept]);
    store.deleteRun(kept);
    expect(store.searchDocs('"okapi"', 100)).toEqual([]);
  });
});
