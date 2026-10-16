import { describe, expect, it } from 'vitest';
import { cacheUse, CACHE_MISS_MIN_TOKENS, importedRecording, runCache, runCacheUse, Store, sumCacheUse } from '../src/index.js';
import { assistant, batchRun, cachedUsage, RunBuilder, text, toolResult, toolUse, usage, user } from './run-fixtures.js';

describe('the cache-miss rule', () => {
  it('judges a batch within each conversation: a new ticket is not a miss', () => {
    const store = Store.open(':memory:');
    const { runId } = batchRun(store, 40);
    const r = runCache(store, store.getCalls(runId));
    expect(r.misses).toEqual([]);
    expect(r.sentAgain).toBe(0);
    // Each conversation writes 6,000 tokens once, then reads its prefix back.
    const whole = 6000 + 6800 + 7600;
    const read = 6000 + 6800;
    expect(r.readShare).toBeCloseTo(read / whole, 6);
    expect(r.readShareAll).toBeCloseTo(read / whole, 6);
    store.close();
  });

  it('flags the call where a conversation stopped reading its prefix, with the tokens sent again', () => {
    const store = Store.open(':memory:');
    const { runId, byTicket } = batchRun(store, 40, { broken: { ticket: 31, call: 3 } });
    const r = runCache(store, store.getCalls(runId));
    const third = byTicket.get(31)![5]!;
    const second = byTicket.get(31)![3]!;
    expect(r.misses).toEqual([{ callNo: third, sentAgain: cachedUsage(2).inputTokens + cachedUsage(2).cacheReadInputTokens! + cachedUsage(2).cacheCreationInputTokens!, previousCallNo: second, scope: null, conversation: 31 }]);
    expect(r.sentAgain).toBe(6800);
    store.close();
  });

  it('needs at least 1,024 tokens of shortfall', () => {
    const store = Store.open(':memory:');
    const q = [user('Go.')];
    const a = [toolUse('step', {}, 'toolu_1')];
    const next = [...q, assistant(a), user([toolResult('toolu_1', 'ok')])];
    const pair = (read: number) => {
      const b = RunBuilder.start(store);
      b.model({ messages: q }, a, { usage: usage(10, 0, 5000) });
      b.model({ messages: next }, [toolUse('step', {}, 'toolu_2')], { usage: usage(1033, read, 0) });
      return runCache(store, store.getCalls(b.end())).misses.map((m) => m.sentAgain);
    };
    // 1,023 short of the previous whole input (5,010): the newest turn, not a broken prefix.
    expect(pair(5010 - CACHE_MISS_MIN_TOKENS + 1)).toEqual([]);
    expect(pair(5010 - CACHE_MISS_MIN_TOKENS)).toEqual([1024]);
    store.close();
  });

  it('judges every call whose cache read is known, and none whose provider reports no cache', () => {
    const store = Store.open(':memory:');
    const q = [user('Go.')];
    const a = [toolUse('step', {}, 'toolu_1')];
    const next = [...q, assistant(a), user([toolResult('toolu_1', 'ok')])];

    // An agent that never asked Anthropic to cache: each turn sends the whole history again.
    const plain = RunBuilder.start(store);
    plain.model({ messages: q }, a, { usage: usage(5000, 0, 0) });
    plain.model({ messages: next }, [text('done')], { usage: usage(6000, 0, 0) });
    const r = runCache(store, store.getCalls(plain.end()));
    expect(r.misses.map((m) => [m.callNo, m.sentAgain])).toEqual([[2, 5000]]);
    expect(r.readShare).toBe(0);

    // A local model server that reports no cache at all: nothing to compare.
    const local = RunBuilder.start(store);
    const name = 'POST /v1/chat/completions';
    local.model({ model: 'qwen3', messages: q }, a, { name, provider: 'openai', usage: { inputTokens: 5000, outputTokens: 40 } });
    local.model({ model: 'qwen3', messages: next }, [text('done')], { name, provider: 'openai', usage: { inputTokens: 6000, outputTokens: 40 } });
    expect(runCache(store, store.getCalls(local.end())).misses).toEqual([]);

    // Gemini leaves the cached count out when it read nothing: that is a read of zero.
    const gemini = RunBuilder.start(store);
    const g = 'POST /v1beta/models/gemini-2.5-flash:generateContent';
    const reply = (t: string) => ({ raw: { body: JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: 'STOP' }] }), contentType: 'application/json' }, name: g, provider: 'gemini' });
    const first = { role: 'user', parts: [{ text: 'Summarise the incident.' }] };
    gemini.model({ contents: [first] }, null, { ...reply('Disk full.'), usage: { inputTokens: 4000, outputTokens: 10 } });
    gemini.model({ contents: [first, { role: 'model', parts: [{ text: 'Disk full.' }] }, { role: 'user', parts: [{ text: 'Why?' }] }] }, null, { ...reply('No rotation.'), usage: { inputTokens: 4100, outputTokens: 10 } });
    expect(runCache(store, store.getCalls(gemini.end())).misses.map((m) => [m.callNo, m.sentAgain])).toEqual([[2, 4000]]);
    store.close();
  });

  it('judges each scope on its own', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    // A customer simulator and the agent alternate; each reads its own prefix back.
    b.model({ messages: [user('Start.')] }, [text('Hi, refund please.')], { scope: 'customer', usage: usage(10, 0, 3000) });
    b.model({ messages: [user('Hi, refund please.')] }, [text('Looking.')], { scope: 'agent', usage: usage(10, 0, 9000) });
    b.model({ messages: [user('Start.'), assistant([text('Hi, refund please.')]), user('Looking.')] }, [text('Thanks.')], { scope: 'customer', usage: usage(10, 3010, 200) });
    b.end();
    // Judged against the previous call of its own scope (3,010), not the agent's 9,010.
    expect(runCache(store, store.getCalls(b.runId)).misses).toEqual([]);
    store.close();
  });
});

