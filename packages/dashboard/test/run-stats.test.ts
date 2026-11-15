import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateCost, Store, storedModelResolver, summarizeRun } from '@shadowlap/engine';
import { overviewKnown, overviewSummary } from '../src/overview.js';
import { runJob, SUMMARY_CALLS_BUDGET } from '../src/read-jobs.js';
import { keepingIndex, loadRunIndex } from '../src/run-index.js';
import { cacheTotalsOf, cachesRead, callTotals, originStrings, runsRead, runStats, spentOf, sumStats, totalsKnown, warmRunStats } from '../src/run-stats.js';
import { assistant, cachedUsage, RunBuilder, toolResult, toolUse, usage, user } from '../../engine/test/run-fixtures.js';
import { addRun, capture, DAY, HOUR, MODEL, usageAt } from './read-model-store.js';

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

  it('counts calls per origin', () => {
    const rec = addRun(store, { startedAt: NOW, calls: 'llbsfi' });
    const s = statsOf(rec).get(rec)!;
    expect(s.origins).toEqual({ r: 0, l: 2, o: 0, i: 1, f: 1, b: 1, s: 1 });
    expect(s.calls).toBe(6);
    const index = loadRunIndex(store);
    expect(originStrings(store, index, [index.byId.get(rec)!]).get(rec)).toBe('llbsfi');
    expect(sumStats([s, s]).origins.l).toBe(4);
  });

  it('reads a finished run’s calls once, and a running one’s once per look at the store', () => {
    const live = addRun(store, { startedAt: NOW, calls: 'll', status: 'running' });
    expect(statsOf(live).get(live)!.calls).toBe(2);
    // Parts of one read model asking again, with nothing written meanwhile, read its calls once.
    expect(statsOf(live).get(live)!.calls).toBe(2);
    expect(runsRead(store)).toBe(1);
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
        next.saveRunStats([{ runId: rec, key: 'an older format', stats: '{}' }, { runId: fork, key: next.query(`SELECT key FROM run_stats WHERE run_id = ?`, fork)[0].key as string, stats: 'not json' }]);
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

  it('prices each Claude Haiku 5.5 call on the card its own prompt picks, from tokens summed per band', () => {
    const at = (inputTokens: number, cacheReadInputTokens = 0) => ({ code: 'l', model: 'claude-haiku-5-5', usage: { inputTokens, outputTokens: 1000, cacheReadInputTokens } });
    const rec = addRun(store, { startedAt: NOW, calls: [at(60_000), at(100_000), at(1000, 100_000), at(300_000)] });
    const s = statsOf(rec).get(rec)!;
    const calls = store.getCalls(rec);
    expect(s.spent).toBeCloseTo(calls.reduce((n, c) => n + estimateCost('claude-haiku-5-5', c.end!.meta.usage)!, 0), 12);
    expect(s.spent).toBeCloseTo(summarizeRun(store.getRun(rec)!, calls, [], [], {}).cost.spent, 12);
    // 160,000 and 2,000 output tokens on the short card; 301,000, 100,000 from the cache and 2,000 on the long one.
    expect(s.spent).toBeCloseTo((160_000 * 0.1 + 2000 * 0.5 + 301_000 * 0.5 + 100_000 * 0.05 + 2000 * 2.5) / 1e6, 12);
  });

  it('splits totals again at a config price\'s own break, once, and prices them as each call is', () => {
    const own = { 'my-model': { input: 1, output: 2, above: { tokens: 50_000, input: 3, output: 4 } } };
    const at = (inputTokens: number) => ({ code: 'l', model: 'my-model', usage: { inputTokens, outputTokens: 10 } });
    const rec = addRun(store, { startedAt: NOW, calls: [at(30_000), at(30_000), at(60_000)] });
    const index = loadRunIndex(store);
    const run = [index.byId.get(rec)!];
    // Split at the built-in breaks alone, the config's card can't be told apart: the calls are read again.
    expect(runStats(store, index, run).get(rec)!.unknownModels).toEqual(['my-model']);
    expect(runsRead(store)).toBe(1);
    const mine = runStats(store, index, run, { prices: own }).get(rec)!;
    expect(runsRead(store)).toBe(2);
    expect(mine.spent).toBeCloseTo((60_000 * 1 + 20 * 2 + 60_000 * 3 + 10 * 4) / 1e6, 12);
    // Split at its break too, they price the built-in prices and the config's alike, with no call read again.
    expect(runStats(store, index, run, { prices: own }).get(rec)!.spent).toBe(mine.spent);
    expect(spentOf(store, index, run, { prices: own }).get(rec)).toBe(mine.spent);
    expect(runStats(store, index, run).get(rec)!.unknownModels).toEqual(['my-model']);
    expect(runsRead(store)).toBe(2);
    expect(JSON.parse(store.query('SELECT stats FROM run_stats WHERE run_id = ?', rec)[0].stats as string).breaks).toEqual([50_000, 100_000]);
  });

  it('reads what runs spent, as the table sorts by it: live, or what a run recorded elsewhere cost there', () => {
    const rec = addRun(store, { startedAt: NOW - DAY, calls: 'llllbl' });
    const fork = addRun(store, { parent: rec, startedAt: NOW, divergence: 3, calls: 'rrll' });
    const cap = capture(store, NOW);
    const index = loadRunIndex(store);
    const runs = [rec, fork, cap].map((id) => index.byId.get(id)!);
    const spent = spentOf(store, index, runs);
    const stats = runStats(store, index, runs);
    for (const id of [rec, fork]) expect(spent.get(id)).toBeCloseTo(stats.get(id)!.spent, 12);
    // A capture spent nothing live here: it sorts by what its traffic cost where it ran, as it shows.
    expect(stats.get(cap)!.spent).toBe(0);
    expect(stats.get(cap)!.captured).toBeGreaterThan(0);
    expect(spent.get(cap)).toBeCloseTo(stats.get(cap)!.captured, 12);
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
});

describe('the prompt cache', () => {
  it('is worked out when asked for, by the run page’s rule, and kept with the totals', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowlap-cache-'));
    const path = join(dir, 'shadowlap.db');
    try {
      const first = Store.open(path);
      // Four turns of one conversation; the third read nothing from the cache: a miss.
      const b = RunBuilder.start(first, { startedAt: NOW - DAY });
      for (let m = 1; m <= 4; m++) {
        const q: unknown[] = [user('Begin.')];
        for (let i = 1; i < m; i++) q.push(assistant([toolUse('step', { i }, `toolu_${i}`)]), user([toolResult(`toolu_${i}`, 'ok')]));
        const u = m === 3 ? usage(10, 0, cachedUsage(m).cacheReadInputTokens! + cachedUsage(m).cacheCreationInputTokens!) : cachedUsage(m);
        b.model({ messages: q }, [toolUse('step', { i: m }, `toolu_${m}`)], { usage: u });
      }
      const runId = b.end();
      const replay = addRun(first, { parent: runId, startedAt: NOW, calls: 'rrrr' });
      let index = loadRunIndex(first);
      const runs = [runId, replay].map((id) => index.byId.get(id)!);
      // The totals alone leave it out: it reads every request of the run.
      const totals = callTotals(first, index, runs);
      expect(totals.get(runId)).not.toHaveProperty('cache');
      // A run with no live model call has none to work out.
      expect(totals.get(replay)!.cache).toBeNull();
      expect(cachesRead(first)).toBe(0);
      const cache = cacheTotalsOf(first, index, runs);
      // Each miss with the model that answered it, shortened as the run page shows it.
      expect(cache.get(runId)).toMatchObject({ misses: [[3, null, expect.any(Number), 'sonnet-5']] });
      expect(cache.get(runId)!.read).toBeGreaterThan(0);
      expect(cache.get(replay)).toBeNull();
      expect(cachesRead(first)).toBe(1);
      // Asked again: from memory.
      index = loadRunIndex(first);
      expect(cacheTotalsOf(first, index, runs)).toEqual(cache);
      expect(cachesRead(first)).toBe(1);
      first.close();

      // The next process reads it with the totals: no call, no request.
      const next = Store.open(path);
      try {
        const i2 = loadRunIndex(next);
        expect(cacheTotalsOf(next, i2, [runId, replay].map((id) => i2.byId.get(id)!))).toEqual(cache);
        expect([runsRead(next), cachesRead(next)]).toEqual([0, 0]);
        // Totals kept before the model was carry three fields a miss: read as they are, with no model.
        const [row] = next.query(`SELECT key, stats FROM run_stats WHERE run_id = ?`, runId);
        const kept = JSON.parse(String(row.stats)) as { cache: { misses: unknown[][] } };
        kept.cache.misses = kept.cache.misses.map((m) => m.slice(0, 3));
        next.saveRunStats([{ runId, key: String(row.key), stats: JSON.stringify(kept) }]);
      } finally {
        next.close();
      }
      const older = Store.open(path);
      try {
        const i3 = loadRunIndex(older);
        expect(cacheTotalsOf(older, i3, [i3.byId.get(runId)!]).get(runId)).toEqual({ ...cache.get(runId)!, misses: [[3, null, cache.get(runId)!.misses[0][2], null]] });
        expect(cachesRead(older)).toBe(0);
      } finally {
        older.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the prompt cache another thread kept', () => {
  it('is read from the store when this thread remembers the run’s totals without it, never worked out again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowlap-cache-kept-'));
    const path = join(dir, 'shadowlap.db');
    const here = Store.open(path);
    const warm = Store.open(path);
    try {
      const runId = addRun(here, { startedAt: NOW - HOUR, calls: 'llll' });
      const run = (s: Store) => {
        const ix = loadRunIndex(s);
        return { ix, r: ix.byId.get(runId)! };
      };
      // This thread opened the run's page: it remembers the run's totals, without the cache.
      let h = run(here);
      expect(callTotals(here, h.ix, [h.r]).get(runId)).not.toHaveProperty('cache');
      // The warm-up, on a thread of its own, worked out the cache and kept it with the totals.
      const w = run(warm);
      const cache = cacheTotalsOf(warm, w.ix, [w.r]);
      expect(cachesRead(warm)).toBe(1);
      // The Overview, asked here, finds it known in the store, and reads no request of the run.
      h = run(here);
      expect(totalsKnown(here, h.ix, [h.r], { cache: () => true })).toEqual({ done: 1, total: 1 });
      expect(cacheTotalsOf(here, h.ix, [h.r])).toEqual(cache);
      expect(cachesRead(here)).toBe(0);
    } finally {
      here.close();
      warm.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the Overview, worked out in a request', () => {
  it('adds up a short run that just ended, and leaves a long run’s prompt cache to the warm-up, saying it is warming', async () => {
    // A long run of the week whose page was opened (its totals known, its cache not), and a short one.
    const long = addRun(store, { startedAt: NOW - 2 * HOUR, calls: 'l'.repeat(SUMMARY_CALLS_BUDGET + 1) });
    addRun(store, { startedAt: NOW - HOUR, calls: 'llll' });
    const index = loadRunIndex(store);
    callTotals(store, index, [index.byId.get(long)!]);
    const asked = { kind: 'summary' as const, work: { tz: 'UTC', now: NOW, goldens: [], team: null, project: null } };
    const reads = [runsRead(store), cachesRead(store)];
    // The short run is added up in the request, its cache with it; the long one's cache is not.
    expect(JSON.parse((await runJob(store, asked)).body)).toEqual({ warming: { done: 1, total: 2 } });
    expect([runsRead(store), cachesRead(store)]).toEqual([reads[0] + 1, reads[1] + 1]);
    // However it is asked within the budget: the week's cache leaves it out rather than read it.
    expect(overviewKnown(store, { tz: 'UTC', now: NOW, budget: SUMMARY_CALLS_BUDGET })).toEqual({ done: 1, total: 2 });
    const within = overviewSummary(store, { tz: 'UTC', now: NOW, budget: SUMMARY_CALLS_BUDGET });
    expect(within.sums.week.runs).toBe(2);
    expect(cachesRead(store)).toBe(reads[1] + 1);
    // Once the warm-up has worked it out, the request answers whole, reading nothing.
    while (!warmRunStats(store, { budgetMs: 0, now: NOW }));
    const warmed = [runsRead(store), cachesRead(store)];
    const summary = JSON.parse((await runJob(store, asked)).body) as { warming?: unknown; sums: { week: { runs: number } }; cache: { missCount: number } };
    expect(summary.warming).toBeUndefined();
    expect(summary.sums.week.runs).toBe(2);
    expect([runsRead(store), cachesRead(store)]).toEqual(warmed);
  });

  it('adds up a recording in progress once, for the sums and its row of the grid, though it made a call meanwhile', () => {
    const rec = addRun(store, { startedAt: NOW - HOUR, calls: 'l'.repeat(40), status: 'running' });
    // A call the recording makes while the Overview is worked out, read into the run index as anything
    // the Overview reads after it (its fixes, its tests) reads it.
    const recording = store.recordingRuns.bind(store);
    const spy = vi.spyOn(store, 'recordingRuns').mockImplementation((now?: number) => {
      const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'fp41', occurrence: 1 };
      store.appendCallStart({ runId: rec, callNo: 41, ...identity, origin: 'live', effect: null, requestRef: null, meta: {}, at: NOW });
      store.appendCallEnd(identity, { runId: rec, callNo: 41, attempt: 0, responseRef: null, outcome: 'ok', meta: { latencyMs: 10 }, at: NOW + 10 });
      loadRunIndex(store);
      return recording(now);
    });
    try {
      const before = runsRead(store);
      const summary = overviewSummary(store, { tz: 'UTC', now: NOW, budget: 10 });
      // Its calls counted from the totals worked out once, rather than left out past the budget, or read again.
      expect(summary.sums.week.origins.l).toBe(40);
      expect(summary.sums.week.calls).toBe(40);
      expect(runsRead(store)).toBe(before + 1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('kept totals', () => {
  it('keep the run index current: keeping a run’s totals changes no run', () => {
    const rec = addRun(store, { startedAt: NOW - DAY, calls: 'llll' });
    const index = loadRunIndex(store);
    // The first read works out the run's totals and keeps them in the store.
    runStats(store, index, [index.byId.get(rec)!]);
    expect(store.query(`SELECT COUNT(*) AS n FROM run_stats`)).toEqual([{ n: 1 }]);
    expect(loadRunIndex(store)).toBe(index);
    // Any other write to a run is taken into the index in place.
    store.updateRunMeta(rec, { labels: ['bug'] });
    expect(loadRunIndex(store)).toBe(index);
    expect(index.byId.get(rec)!.meta.labels).toEqual(['bug']);
  });

  it('read the index again when another process wrote while they were kept', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowlap-kept-index-'));
    const here = Store.open(join(dir, 'shadowlap.db'));
    const other = Store.open(join(dir, 'shadowlap.db'));
    try {
      addRun(here, { startedAt: NOW - DAY, calls: 'll' });
      const index = loadRunIndex(here);
      let theirs = '';
      keepingIndex(here, () => {
        theirs = addRun(other, { startedAt: NOW, calls: 'l' });
        return here.saveRunStats([]);
      });
      expect(loadRunIndex(here)).toBe(index);
      expect(index.byId.has(theirs)).toBe(true);
    } finally {
      here.close();
      other.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('are worked out ahead, a slice at a time, so a dashboard’s first look reads no calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadowlap-warm-'));
    const path = join(dir, 'shadowlap.db');
    try {
      const first = Store.open(path);
      const recs: string[] = [];
      for (let i = 0; i < 250; i++) recs.push(addRun(first, { startedAt: NOW - (i + 1) * 60_000, calls: 'lll' }));
      for (const r of recs.slice(0, 20)) addRun(first, { parent: r, startedAt: NOW - 1000, divergence: 2, calls: 'rl' });
      addRun(first, { startedAt: NOW, calls: 'l', status: 'running' });
      // Twenty days old: the Overview's week will never ask for its prompt cache.
      addRun(first, { startedAt: NOW - 20 * DAY, calls: 'lll' });
      // Each slice does at least one batch of runs, however small its budget.
      let slices = 0;
      while (!warmRunStats(first, { budgetMs: 0, now: NOW })) slices++;
      expect(slices).toBeGreaterThan(0);
      expect(runsRead(first)).toBe(271);
      // The prompt cache of the last eight days' runs too, read once more each.
      expect(cachesRead(first)).toBe(270);
      // Done: another slice finds nothing left to work out.
      expect(warmRunStats(first, { budgetMs: 0, now: NOW })).toBe(true);
      expect([runsRead(first), cachesRead(first)]).toEqual([271, 270]);
      first.close();

      const next = Store.open(path);
      try {
        const summary = overviewSummary(next, { tz: 'UTC', now: NOW });
        expect(summary.sums.week.runs).toBe(271);
        // Only the run still recording had its calls read, for its totals and its cache.
        expect([runsRead(next), cachesRead(next)]).toEqual([1, 1]);
      } finally {
        next.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('are worked out ahead at the project\'s prices, so a page pricing at them reads no calls', async () => {
    const own = { 'my-model': { input: 1, output: 2, above: { tokens: 50_000, input: 3, output: 4 } } };
    const runs = [0, 1, 2].map((i) => addRun(store, { startedAt: NOW - (i + 1) * 60_000, calls: [{ code: 'l', model: 'my-model', usage: { inputTokens: 30_000, outputTokens: 10 } }, { code: 'l', model: 'my-model', usage: { inputTokens: 60_000, outputTokens: 10 } }] }));
    // A slice of the warm-up as the read pool sends it, with the project's prices.
    for (let i = 0; i < 20; i++) if ((await runJob(store, { kind: 'warm', budgetMs: 0, prices: own })).warm?.done) break;
    expect(runsRead(store)).toBe(3);
    const index = loadRunIndex(store);
    const stats = runStats(store, index, runs.map((id) => index.byId.get(id)!), { prices: own });
    expect(runsRead(store)).toBe(3);
    for (const id of runs) expect(stats.get(id)!.spent).toBeCloseTo((30_000 * 1 + 10 * 2 + 60_000 * 3 + 10 * 4) / 1e6, 12);
    expect(totalsKnown(store, index, runs.map((id) => index.byId.get(id)!), { prices: own })).toEqual({ done: 3, total: 3 });
  });
});
