import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchExpression, Store, updateSearchIndex } from '@shadowlap/engine';
import { catchUpSearch, indexRecordings, indexSearchSlice, PER_RUN, searchBehind, searchRecorded } from '../src/search-hits.js';
import { addRun, DAY, HOUR, type CallSpec } from './read-model-store.js';

// Thursday, Oct 1 2026, 10:15 UTC.
const NOW = Date.UTC(2026, 9, 1, 10, 15);

/** A model call whose prompt says `text`; each scope is a conversation of its own, so each call is indexed whole. */
const say = (code: string, text: string, scope: string): CallSpec => ({ code, scope, request: { model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: text }] } });

const LONG = 'Order A-1042: refund it, though it is above the limit the policy sets for a refund without a manager, so the agent should escalate and tell the customer why.';

/** A search once the index has caught up, as the dashboard has it a moment after the runs arrive. */
function search(query: string, limit: number) {
  updateSearchIndex(store);
  return searchRecorded(store, query, limit);
}

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

describe('searching what runs recorded', () => {
  it('puts a run’s own hits first however many of its attempts the index ranks above them', () => {
    const rec = addRun(store, { startedAt: NOW - DAY, status: 'failed', calls: [say('l', LONG, 's1')] });
    // Seventy --repeat attempts of four calls each: 280 hits, each a closer match than the recording's own.
    const attempts = Array.from({ length: 70 }, (_, i) =>
      addRun(store, { parent: rec, startedAt: NOW - HOUR + i * 1000, divergence: 1, meta: { repeat: { group: 'g-1', attempt: i + 1, of: 70 } }, calls: [1, 2, 3, 4].map((k) => say('r', 'refund A-1042', `s${k}`)) }),
    );
    const fork = addRun(store, { parent: rec, startedAt: NOW - 30 * 60_000, divergence: 1, calls: [say('l', `${LONG} Forked.`, 's1')] });
    updateSearchIndex(store);
    // The index alone puts the recording past the first 200 hits, the depth a fixed window would read.
    const raw = store.searchDocs(searchExpression('refund')!, 1000);
    expect(raw.findIndex((h) => h.runId === rec)).toBeGreaterThan(200);
    expect(attempts.includes(raw[0]!.runId)).toBe(true);

    const hits = search('refund', 40);
    expect(hits.map((h) => h.runId).sort()).toEqual([rec, fork].sort());
    expect(hits.every((h) => h.attemptOf === null)).toBe(true);
    expect(hits[0]).toMatchObject({ callNo: 1, kind: 'api', name: 'POST /v1/messages', field: 'prompt' });
    expect(hits.find((h) => h.runId === rec)?.runStartedAt).toBe(NOW - DAY);
    expect(hits[0]!.snippet).toContain('\u0001refund\u0002');
  });

  it('gives a run at most two hits, so one long run can’t fill the list', () => {
    const long = addRun(store, { startedAt: NOW - 2 * HOUR, calls: Array.from({ length: 30 }, (_, i) => say('l', 'escalate', `s${i}`)) });
    const others = [1, 2, 3].map((i) => addRun(store, { startedAt: NOW - DAY + i * HOUR, calls: [say('l', LONG, 's1')] }));
    const hits = search('escalate', 6);
    expect(hits.filter((h) => h.runId === long)).toHaveLength(PER_RUN);
    expect(new Set(hits.map((h) => h.runId))).toEqual(new Set([long, ...others]));
    expect(hits).toHaveLength(5);
  });

  it('shows attempts only of a run with no hit of its own, two of them together, and counts an attempt whose run is gone as a run', () => {
    const quiet = addRun(store, { startedAt: NOW - DAY, status: 'failed', calls: [say('l', 'Where is order A-1042?', 's1')] });
    // A blame's probes said something the recording never did.
    const probes = Array.from({ length: 5 }, (_, i) =>
      addRun(store, { parent: quiet, startedAt: NOW - HOUR + i * 1000, divergence: 1, meta: { probe: { of: quiet, callNo: 1, passed: false } }, calls: [say('l', 'The carrier rate limited the lookup', 's1'), say('l', 'rate limited again', 's2')] }),
    );
    const loud = addRun(store, { startedAt: NOW - 2 * DAY, calls: [say('l', 'rate limited, then refunded', 's1')] });
    const copies = [1, 2].map((i) => addRun(store, { parent: loud, startedAt: NOW - 3 * HOUR + i, divergence: 1, meta: { repeat: { group: 'g-2', attempt: i, of: 2 } }, calls: [say('r', 'rate limited', 's1')] }));
    const gone = addRun(store, { startedAt: NOW - 3 * DAY, calls: [say('l', 'nothing', 's1')] });
    const orphan = addRun(store, { parent: gone, startedAt: NOW - 2 * HOUR, divergence: 1, meta: { repeat: { group: 'g-3', attempt: 1, of: 1 } }, calls: [say('l', 'rate limited for an hour', 's1')] });
    store.deleteRun(gone);

    const hits = search('rate limited', 40);
    const own = hits.filter((h) => h.attemptOf === null);
    expect(new Set(own.map((h) => h.runId))).toEqual(new Set([loud, orphan]));
    // Runs of their own first; the loud run's copies are left out, as the run has a hit of its own.
    expect(hits.slice(0, own.length)).toEqual(own);
    expect(hits.some((h) => copies.includes(h.runId))).toBe(false);
    const theirs = hits.slice(own.length);
    expect(theirs).toHaveLength(PER_RUN);
    expect(theirs.every((h) => h.attemptOf === quiet && probes.includes(h.runId))).toBe(true);
  });

  it('finds nothing for an empty query or limit', () => {
    addRun(store, { startedAt: NOW - DAY, calls: [say('l', LONG, 's1')] });
    expect(search('  ', 40)).toEqual([]);
    expect(search('refund', 0)).toEqual([]);
    expect(search('nowhere', 40)).toEqual([]);
  });
});

