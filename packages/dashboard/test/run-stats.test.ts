import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { loadRunIndex } from '../src/run-index.js';
import { originStrings, runStats, sumStats } from '../src/run-stats.js';
import { addRun, DAY, usageAt } from './read-model-store.js';

const NOW = Date.UTC(2026, 9, 1, 10, 15);
let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const statsOf = (...ids: string[]) => {
  const index = loadRunIndex(store);
  return runStats(store, index, ids.map((id) => index.byId.get(id)!));
};

describe('run statistics', () => {
  it('counts the time a replay did not wait, back through a replay of a replay', () => {
    // The recording: model calls took 2 s, tool calls 100 ms (call 3 is a tool), and call 5 took 4 s.
    const rec = addRun(store, { startedAt: NOW - DAY, calls: 'llllll', at: { 3: { code: 'l', kind: 'tool' }, 5: { code: 'l', latencyMs: 4000 } } });
    // The fork replays calls 1–4 and runs 5 and 6 live (2 s each): the recording's slow call 5 was never replayed.
    const fork = addRun(store, { parent: rec, startedAt: NOW - 3000, divergence: 5, calls: 'rrrrll', at: { 3: { code: 'r', kind: 'tool' } } });
    // Replays the fork: its calls 1–4 came from the recording, 5 and 6 from the fork.
    const again = addRun(store, { parent: fork, startedAt: NOW - 2000, calls: 'rrrrrr', at: { 3: { code: 'r', kind: 'tool' } } });
    const s = statsOf(rec, fork, again);
    expect(s.get(rec)!.notWaitedMs).toBe(0);
    expect(s.get(fork)!.notWaitedMs).toBe(2000 + 2000 + 100 + 2000);
    expect(s.get(again)!.notWaitedMs).toBe(2000 + 2000 + 100 + 2000 + 2000 + 2000);
  });

  it('follows a replayed call to the call it was replayed from, whatever its number', () => {
    const rec = addRun(store, { startedAt: NOW - DAY, calls: 'lll', at: { 1: { code: 'l', latencyMs: 1000 }, 2: { code: 'l', latencyMs: 2000 }, 3: { code: 'l', latencyMs: 3000 } } });
    const odd = addRun(store, { parent: rec, startedAt: NOW, calls: 'rr', at: { 1: { code: 'r', replayedFrom: 3 }, 2: { code: 'r', replayedFrom: 1 } } });
    expect(statsOf(odd).get(odd)!.notWaitedMs).toBe(4000);
    // Worked out once, a finished run's number stays when its parent is deleted later.
    store.deleteRun(rec);
    expect(statsOf(odd).get(odd)!.notWaitedMs).toBe(4000);
    // A replay whose parent was already gone has nothing to follow.
    const rec2 = addRun(store, { startedAt: NOW - DAY, calls: 'l' });
    const orphan = addRun(store, { parent: rec2, startedAt: NOW, calls: 'r' });
    store.deleteRun(rec2);
    expect(statsOf(orphan).get(orphan)!.notWaitedMs).toBe(0);
  });

  it('counts calls per origin and the prompt cache of live model calls', () => {
    const rec = addRun(store, { startedAt: NOW, calls: 'llbsfi' });
    const s = statsOf(rec).get(rec)!;
    expect(s.origins).toEqual({ r: 0, l: 2, o: 0, i: 1, f: 1, b: 1, s: 1 });
    expect(s.calls).toBe(6);
    const u1 = usageAt(1);
    const u2 = usageAt(2);
    expect(s.liveCacheRead).toBe(u1.cacheReadInputTokens! + u2.cacheReadInputTokens!);
    expect(s.liveInput).toBe([u1, u2].reduce((t, u) => t + u.inputTokens + u.cacheReadInputTokens! + u.cacheCreationInputTokens!, 0));
    expect(originStrings(store, [rec]).get(rec)).toBe('llbsfi');
    expect(sumStats([s, s]).origins.l).toBe(4);
  });

  it('keeps a finished run’s numbers, and works out a running one again each time', () => {
    const live = addRun(store, { startedAt: NOW, calls: 'll', status: 'running' });
    expect(statsOf(live).get(live)!.calls).toBe(2);
    store.appendCallStart({ runId: live, callNo: 3, kind: 'tool', name: 't', fingerprint: 'f', occurrence: 1, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: NOW });
    expect(statsOf(live).get(live)!.calls).toBe(3);
    store.endRun(live, 'completed', NOW + 1);
    const first = statsOf(live).get(live)!;
    expect(statsOf(live).get(live)).toBe(first);
  });

  it('names models with no price instead of guessing their cost', () => {
    const rec = addRun(store, { startedAt: NOW, calls: 'll', at: { 2: { code: 'l', model: 'house-model-7b' } } });
    const s = statsOf(rec).get(rec)!;
    expect(s.unknownModels).toEqual(['house-model-7b']);
    expect(s.spent).toBeGreaterThan(0);
  });
});
