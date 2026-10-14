import { describe, expect, it } from 'vitest';
import { describeInterventions, inferInterventions, recordNotRecorded, runInterventions, showJson, Store, summarizeRun, toolResultLine, unrecordedTools, type CallRecord } from '../src/index.js';
import { RunBuilder, text, toolUse, user } from './run-fixtures.js';

describe('a replay’s interventions', () => {
  it('names each flag a replay ran with, leaving the defaults out', () => {
    expect(
      describeInterventions(
        { failAt: new Map([[19, 529]]), overrides: new Map([[16, { region: 'EU', refund_limit: 100 }]]), divergeAt: 7, promptFrom: 15, liveTools: new Set(['search_web']), writes: 'stub', reads: 'live' },
        { inject: { atCall: 15, text: 'Prefer sources from 2026', as: 'user' }, set: { fromCall: 15, fields: { model: 'claude-opus-5', max_tokens: 2048 } } },
      ),
    ).toEqual([
      { flag: '--fail-at', value: '19=529', callNo: 19 },
      { flag: '--override', value: '16={"region":"EU","refund_limit":100}', callNo: 16 },
      { flag: '--inject', value: '15=Prefer sources from 2026', callNo: 15 },
      { flag: '--inject-as', value: 'user', callNo: null },
      { flag: '--model', value: '15:claude-opus-5', callNo: 15 },
      { flag: '--set', value: '15:max_tokens=2048', callNo: 15 },
      { flag: '--prompt-from', value: '15', callNo: 15 },
      { flag: '--diverge-at', value: '7', callNo: 7 },
      { flag: '--live-tool', value: 'search_web', callNo: null },
      { flag: '--writes', value: 'stub', callNo: null },
    ]);
    expect(describeInterventions({ writes: 'block', reads: 'live', liveTools: new Set() })).toEqual([]);
    expect(describeInterventions(undefined)).toEqual([]);
    // A long value is cut to one line.
    const long = describeInterventions({ overrides: new Map([[3, 'x'.repeat(500)]]) })[0]!.value!;
    expect(long.length).toBe(200);
    expect(long.endsWith('…')).toBe(true);
  });

  it('reads them back from a replay stored before they were kept', () => {
    const store = Store.open(':memory:');
    const rec = RunBuilder.start(store);
    for (let i = 0; i < 4; i++) rec.model({ messages: [user(`q${i}`)] }, [text('a')]);
    rec.end();
    const fork = RunBuilder.start(store, { parent: rec.runId });
    fork.model({ messages: [user('q0')] }, [text('a')], { origin: 'replayed', replayedFrom: 1 });
    fork.model({ messages: [user('q1')] }, null, { injected: true, status: 529 });
    fork.tool('add_note', { note: 'down' }, { stubbed: true }, { origin: 'stubbed', effect: 'write' });
    fork.end();
    store.setDivergence(fork.runId, { type: 'forced', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 1, reason: "forced live by --fail-at 2=529: answered with HTTP 529 instead of the recording, so the agent's error path runs" });
    const run = store.getRun(fork.runId)!;
    expect(inferInterventions(store, run, store.getCalls(run.runId))).toEqual([
      { flag: '--fail-at', value: '2=529', callNo: 2 },
      { flag: '--writes', value: 'stub', callNo: null },
    ]);

    const over = RunBuilder.start(store, { parent: rec.runId });
    over.tool('lookup_policy', { region: 'EU' }, { region: 'EU', refund_limit: 100 }, { origin: 'overridden' });
    over.end();
    store.setDivergence(over.runId, { type: 'forced', callNo: 1, kind: 'tool', name: 'search', replayedBefore: 0, reason: 'forced live by --live-tool search' });
    expect(inferInterventions(store, store.getRun(over.runId)!, store.getCalls(over.runId))).toEqual([
      { flag: '--override', value: '1={"region":"EU","refund_limit":100}', callNo: 1 },
      { flag: '--live-tool', value: 'search', callNo: null },
    ]);
    // Once stored, the stored list is the answer.
    store.updateRunMeta(over.runId, { interventions: [{ flag: '--override', value: '1=@policy.json', callNo: 1 }] });
    expect(runInterventions(store, store.getRun(over.runId)!, [])).toEqual([{ flag: '--override', value: '1=@policy.json', callNo: 1 }]);
    // A recording has none.
    expect(inferInterventions(store, store.getRun(rec.runId)!, store.getCalls(rec.runId))).toEqual([]);
    store.close();
  });
});