describe('cache use across runs', () => {
  it('sums live calls since a time and keeps the four largest misses among them', () => {
    const store = Store.open(':memory:');
    const day = 86_400_000;
    const now = 1_760_000_000_000;
    const mk = (startedAt: number, broken: number[], o: { replayOf?: string; imported?: boolean } = {}) => {
      const b = RunBuilder.start(store, { startedAt, ...(o.replayOf ? { parent: o.replayOf } : {}), ...(o.imported ? { meta: { imported: { at: startedAt, from: 'cap.jsonl' } } } : {}) });
      let q: unknown[] = [user('Begin.')];
      for (let m = 1; m <= 6; m++) {
        const a = [toolUse('step', { m }, `toolu_${m}`)];
        const u = broken.includes(m) ? usage(10, 0, cachedUsage(m).cacheReadInputTokens! + cachedUsage(m).cacheCreationInputTokens!) : cachedUsage(m);
        b.model({ messages: q }, a, { usage: u, origin: o.replayOf && m < 4 ? 'replayed' : 'live', model: 'claude-sonnet-5-20260101' });
        q = [...q, assistant(a), user([toolResult(`toolu_${m}`, 'ok')])];
      }
      return b.end();
    };
    const old = mk(now - 10 * day, [3]);
    const a = mk(now - 2 * day, [2, 5]);
    const bRun = mk(now - day, [6, 4, 3]);
    // A replay: its replayed calls (1–3) are not live, so their misses are not counted here.
    const c = mk(now - day / 2, [2, 4], { replayOf: a });
    // An imported capture: live somewhere else.
    mk(now - day / 3, [5], { imported: true });
    const use = cacheUse(store, now - 7 * day);
    expect(use.runs).toBe(3);
    // Misses: a#2 (6,000), a#5 (8,400), b#3 (6,800), b#4 (7,600), b#6 (9,200), c#4 (7,600); c#2 was replayed.
    expect(use.misses).toBe(6);
    expect(use.sentAgain).toBe(6000 + 8400 + 6800 + 7600 + 9200 + 7600);
    expect(use.largest.map((m) => [m.runId, m.callNo, m.sentAgain])).toEqual([
      [bRun, 6, 9200],
      [a, 5, 8400],
      [c, 4, 7600],
      [bRun, 4, 7600],
    ]);
    expect(use.largest[0]!.model).toBe('sonnet-5');
    expect(use.readShare).toBeGreaterThan(0);
    expect(use.readShare).toBeLessThan(1);
    // Last week alone holds the old run.
    const last = cacheUse(store, now - 14 * day, { until: now - 7 * day });
    expect(last.runs).toBe(1);
    expect(last.largest.map((m) => [m.runId, m.callNo])).toEqual([[old, 3]]);

    // It is each run's part summed: what a reader that keeps a part per run (the dashboard's
    // run_stats) hands to sumCacheUse comes out the same.
    const week = store.allRuns().filter((r) => r.startedAt >= now - 7 * day && !importedRecording(r));
    const parts = week.map((r) => ({ runId: r.runId, startedAt: r.startedAt, use: runCacheUse(store, store.getCalls(r.runId)) }));
    expect(parts.find((p) => p.runId === c)!.use!.misses.map((m) => m.callNo)).toEqual([4]);
    expect(sumCacheUse(parts)).toEqual(use);
    expect(sumCacheUse(parts, 1).largest).toEqual(use.largest.slice(0, 1));
    expect(sumCacheUse([])).toEqual({ readShare: null, liveInput: 0, liveRead: 0, misses: 0, sentAgain: 0, largest: [], runs: 0 });
    store.close();
  });
});

