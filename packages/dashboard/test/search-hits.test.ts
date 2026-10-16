import { describe, expect, it } from 'vitest';
import { searchCalls, Store } from '@shadowlap/engine';
import { loadRunIndex } from '../src/run-index.js';
import { rankRecorded, searchDepth, type RecordedHit } from '../src/search-hits.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

// Thursday, Oct 1 2026, 10:15 UTC.
const NOW = Date.UTC(2026, 9, 1, 10, 15);
const ask = { model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: 'Order A-1042: refund it, though it is above the limit.' }] };

describe('searching what runs recorded', () => {
  it('ranks hits from runs of their own before the attempts that replay them, naming the run each attempt belongs to', () => {
    const store = Store.open(':memory:');
    try {
      const rec = addRun(store, { startedAt: NOW - DAY, status: 'failed', calls: [{ code: 'l', request: ask }] });
      // A blame's probes: newer than the recording, the same text, and found first by the index.
      const probes = Array.from({ length: 12 }, (_, i) =>
        addRun(store, { parent: rec, startedAt: NOW - HOUR + i * 1000, divergence: 1, calls: [{ code: 'r', request: ask }], meta: { repeat: { group: 'g-1', attempt: i + 1, of: 12 }, probe: { of: rec, callNo: 1, passed: i === 0 } } }),
      );
      const fork = addRun(store, { parent: rec, startedAt: NOW - 30 * 60_000, divergence: 1, calls: [{ code: 'l', request: ask }] });
      const index = loadRunIndex(store);

      const ranked: RecordedHit[] = rankRecorded(searchCalls(store, 'limit', { limit: searchDepth(4) }), index.byId, 4);
      expect(ranked).toHaveLength(4);
      expect(ranked.slice(0, 2).map((h) => h.runId).sort()).toEqual([rec, fork].sort());
      expect(ranked.slice(0, 2).every((h) => h.attemptOf === null)).toBe(true);
      expect(ranked.slice(2).every((h) => probes.includes(h.runId) && h.attemptOf === rec)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('counts an attempt whose run is gone as a run of its own, and asks the index for enough hits to rank', () => {
    const byId = new Map([
      ['probe', { bundled: true, attemptOf: 'rec' }],
      ['orphan', { bundled: false, attemptOf: 'deleted' }],
      ['rec', { bundled: false, attemptOf: null }],
    ]);
    const hit = (runId: string) => ({ runId, callNo: 1, kind: 'api' as const, name: 'POST /v1/messages', field: 'prompt', snippet: 'x', runStartedAt: 0 });
    expect(rankRecorded([hit('probe'), hit('orphan'), hit('rec'), hit('unknown')], byId, 10).map((h) => [h.runId, h.attemptOf])).toEqual([
      ['orphan', null],
      ['rec', null],
      ['unknown', null],
      ['probe', 'rec'],
    ]);
    expect(rankRecorded([hit('probe'), hit('rec')], byId, 1).map((h) => h.runId)).toEqual(['rec']);
    expect(searchDepth(40)).toBe(200);
    expect(searchDepth(100)).toBe(500);
    expect(searchDepth(1000)).toBe(500);
  });
});