describe('a tool’s result in a line', () => {
  const store = Store.open(':memory:');
  const b = RunBuilder.start(store);
  const ok = b.tool('lookup_order', { id: 1 }, { order_id: 'A-1042', amount: 240, currency: 'USD', status: 'delivered', delivered: '2026-09-27', note: 'left at the door' });
  const stub = b.tool('send_email', { to: 'x' }, { stubbed: true }, { origin: 'stubbed', effect: 'write' });
  const blocked = b.tool('issue_refund', { amount: 240 }, null, { origin: 'blocked', effect: 'write' });
  const failed = b.tool('search', { q: 'x' }, null, { error: 'timeout after 30s' });
  const http = b.tool('GET api.example.com/v1/orders', { url: 'https://api.example.com/v1/orders' }, { status: 200, headers: {}, body: { orders: [1, 2] }, encoding: 'json' }, { meta: { http: 'api.example.com' } });
  b.model({ messages: [user('x')] }, [toolUse('t', {}, 'toolu_1')]);
  b.end();
  const calls = store.getCalls(b.runId);
  const line = (n: number) => {
    const c = calls.find((x) => x.callNo === n)!;
    return toolResultLine(c, c.end?.responseRef ? store.getJson(c.end.responseRef) : null);
  };

  it('shortens to about 72 characters, and says what happened to a fenced write', () => {
    expect(line(ok)).toBe('{"order_id":"A-1042","amount":240,"currency":"USD","status":"delivered"…');
    expect(line(ok)!.length).toBe(72);
    expect(line(stub)).toBe('stubbed {"stubbed":true}');
    expect(line(blocked)).toBe('blocked');
    expect(line(failed)).toBe('error: timeout after 30s');
    expect(line(http)).toBe('HTTP 200 {"orders":[1,2]}');
    expect(line(6)).toBeNull();
  });

  it('is null for a tool still running', () => {
    const running = { ...(calls.find((c) => c.callNo === ok) as CallRecord), end: null };
    expect(toolResultLine(running, null)).toBeNull();
  });
});

describe('what a run did unrecorded', () => {
  it('keeps the guard’s hosts and the tools without an effect the run never recorded', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.tool('search_web', { q: 'x' }, []);
    b.end();
    const tools = unrecordedTools(
      [
        { name: 'search_web', effect: null },
        { name: 'send_slack', effect: null },
        { name: 'send_slack', effect: null },
        { name: 'issue_refund', effect: 'write' },
        { name: 'fetch_weather', effect: null },
      ],
      store.getCalls(b.runId),
    );
    expect(tools).toEqual(['fetch_weather', 'send_slack']);
    recordNotRecorded(store, b.runId, { hosts: [{ target: 'api.stripe.com:443', count: 2, action: 'warned' }] });
    recordNotRecorded(store, b.runId, { tools });
    expect(store.getRun(b.runId)!.meta?.notRecorded).toEqual({ hosts: [{ target: 'api.stripe.com:443', count: 2, action: 'warned' }], tools: ['fetch_weather', 'send_slack'] });
    // Nothing to say leaves the run as it was.
    const clean = RunBuilder.start(store).end();
    recordNotRecorded(store, clean, { hosts: [], tools: [] });
    expect(store.getRun(clean)!.meta?.notRecorded).toBeUndefined();
    store.close();
  });
});

describe('show --json', () => {
  it('is the run, its summary and its calls as stored', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('x')] }, [text('y')]);
    b.end();
    const run = store.getRun(b.runId)!;
    const out = showJson(store, run);
    expect(Object.keys(out)).toEqual(['run', 'summary', 'calls']);
    expect(out.calls).toEqual(store.getCalls(b.runId));
    expect(out.summary).toEqual(summarizeRun(run, store.getCalls(b.runId), [], [], {}));
    store.close();
  });
});
