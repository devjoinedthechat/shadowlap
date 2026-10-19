import { describe, expect, it, vi } from 'vitest';
import { LiveConversations, runConversations, Store, type CallRecord } from '../src/index.js';
import { batchRun, closingBatch } from './run-fixtures.js';

/**
 * A run's conversations as a recording's page follows it: each call is placed when it arrives, from
 * what came before it, so keeping up costs as much as the calls that arrived, not as much as the run
 * is long. Placing the calls as they arrive ends where placing the finished run does.
 */

/** The run's calls as a recording shows them: each call started, then answered; a record seen before keeps its identity. */
function* arriving(calls: readonly CallRecord[]): Generator<CallRecord[]> {
  const now: CallRecord[] = [];
  for (const c of calls) {
    now.push({ ...c, end: null, attempts: [] });
    yield [...now];
    now[now.length - 1] = c;
    yield [...now];
  }
}

/** Each call's conversation, in call order. */
const placed = (r: { byCall: Map<number, unknown> }) => [...r.byCall].sort((a, b) => a[0] - b[0]);

function followed(store: Store, runId: string) {
  const calls = store.getCalls(runId);
  const live = new LiveConversations(store, { attribute: true });
  let last = null;
  for (const seen of arriving(calls)) last = live.update(seen);
  return { calls, live: last!, whole: runConversations(store, calls, { attribute: true }) };
}

describe('placing a recording’s calls as they arrive', () => {
  it('ends where placing the finished run does, ticket by ticket', () => {
    const store = Store.open(':memory:');
    const { runId, byTicket } = batchRun(store, 6);
    const { live, whole } = followed(store, runId);
    expect(live.conversations).toEqual(whole.conversations);
    expect(placed(live)).toEqual(placed(whole));
    expect([...live.requests].sort((a, b) => a - b)).toEqual([...whole.requests].sort((a, b) => a - b));
    // Each ticket's fetch, made before its first model call, waited for it and went with it.
    for (const [t, nos] of byTicket) expect(live.byCall.get(nos[0]!)!.conversation).toBe(t);
    store.close();
  });

  it('reads tools a model asked for from answers that arrive after the call was placed, streamed too', () => {
    const store = Store.open(':memory:');
    const { runId } = batchRun(store, 3, { stream: true });
    const { live, whole } = followed(store, runId);
    expect(placed(live)).toEqual(placed(whole));
    const closing = closingBatch(store, 3);
    const after = followed(store, closing.runId);
    expect(placed(after.live)).toEqual(placed(after.whole));
    store.close();
  });

  it('leaves a call that feeds a model call in no conversation until that model call arrives', () => {
    const store = Store.open(':memory:');
    const { runId, byTicket } = batchRun(store, 2);
    const calls = store.getCalls(runId);
    const [get2] = byTicket.get(2)!;
    const live = new LiveConversations(store, { attribute: true });
    const upTo = (n: number) => calls.filter((c) => c.callNo <= n);
    expect(live.update(upTo(get2!))!.byCall.get(get2!)!.conversation).toBeNull();
    expect(live.update(upTo(get2! + 1))!.byCall.get(get2!)!.conversation).toBe(2);
    store.close();
  });

  it('reads only the calls that arrived', () => {
    const store = Store.open(':memory:');
    const { runId } = batchRun(store, 40);
    const calls = store.getCalls(runId);
    const live = new LiveConversations(store, { attribute: true });
    live.update(calls.slice(0, -6));
    const json = vi.spyOn(store, 'getJson');
    const blob = vi.spyOn(store, 'getBlob');
    const out = live.update(calls)!;
    // The last ticket's six calls: its requests, messages and answers, never the 234 calls before them.
    expect(json.mock.calls.length + blob.mock.calls.length).toBeLessThan(40);
    expect(out.conversations).toHaveLength(40);
    expect(out.byCall.get(calls.at(-1)!.callNo)!.conversation).toBe(40);
    json.mockRestore();
    blob.mockRestore();
    store.close();
  });

  it('asks to start again when the calls are not those it placed', () => {
    const store = Store.open(':memory:');
    const a = batchRun(store, 2);
    const b = batchRun(store, 2);
    const live = new LiveConversations(store, { attribute: true });
    const calls = store.getCalls(a.runId);
    expect(live.update(calls)).not.toBeNull();
    expect(live.update(calls.slice(1))).toBeNull();
    expect(live.update(calls.slice(0, 3))).toBeNull();
    expect(live.update(store.getCalls(b.runId))).toBeNull();
    store.close();
  });
});
