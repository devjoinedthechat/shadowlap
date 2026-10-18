import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import type { RunDetail } from '../src/api.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import { liveRuns } from '../src/meta.js';
import { familyRefresh, feedMoves, runRefresh, withLiveCalls } from '../ui/connection.js';
import { mergeRun, settledThrough } from '../ui/live.js';
import { addRun, HOUR } from './read-model-store.js';
import { assistant, RunBuilder, SYSTEM, text, toolResult, toolUse, TOOLS, user } from '../../engine/test/run-fixtures.js';

/**
 * A run's page while runs record: a finished run's page asks for nothing while another run records,
 * and a recording's page asks only for its newest calls. Whenever any run recorded a call, every open
 * run page used to fetch its whole run again on its next poll: 39 MB a poll for a run of 50,000 calls.
 */

/** One ticket of a support agent's batch: the ticket fetched, then three model calls and the two tools they ask for. */
function ticket(b: RunBuilder, t: number): number[] {
  const order = `A-${2000 + t}`;
  const get = b.tool('get_ticket', { ticket: `T-${t}` }, { ticket: `T-${t}`, order });
  const first = [user(`Ticket T-${t}: order ${order} arrived damaged.`)];
  const a1 = [toolUse('lookup_order', { order_id: order }, `toolu_${t}_1`)];
  const m1 = b.model({ system: SYSTEM, tools: TOOLS, messages: first }, a1);
  const lookup = b.tool('lookup_order', { order_id: order }, { amount: 40 });
  const second = [...first, assistant(a1), user([toolResult(`toolu_${t}_1`, { amount: 40 })])];
  const a2 = [toolUse('issue_refund', { order_id: order }, `toolu_${t}_2`)];
  const m2 = b.model({ system: SYSTEM, tools: TOOLS, messages: second }, a2);
  const refund = b.tool('issue_refund', { order_id: order }, { status: 'issued' }, { effect: 'write' });
  const m3 = b.model({ system: SYSTEM, tools: TOOLS, messages: [...second, assistant(a2), user([toolResult(`toolu_${t}_2`, { status: 'issued' })])] }, [text(`Refunded ${order}.`)]);
  return [get, m1, lookup, m2, refund, m3];
}

const identity = (n: number) => ({ kind: 'tool' as const, name: 'lookup_order', fingerprint: `f${n}`, occurrence: 0 });
function addCall(store: Store, runId: string, callNo: number, answered = true): void {
  store.appendCallStart({ runId, callNo, ...identity(callNo), origin: 'live', effect: 'read', requestRef: store.putJson({ args: { n: callNo } }), meta: {}, at: Date.now() });
  if (answered) answer(store, runId, callNo);
}
function answer(store: Store, runId: string, callNo: number): void {
  store.appendCallEnd(identity(callNo), { runId, callNo, attempt: 0, responseRef: store.putJson({ result: callNo }), outcome: 'ok', meta: { latencyMs: 5 }, at: Date.now() });
}