describe('cache use on the Overview, asked again', () => {
  it('reads a finished run’s calls once, and a run still recording each time', () => {
    const store = Store.open(':memory:');
    const now = 1_760_000_000_000;
    const turn = (b: RunBuilder, m: number, broken = false) => {
      const q: unknown[] = [user('Begin.')];
      for (let i = 1; i < m; i++) q.push(assistant([toolUse('step', { i }, `toolu_${i}`)]), user([toolResult(`toolu_${i}`, 'ok')]));
      const u = broken ? usage(10, 0, cachedUsage(m).cacheReadInputTokens! + cachedUsage(m).cacheCreationInputTokens!) : cachedUsage(m);
      b.model({ messages: q }, [toolUse('step', { i: m }, `toolu_${m}`)], { usage: u });
    };
    const done: string[] = [];
    for (let r = 0; r < 40; r++) {
      const b = RunBuilder.start(store, { startedAt: now + r });
      for (let m = 1; m <= 4; m++) turn(b, m, r === 7 && m === 3);
      done.push(b.end());
    }
    const recording = RunBuilder.start(store, { startedAt: now + 100 });
    turn(recording, 1);
    turn(recording, 2);

    const real = store.getCalls.bind(store);
    const read: string[] = [];
    store.getCalls = (runId: string) => {
      read.push(runId);
      return real(runId);
    };
    const first = cacheUse(store, now);
    expect(first.runs).toBe(41);
    expect(first.largest.map((m) => [m.runId, m.callNo])).toEqual([[done[7], 3]]);
    expect(read).toHaveLength(41);

    read.length = 0;
    expect(cacheUse(store, now)).toEqual(first);
    expect(read).toEqual([recording.runId]);

    // The recording's next call is a miss: it shows at once.
    turn(recording, 3, true);
    const later = cacheUse(store, now);
    expect(later.misses).toBe(2);
    expect(later.largest.map((m) => m.runId)).toContain(recording.runId);
    // What the Overview is given is its own: changing it changes nothing kept.
    later.largest[0]!.sentAgain = -1;
    expect(cacheUse(store, now).largest[0]!.sentAgain).toBeGreaterThan(0);
    store.close();
  });
});
