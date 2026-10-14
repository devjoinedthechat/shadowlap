import { describe, expect, it } from 'vitest';
import { cacheUse, CACHE_MISS_MIN_TOKENS, runCache, Store } from '../src/index.js';
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

  it('needs at least 1,024 tokens of shortfall, and a conversation that uses the cache', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    const q = [user('Go.')];
    const a = [toolUse('step', {}, 'toolu_1')];
    const cached = b.model({ messages: q }, a, { usage: usage(10, 0, 5000) });
    // 1,023 short of the previous whole input: the newest turn, not a broken prefix.
    const near = b.model({ messages: [...q, assistant(a), user([toolResult('toolu_1', 'ok')])] }, [toolUse('step', {}, 'toolu_2')], { usage: usage(1033, 5010 - CACHE_MISS_MIN_TOKENS + 1, 0) });
    expect(near).toBe(cached + 1);
    b.end();
    expect(runCache(store, store.getCalls(b.runId)).misses).toEqual([]);

    // An agent that never asked for caching: nothing stopped hitting, since nothing ever hit.
    const plain = RunBuilder.start(store);
    plain.model({ messages: q }, a, { usage: usage(5000, 0, 0) });
    plain.model({ messages: [...q, assistant(a), user([toolResult('toolu_1', 'ok')])] }, [text('done')], { usage: usage(6000, 0, 0) });
    plain.end();
    const r = runCache(store, store.getCalls(plain.runId));
    expect(r.misses).toEqual([]);
    expect(r.readShare).toBe(0);
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
    store.close();
  });
});
