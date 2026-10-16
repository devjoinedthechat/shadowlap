import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchExpression, Store, updateSearchIndex } from '@shadowlap/engine';
import { PER_RUN, searchRecorded } from '../src/search-hits.js';
import { addRun, DAY, HOUR, type CallSpec } from './read-model-store.js';

// Thursday, Oct 1 2026, 10:15 UTC.
const NOW = Date.UTC(2026, 9, 1, 10, 15);

/** A model call whose prompt says `text`; each scope is a conversation of its own, so each call is indexed whole. */
const say = (code: string, text: string, scope: string): CallSpec => ({ code, scope, request: { model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: text }] } });

const LONG = 'Order A-1042: refund it, though it is above the limit the policy sets for a refund without a manager, so the agent should escalate and tell the customer why.';

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

    const hits = searchRecorded(store, 'refund', 40);
    expect(hits.map((h) => h.runId).sort()).toEqual([rec, fork].sort());
    expect(hits.every((h) => h.attemptOf === null)).toBe(true);
    expect(hits[0]).toMatchObject({ callNo: 1, kind: 'api', name: 'POST /v1/messages', field: 'prompt' });
    expect(hits.find((h) => h.runId === rec)?.runStartedAt).toBe(NOW - DAY);
    expect(hits[0]!.snippet).toContain('\u0001refund\u0002');
  });

  it('gives a run at most two hits, so one long run can’t fill the list', () => {
    const long = addRun(store, { startedAt: NOW - 2 * HOUR, calls: Array.from({ length: 30 }, (_, i) => say('l', 'escalate', `s${i}`)) });
    const others = [1, 2, 3].map((i) => addRun(store, { startedAt: NOW - DAY + i * HOUR, calls: [say('l', LONG, 's1')] }));
    const hits = searchRecorded(store, 'escalate', 6);
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

    const hits = searchRecorded(store, 'rate limited', 40);
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
    expect(searchRecorded(store, '  ', 40)).toEqual([]);
    expect(searchRecorded(store, 'refund', 0)).toEqual([]);
    expect(searchRecorded(store, 'nowhere', 40)).toEqual([]);
  });
});