describe('what a run’s page loads again on', () => {
  it('tells runs moving from calls arriving, and takes a recording’s count from the feed', () => {
    expect(feedMoves({ runs: true, calls: true }, false)).toBe('runs');
    expect(feedMoves({ runs: false, calls: true }, false)).toBe('calls');
    expect(feedMoves({ runs: false, calls: false, changed: true }, false)).toBeNull();
    expect(feedMoves({ changed: true }, false)).toBe('runs');
    expect(feedMoves({ runs: false, calls: false }, true)).toBe('runs');
    const list = [
      { runId: 'a', calls: 30 },
      { runId: 'b', calls: 4 },
    ];
    const moved = withLiveCalls(list, [{ runId: 'b', calls: 5 }])!;
    expect(moved).toEqual([
      { runId: 'a', calls: 30 },
      { runId: 'b', calls: 5 },
    ]);
    expect(moved[0]).toBe(list[0]);
    // Nothing moved: the same list, so nothing redraws.
    expect(withLiveCalls(list, [{ runId: 'b', calls: 4 }])).toBe(list);
  });

  it('is the same for a finished run however many calls another run records, and moves with a recording’s own calls', () => {
    // A finished run's page, another run recording: nothing to load.
    expect(runRefresh(3, null)).toBe(runRefresh(3, null));
    expect(runRefresh(3, null)).not.toBe(runRefresh(4, null));
    // Its own call started, then answered: both load what changed.
    const a = runRefresh(3, { calls: 10, events: 19 });
    const b = runRefresh(3, { calls: 10, events: 20 });
    const c = runRefresh(3, { calls: 11, events: 21 });
    expect(new Set([a, b, c]).size).toBe(3);
    // The family moves with a recording in it, and not with one elsewhere.
    const family = new Set(['rec', 'fork']);
    expect(familyRefresh(3, [{ runId: 'other', calls: 9 }], family)).toBe(familyRefresh(3, [{ runId: 'other', calls: 10 }], family));
    expect(familyRefresh(3, [{ runId: 'fork', calls: 9 }], family)).not.toBe(familyRefresh(3, [{ runId: 'fork', calls: 10 }], family));
  });

  it('asks a recording for the calls after those that won’t change, and puts them after the ones it has', () => {
    const calls = [
      { callNo: 1, outcome: 'ok' },
      { callNo: 2, outcome: 'error' },
      { callNo: 3, outcome: 'ok' },
      { callNo: 4, outcome: null },
      { callNo: 5, outcome: 'ok' },
    ];
    expect(settledThrough(calls)).toBe(3);
    // A failure the agent may retry is answered again under its number, also once another branch
    // of the agent made calls after it: nothing from it on is settled.
    const retried = calls.map((c) => (c.callNo === 2 ? { ...c, retryable: true } : c));
    expect(settledThrough(retried)).toBe(1);
    expect(settledThrough(retried.slice(0, 2))).toBe(1);
    // One it won't retry is as final as an answer, last or not.
    expect(settledThrough(calls.slice(0, 2))).toBe(2);
    expect(settledThrough([])).toBe(0);
    const had = { status: 'running', calls: calls.map((c) => ({ ...c })) };
    const part = { status: 'running', after: 3, calls: [{ callNo: 4, outcome: 'ok' }, { callNo: 5, outcome: 'ok' }, { callNo: 6, outcome: null }] };
    const merged = mergeRun(had, part);
    expect(merged.calls.map((c) => [c.callNo, c.outcome])).toEqual([
      [1, 'ok'],
      [2, 'error'],
      [3, 'ok'],
      [4, 'ok'],
      [5, 'ok'],
      [6, null],
    ]);
    expect(merged.calls[0]).toBe(had.calls[0]);
    expect('after' in merged).toBe(false);
    // A whole run replaces what the page had.
    const whole = { status: 'completed', calls: [{ callNo: 1, outcome: 'ok' }] };
    expect(mergeRun(had, whole)).toBe(whole);
  });
});