describe('the index behind the search', () => {
  it('is never built inside a search: a search answers from what it holds, and slices catch it up', () => {
    const runs = Array.from({ length: 6 }, (_, i) => addRun(store, { startedAt: NOW - DAY + i * HOUR, calls: [say('l', `refund order A-10${i}`, 's1'), say('l', 'escalate', 's2')] }));
    // Nothing indexed yet: no hits, and the search says how many runs it has yet to read.
    expect(searchRecorded(store, 'refund', 40)).toEqual([]);
    expect(searchBehind(store)).toBe(6);
    // A slice with no time to spare still indexes a call, newest run first, and the next goes on from there.
    expect(indexSearchSlice(store, 0)).toEqual({ behind: 6, busy: false });
    expect(searchRecorded(store, 'refund', 40).map((h) => h.runId)).toEqual([runs[5]]);
    let slices = 1;
    while (indexSearchSlice(store, 0).behind > 0) slices++;
    expect(slices).toBeGreaterThan(6);
    expect(new Set(searchRecorded(store, 'refund', 40).map((h) => h.runId))).toEqual(new Set(runs));
    expect(searchBehind(store)).toBe(0);
  });

  it('reads a recording’s newest calls only, as they arrive', () => {
    const runId = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/work' }, startedAt: NOW }).runId;
    const call = (n: number, text: string) => {
      const identity = { kind: 'tool' as const, name: 'lookup_order', fingerprint: `f${n}`, occurrence: 0 };
      store.appendCallStart({ runId, callNo: n, ...identity, origin: 'live', effect: 'read', requestRef: store.putJson({ args: { text } }), meta: {}, at: NOW + n });
      store.appendCallEnd(identity, { runId, callNo: n, attempt: 0, responseRef: store.putJson({ result: 'ok' }), outcome: 'ok', meta: {}, at: NOW + n });
    };
    for (let n = 1; n <= 300; n++) call(n, `note ${n}`);
    while (indexSearchSlice(store).behind > 0);
    call(301, 'refund A-1042');
    expect(searchBehind(store)).toBe(1);
    expect(indexSearchSlice(store)).toEqual({ behind: 0, busy: false });
    expect(searchRecorded(store, 'refund', 40)).toMatchObject([{ runId, callNo: 301, field: 'arguments' }]);
    expect(store.searchState(runId)).toMatchObject({ calls: 301, status: 'running' });
  });

  it('leaves the store to another command writing it, waiting a moment at most, and catches up once it is free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-search-busy-'));
    const path = join(dir, 'shadowlap.db');
    const file = Store.open(path);
    const holder = new DatabaseSync(path);
    try {
      const runs = Array.from({ length: 4 }, (_, i) => addRun(file, { startedAt: NOW - DAY + i * HOUR, calls: [say('l', `refund order A-10${i}`, 's1')] }));
      // Another command writing the store: gc's VACUUM, a pull, an import.
      holder.exec('BEGIN IMMEDIATE');
      const t0 = Date.now();
      expect(indexSearchSlice(file)).toEqual({ behind: 4, busy: true });
      // A moment, not the 10 s a write waits otherwise, for which every page would wait too.
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(file.searchStates().size).toBe(0);
      // In the background it writes nothing while the store is busy, and tries again later.
      catchUpSearch(file);
      await new Promise((r) => setTimeout(r, 300));
      expect(file.searchStates().size).toBe(0);
      holder.exec('ROLLBACK');
      for (let i = 0; i < 200 && searchBehind(file) > 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(searchBehind(file)).toBe(0);
      expect(new Set(searchRecorded(file, 'refund', 40).map((h) => h.runId))).toEqual(new Set(runs));
    } finally {
      holder.close();
      file.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('goes on after a slice that failed: only a closed store ends it', async () => {
    const runs = Array.from({ length: 3 }, (_, i) => addRun(store, { startedAt: NOW - DAY + i * HOUR, calls: [say('l', `refund order A-20${i}`, 's1')] }));
    const states = vi.spyOn(store, 'searchStates').mockImplementationOnce(() => {
      throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
    });
    catchUpSearch(store);
    await new Promise((r) => setTimeout(r, 50));
    expect(states).toHaveBeenCalled();
    states.mockRestore();
    expect(searchBehind(store)).toBe(3);
    for (let i = 0; i < 100 && searchBehind(store) > 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(new Set(searchRecorded(store, 'refund', 40).map((h) => h.runId))).toEqual(new Set(runs));
  });

  it('takes in what the runs still recording said, and leaves the rest to the slices', () => {
    const done = addRun(store, { startedAt: NOW - DAY, calls: [say('l', 'refund order A-1041', 's1')] });
    const rec = addRun(store, { startedAt: NOW - HOUR, status: 'running', calls: [say('l', 'refund order A-1042', 's1')] });
    expect(searchBehind(store)).toBe(2);
    indexRecordings(store);
    expect(searchRecorded(store, 'refund', 40).map((h) => h.runId)).toEqual([rec]);
    expect(store.searchState(done)).toBeNull();
    expect(searchBehind(store)).toBe(1);
  });
});
