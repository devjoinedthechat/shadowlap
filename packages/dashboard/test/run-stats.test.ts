import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { estimateCost, Store, storedModelResolver, summarizeRun } from '@shadowlap/engine';
import { loadRunIndex } from '../src/run-index.js';
import { cacheMisses, callTotals, originStrings, runsRead, runStats, spentOf, sumStats } from '../src/run-stats.js';
import { addRun, capture, DAY, MODEL, usageAt } from './read-model-store.js';

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
    // Worked out on its own, without its parents in the same pass, a replay of a replay says the same.
    const alone = Store.open(':memory:');
    try {
      const r = addRun(alone, { startedAt: NOW - DAY, calls: 'llllll', at: { 3: { code: 'l', kind: 'tool' }, 5: { code: 'l', latencyMs: 4000 } } });
      const f = addRun(alone, { parent: r, startedAt: NOW - 3000, divergence: 5, calls: 'rrrrll', at: { 3: { code: 'r', kind: 'tool' } } });
      const a = addRun(alone, { parent: f, startedAt: NOW - 2000, calls: 'rrrrrr', at: { 3: { code: 'r', kind: 'tool' } } });
      const index = loadRunIndex(alone);
      expect(runStats(alone, index, [index.byId.get(a)!]).get(a)!.notWaitedMs).toBe(10_100);
    } finally {
      alone.close();
    }
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

  it('takes a replayed call’s recorded duration from the call itself when it carries one', () => {
    const rec = addRun(store, { startedAt: NOW - DAY, calls: 'll' });
    const replay = addRun(store, { parent: rec, startedAt: NOW, calls: 'rr' });
    // As a sidecar that keeps `recordedMs` on replayed calls writes them: no parent to follow.
    store.appendCallStart({ runId: replay, callNo: 3, kind: 'api', name: 'POST /v1/messages', fingerprint: 'x', occurrence: 1, origin: 'replayed', effect: null, requestRef: null, meta: {}, at: NOW });
    store.appendCallEnd({ kind: 'api', name: 'POST /v1/messages', fingerprint: 'x', occurrence: 1 }, { runId: replay, callNo: 3, attempt: 0, responseRef: null, outcome: 'ok', meta: { latencyMs: 0, replayedFrom: 99, recordedMs: 750 }, at: NOW });
    expect(statsOf(replay).get(replay)!.notWaitedMs).toBe(2000 + 2000 + 750);
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
    const index = loadRunIndex(store);
    expect(originStrings(store, index, [index.byId.get(rec)!]).get(rec)).toBe('llbsfi');
    expect(sumStats([s, s]).origins.l).toBe(4);
  });

  it('reads a finished run’s calls once, and a running one’s every time', () => {
    const live = addRun(store, { startedAt: NOW, calls: 'll', status: 'running' });
    expect(statsOf(live).get(live)!.calls).toBe(2);
    store.appendCallStart({ runId: live, callNo: 3, kind: 'tool', name: 't', fingerprint: 'f', occurrence: 1, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: NOW });
    expect(statsOf(live).get(live)!.calls).toBe(3);
    expect(runsRead(store)).toBe(2);
    // Nothing is kept for a run in progress.
    expect(store.query(`SELECT COUNT(*) AS n FROM run_stats`)).toEqual([{ n: 0 }]);
    store.endRun(live, 'completed', NOW + 1);
    expect(statsOf(live).get(live)!.calls).toBe(3);
    expect(statsOf(live).get(live)!.calls).toBe(3);
    expect(runsRead(store)).toBe(3);
    expect(store.query(`SELECT COUNT(*) AS n FROM run_stats`)).toEqual([{ n: 1 }]);
  });

  it('keeps a finished run’s totals in the store, so the next process reads none of its calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowlap-run-stats-'));
    try {
      const path = join(dir, 'shadowlap.db');
      const first = Store.open(path);
      const rec = addRun(first, { startedAt: NOW - DAY, calls: 'llllbl', at: { 3: { code: 'l', latencyMs: 4000 } } });
      const fork = addRun(first, { parent: rec, startedAt: NOW, divergence: 4, calls: 'rrrlll' });
      const read = (s: Store) => {
        const index = loadRunIndex(s);
        return runStats(s, index, [rec, fork].map((id) => index.byId.get(id)!));
      };
      const before = read(first);
      expect(runsRead(first)).toBe(2);
      first.close();

      const next = Store.open(path);
      try {
        expect(read(next)).toEqual(before);
        expect(runsRead(next)).toBe(0);
        const index = loadRunIndex(next);
        expect(originStrings(next, index, [index.byId.get(fork)!]).get(fork)).toBe('rrrlll');
        expect(runsRead(next)).toBe(0);
        // Totals kept under anything but the run's own key, or unreadable, are worked out again.
        next.saveRunStats([{ runId: rec, key: 'an older format', stats: '{}' }, { runId: fork, key: next.query(`SELECT key FROM run_stats WHERE run_id = ?`, fork)[0]!.key as string, stats: 'not json' }]);
        const again = Store.open(path);
        try {
          expect(read(again)).toEqual(before);
          expect(runsRead(again)).toBe(2);
        } finally {
          again.close();
        }
      } finally {
        next.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prices kept totals on reading: other prices need no call read again', () => {
    const rec = addRun(store, { startedAt: NOW - DAY, calls: 'lll' });
    const index = loadRunIndex(store);
    const run = [index.byId.get(rec)!];
    const list = runStats(store, index, run).get(rec)!;
    const read = runsRead(store);
    const doubled = runStats(store, index, run, { prices: { [MODEL]: { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 } } }).get(rec)!;
    expect(runsRead(store)).toBe(read);
    const usage = [1, 2, 3].map(usageAt);
    const at = (p: { input: number; output: number; cacheRead: number; cacheWrite: number }) => usage.reduce((t, u) => t + estimateCost(MODEL, u, { [MODEL]: p })!, 0);
    expect(doubled.spent).toBeCloseTo(at({ input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 }), 12);
    expect(doubled.spent).not.toBeCloseTo(list.spent, 6);
  });

  it('reads what runs spent live, as their statistics say', () => {
    const rec = addRun(store, { startedAt: NOW - DAY, calls: 'llllbl' });
    const fork = addRun(store, { parent: rec, startedAt: NOW, divergence: 3, calls: 'rrll' });
    const cap = capture(store, NOW);
    const index = loadRunIndex(store);
    const runs = [rec, fork, cap].map((id) => index.byId.get(id)!);
    const spent = spentOf(store, index, runs);
    const stats = runStats(store, index, runs);
    for (const id of [rec, fork, cap]) expect(spent.get(id)).toBeCloseTo(stats.get(id)!.spent, 12);
    expect(spent.get(cap)).toBe(0);
    expect(stats.get(cap)!.captured).toBeGreaterThan(0);
    expect(spent.get(rec)).toBeGreaterThan(spent.get(fork)!);
  });

  it('reads the model from the request of a call recorded before the model was kept per call', () => {
    const request = (model: string) => ({ model, max_tokens: 100, messages: [{ role: 'user', content: 'Refund order A-1042.' }] });
    const old = addRun(store, {
      startedAt: NOW - DAY,
      calls: [
        { code: 'l', model: null, request: request('claude-opus-4-5') },
        { code: 'l', model: null, request: request(MODEL) },
        { code: 'l', model: null },
      ],
    });
    const replay = addRun(store, { parent: old, startedAt: NOW, calls: [{ code: 'r', model: null, request: request('claude-opus-4-5') }, { code: 'l', model: null, request: request(MODEL) }], divergence: 2 });
    const s = statsOf(old, replay);
    const modelOf = storedModelResolver(store);
    for (const id of [old, replay]) {
      const sum = summarizeRun(store.getRun(id)!, store.getCalls(id), [], [], { modelOf });
      expect(s.get(id)!.spent).toBeCloseTo(sum.cost.spent, 12);
      expect(s.get(id)!.saved).toBeCloseTo(sum.cost.saved, 12);
    }
    expect(s.get(old)!.spent).toBeGreaterThan(0);
    expect(s.get(replay)!.saved).toBeGreaterThan(0);
  });

  it('names models with no price instead of guessing their cost', () => {
    const rec = addRun(store, { startedAt: NOW, calls: 'll', at: { 2: { code: 'l', model: 'house-model-7b' } } });
    const s = statsOf(rec).get(rec)!;
    expect(s.unknownModels).toEqual(['house-model-7b']);
    expect(s.spent).toBeGreaterThan(0);
  });

  it('finds prompt-cache misses on live calls only, and names the kind of run they were in', () => {
    const rec = addRun(store, { startedAt: NOW - DAY, calls: 'llll', at: { 3: { code: 'l', usage: { inputTokens: 1800, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } } });
    const index = loadRunIndex(store);
    const misses = cacheMisses(store, index, [index.byId.get(rec)!]);
    // Call 2's whole input was 40 + 1200 + 100; call 3 read nothing from the cache.
    expect(misses).toEqual([{ runId: rec, kind: 'recording', callNo: 3, scope: null, tokens: 1340 }]);
    expect(callTotals(store, index, [index.byId.get(rec)!]).get(rec)!.misses).toEqual([[3, null, 1340]]);
  });
});