describe('a run’s page on the server', () => {
  let store: Store;
  let dash: Dashboard;
  const get = (path: string, etag?: string) => fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token, ...(etag ? { 'if-none-match': etag } : {}) } });

  beforeEach(async () => {
    store = Store.open(':memory:');
    dash = await startDashboard({ store, dbPath: ':memory:' });
  });
  afterEach(async () => {
    await dash.close();
    store.close();
  });

  it('answers a run it has already 304, while another run records, without working it out again', async () => {
    const done = addRun(store, { startedAt: Date.now() - HOUR, calls: 'lolo' });
    const other = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/work' } }).runId;
    addCall(store, other, 1);
    const first = await get(`runs/${done}`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(((await first.json()) as RunDetail).calls).toHaveLength(4);

    const reads = vi.spyOn(store, 'getCalls');
    for (let n = 2; n <= 5; n++) {
      addCall(store, other, n);
      const again = await get(`runs/${done}`, etag);
      expect(again.status).toBe(304);
    }
    // Another run ending, and one more starting and being labelled, move the run list but not this run.
    store.endRun(other, 'completed');
    expect((await get(`runs/${done}`, etag)).status).toBe(304);
    const third = addRun(store, { startedAt: Date.now() - 1000, calls: 'll' });
    expect((await get(`runs/${done}`, etag)).status).toBe(304);
    store.updateRunMeta(third, { labels: ['elsewhere'] });
    expect((await get(`runs/${done}`, etag)).status).toBe(304);
    // The run's calls were never read to answer.
    expect(reads.mock.calls.filter(([id]) => id === done)).toEqual([]);
    reads.mockRestore();

    // A label on it is a change of its own.
    store.updateRunMeta(done, { labels: ['refund'] });
    const labelled = await get(`runs/${done}`, etag);
    expect(labelled.status).toBe(200);
    const tagged = labelled.headers.get('etag')!;
    expect(((await labelled.json()) as RunDetail).run.meta?.labels).toEqual(['refund']);

    // So is a fork of it: its page lists its children.
    const fork = addRun(store, { parent: done, startedAt: Date.now(), calls: 'rrl', divergence: 3 });
    const forked = await get(`runs/${done}`, tagged);
    expect(forked.status).toBe(200);
    expect(((await forked.json()) as RunDetail).children.map((c) => c.runId)).toEqual([fork]);
  });

  it('gives a recording’s page the calls after those it has, and the rest of the run whole', async () => {
    const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/work' } }).runId;
    for (let n = 1; n <= 5; n++) addCall(store, rec, n, n < 5);
    const whole = (await (await get(`runs/${rec}`)).json()) as RunDetail;
    expect(whole.calls.map((c) => c.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', null]);
    expect(whole.after).toBeUndefined();

    answer(store, rec, 5);
    addCall(store, rec, 6, false);
    const res = await get(`runs/${rec}?after=4`);
    expect(res.status).toBe(200);
    const part = (await res.json()) as RunDetail;
    expect(part.after).toBe(4);
    expect(part.calls.map((c) => [c.callNo, c.outcome])).toEqual([
      [5, 'ok'],
      [6, null],
    ]);
    // What isn't a call row is the whole run's.
    expect(part.summary.total).toBe(6);
    expect(part.run.runId).toBe(rec);
    // Revalidated like the whole run: the same part, nothing new, is a 304.
    expect((await get(`runs/${rec}?after=4`, res.headers.get('etag')!)).status).toBe(304);
    expect((await get(`runs/${rec}?after=-1`)).status).toBe(400);
    expect((await get(`runs/${rec}?after=two`)).status).toBe(400);
  });

  it('asks again for a failure the agent may retry, though calls of another branch came after it', async () => {
    const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/work' } }).runId;
    addCall(store, rec, 1);
    // A model call the provider answered 529, which the agent retries; meanwhile its other branch goes on.
    const model = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'm2', occurrence: 0 };
    store.appendCallStart({ runId: rec, callNo: 2, ...model, origin: 'live', effect: null, requestRef: null, meta: { scope: 'triage' }, at: Date.now() });
    store.appendCallEnd(model, { runId: rec, callNo: 2, attempt: 0, responseRef: null, outcome: 'error', meta: { status: 529, retryable: true, latencyMs: 300 }, at: Date.now() });
    addCall(store, rec, 3);
    let page = (await (await get(`runs/${rec}`)).json()) as RunDetail;
    expect(page.calls.map((c) => [c.callNo, c.outcome, c.retryable ?? false])).toEqual([
      [1, 'ok', false],
      [2, 'error', true],
      [3, 'ok', false],
    ]);
    // The page follows from call 1: call 2 may still be answered again.
    const after = settledThrough(page.calls);
    expect(after).toBe(1);
    // The retry answers call 2 under its number.
    store.appendCallEnd(model, { runId: rec, callNo: 2, attempt: 1, responseRef: null, outcome: 'ok', meta: { status: 200, latencyMs: 800 }, at: Date.now() });
    page = mergeRun(page, (await (await get(`runs/${rec}?after=${after}`)).json()) as RunDetail);
    expect(page.calls.map((c) => [c.callNo, c.outcome, c.attempts, c.retryable ?? false])).toEqual([
      [1, 'ok', 0, false],
      [2, 'ok', 1, false],
      [3, 'ok', 0, false],
    ]);
    expect(settledThrough(page.calls)).toBe(3);
    // Once the run has ended, no failure is waiting for a retry.
    store.appendCallStart({ runId: rec, callNo: 4, ...model, fingerprint: 'm4', origin: 'live', effect: null, requestRef: null, meta: {}, at: Date.now() });
    store.appendCallEnd({ ...model, fingerprint: 'm4' }, { runId: rec, callNo: 4, attempt: 0, responseRef: null, outcome: 'error', meta: { status: 529, retryable: true, latencyMs: 300 }, at: Date.now() });
    store.endRun(rec, 'failed');
    const ended = (await (await get(`runs/${rec}`)).json()) as RunDetail;
    expect(ended.calls.find((c) => c.callNo === 4)).toMatchObject({ outcome: 'error' });
    expect(ended.calls.some((c) => c.retryable)).toBe(false);
  });

  it('works out only the calls that arrived for a recording’s page, and the finished run whole', async () => {
    const b = RunBuilder.start(store, { startedAt: Date.now() - HOUR });
    for (let t = 1; t <= 30; t++) ticket(b, t);
    const first = (await (await get(`runs/${b.runId}`)).json()) as RunDetail;
    expect(first.calls).toHaveLength(180);
    expect(first.conversations).toHaveLength(30);

    const calls = vi.spyOn(store, 'getCalls');
    const json = vi.spyOn(store, 'getJson');
    const blobs = vi.spyOn(store, 'getBlob');
    const nos = ticket(b, 31);
    const part = (await (await get(`runs/${b.runId}?after=180`)).json()) as RunDetail;
    expect(part.calls.map((c) => c.callNo)).toEqual(nos);
    expect(part.calls.map((c) => c.conversation)).toEqual(new Array(6).fill(31));
    expect(part.calls.map((c) => c.requestedBy)).toEqual([null, null, nos[1], null, nos[3], null]);
    expect(part.conversations).toHaveLength(31);
    // The run's calls were read from the first new one on, and only the new ones' requests and answers.
    expect(calls.mock.calls.map(([, range]) => range)).toEqual([{ after: 180 }]);
    expect(json.mock.calls.length + blobs.mock.calls.length).toBeLessThan(60);
    calls.mockRestore();
    json.mockRestore();
    blobs.mockRestore();

    // Ended, the run is worked out whole, and every call is where the page had it.
    b.end();
    const ended = (await (await get(`runs/${b.runId}`)).json()) as RunDetail;
    expect(ended.calls.map((c) => [c.callNo, c.conversation, c.requestedBy])).toEqual([...first.calls, ...part.calls].map((c) => [c.callNo, c.conversation, c.requestedBy]));
  });

  it('gives the run’s family from the calls its page read, not by reading the run again', async () => {
    const done = addRun(store, { startedAt: Date.now() - HOUR, calls: 'lolo' });
    const fork = addRun(store, { parent: done, startedAt: Date.now(), calls: 'rrl', divergence: 3 });
    expect((await get(`runs/${done}`)).status).toBe(200);
    const reads = vi.spyOn(store, 'getCalls');
    const nodes = (await (await get(`runs/${done}/lineage`)).json()) as { nodes: Array<{ runId: string; calls: number }> };
    expect(nodes.nodes.map((n) => [n.runId, n.calls])).toEqual([
      [done, 4],
      [fork, 3],
    ]);
    // The fork is read; the run the page shows is not read again.
    expect(reads.mock.calls.map(([id]) => id)).toEqual([fork]);
    reads.mockRestore();
  });

  it('counts a recording’s call events in the live runs, so an answer moves its page too', () => {
    const rec = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/work' } }).runId;
    addCall(store, rec, 1, false);
    expect(liveRuns(store)).toEqual([{ runId: rec, calls: 1, events: 1 }]);
    answer(store, rec, 1);
    expect(liveRuns(store)).toEqual([{ runId: rec, calls: 1, events: 2 }]);
  });
});
