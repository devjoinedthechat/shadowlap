import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeApiRequest, Store, type Effect, type Origin, type RunMeta } from '@shadowlap/engine';
import { forkDifferences } from '../src/fork-differences.js';
import { startDashboard, type Dashboard } from '../src/index.js';

/**
 * What a fork did differently from its parent: from where it left the parent on, the tool calls it
 * made and didn't, the ones it made with other arguments, how each run ended and its last words,
 * ranked as `shadowlap decisions` ranks a changed decision, and its writes with what became of each.
 */

type Call =
  | { kind: 'api'; text: string; tools?: string[]; origin?: Origin }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; effect: Effect; origin?: Origin; result?: unknown };

let n = 0;
function addRun(store: Store, calls: Call[], o: { parent?: string; divergence?: number; meta?: RunMeta; status?: 'completed' | 'failed' } = {}): string {
  const run = store.createRun({ mode: o.parent ? 'replay' : 'record', ...(o.parent ? { parentRunId: o.parent } : {}), command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: 1_000 + ++n * 100, ...(o.meta ? { meta: o.meta } : {}) });
  calls.forEach((c, i) => {
    const callNo = i + 1;
    const origin = c.origin ?? (o.parent && o.divergence && callNo < o.divergence ? 'replayed' : 'live');
    if (c.kind === 'api') {
      const content = [{ type: 'text', text: c.text }, ...(c.tools ?? []).map((t, j) => ({ type: 'tool_use', id: `t${callNo}_${j}`, name: t, input: {} }))];
      const response = { id: `msg_${n}_${callNo}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content, stop_reason: c.tools?.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
      const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `fp${callNo}`, occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo, ...identity, origin, effect: null, requestRef: storeApiRequest(store, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: `turn ${callNo}` }] }), meta: { provider: 'anthropic' }, at: 1 });
      store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson(response), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: 2 });
      return;
    }
    const identity = { kind: 'tool' as const, name: c.name, fingerprint: `tfp${callNo}${c.name}`, occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin, effect: c.effect, requestRef: store.putJson({ args: c.args }), meta: {}, at: 1 });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result: c.result ?? { ok: true } }), outcome: origin === 'blocked' ? 'error' : 'ok', meta: {}, at: 2 });
  });
  if (o.divergence) store.setDivergence(run.runId, { type: 'request_changed', callNo: o.divergence, kind: 'api', name: 'POST /v1/messages', replayedBefore: o.divergence - 1 });
  store.endRun(run.runId, o.status ?? 'completed', 5_000);
  return run.runId;
}

const LOOKUP: Call = { kind: 'tool', name: 'lookup_order', args: { order_id: 'A-1042' }, effect: 'read' };
const POLICY: Call = { kind: 'tool', name: 'read_policy', args: {}, effect: 'pure' };
const refundCheck = (ok: boolean): RunMeta => ({ checks: [{ ok, label: 'issue_refund called 0 times', detail: ok ? null : 'it was called 1 time' }] });

let store: Store;
const id: Record<string, string> = {};

beforeAll(() => {
  store = Store.open(':memory:');
  // The recording: it looks the order up, reads the policy, refunds $240 and says so. Its check fails.
  id.rec = addRun(store, [{ kind: 'api', text: 'Looking it up.', tools: ['lookup_order'] }, LOOKUP, { kind: 'api', text: '', tools: ['read_policy'] }, POLICY, { kind: 'api', text: 'Issuing the refund.', tools: ['issue_refund'] }, { kind: 'tool', name: 'issue_refund', args: { order_id: 'A-1042', amount: 240 }, effect: 'write' }, { kind: 'api', text: 'Refunded $240.' }], { meta: refundCheck(false) });
  // Forked at the decision (#5): it escalates instead, its write fenced, looks the order up again
  // with another field, and says something else. Its check passes.
  id.fork = addRun(
    store,
    [
      { kind: 'api', text: 'Looking it up.', tools: ['lookup_order'] },
      LOOKUP,
      { kind: 'api', text: '', tools: ['read_policy'] },
      POLICY,
      { kind: 'api', text: 'Above the limit.', tools: ['escalate', 'lookup_order'] },
      { kind: 'tool', name: 'escalate', args: { reason: 'refund of $240 is above $100' }, effect: 'write', origin: 'blocked' },
      { kind: 'tool', name: 'lookup_order', args: { order_id: 'A-1042', fields: ['email'] }, effect: 'read' },
      { kind: 'api', text: 'I have asked a manager to approve it.' },
    ],
    { parent: id.rec, divergence: 5, meta: refundCheck(true) },
  );
  id.clean = addRun(store, [{ kind: 'api', text: 'Refunded $240.' }], { parent: id.rec });
});
afterAll(() => store.close());

describe('what a fork did differently', () => {
  it('ranks a write first, then how the run ended, then reads, then its words, as decisions ranks them', () => {
    const d = forkDifferences(store, id.fork!)!;
    expect(d).toMatchObject({ runId: id.fork, parentRunId: id.rec, from: 5, rank: 1, toolCalls: { parent: 1, fork: 2 }, cut: false });
    expect(d.changes.map((c) => [c.rank, c.kind, c.tool])).toEqual([
      [1, 'write-removed', 'issue_refund'],
      [1, 'write-added', 'escalate'],
      [2, 'ended', null],
      [3, 'read-added', 'lookup_order'],
      [5, 'text', null],
    ]);
    const [removed, added, ended, read, words] = d.changes;
    expect(removed).toMatchObject({ detail: 'issue_refund is no longer called', before: '{"order_id":"A-1042","amount":240}', after: null, parent: { callNo: 6, href: `#/run/${id.rec}/6` }, fork: null });
    expect(added).toMatchObject({ detail: 'escalate is called', after: '{"reason":"refund of $240 is above $100"}', fork: { callNo: 6, href: `#/run/${id.fork}/6` } });
    expect(ended).toMatchObject({ detail: 'it does not fail, where its parent did', before: 'failed: issue_refund called 0 times', after: '1 check passed' });
    expect(read).toMatchObject({ detail: 'lookup_order is called', fork: { callNo: 7 } });
    expect(words).toMatchObject({ detail: 'it says something else', before: '"Refunded $240."', after: '"I have asked a manager to approve it."' });
    expect(d.ended).toEqual({ parent: { status: 'completed', failed: true, words: 'failed: issue_refund called 0 times', tone: 'err' }, fork: { status: 'completed', failed: false, words: '1 check passed', tone: 'ok' } });
  });

  it('lists the fork’s writes from where it left its parent, with what became of each', () => {
    expect(forkDifferences(store, id.fork!)!.writes).toEqual([{ callNo: 6, tool: 'escalate', args: '{"reason":"refund of $240 is above $100"}', fate: 'blocked', href: `#/run/${id.fork}/6` }]);
  });

  it('counts what a normalizer masks as no change', () => {
    const rec = addRun(store, [{ kind: 'api', text: 'Sending.', tools: ['notify'] }, { kind: 'tool', name: 'notify', args: { ref: '3f2b8a1e-6c4d-4b7a-9f10-2a3b4c5d6e7f' }, effect: 'write' }, { kind: 'api', text: 'Sent.' }]);
    const fork = addRun(store, [{ kind: 'api', text: 'Sending.', tools: ['notify'] }, { kind: 'tool', name: 'notify', args: { ref: '8a7b6c5d-4e3f-4a1b-8c9d-0e1f2a3b4c5d' }, effect: 'write' }, { kind: 'api', text: 'Sent.' }], { parent: rec, divergence: 1 });
    expect(forkDifferences(store, fork)!.changes.map((c) => c.kind)).toEqual(['write-arguments']);
    const masked = forkDifferences(store, fork, { normalizers: [{ pattern: 'uuid', replace: '<UUID>' }] })!;
    expect(masked.changes).toEqual([]);
    expect(masked.rank).toBeNull();
  });

  it('has nothing to say of a run that is no fork of a run in the store', () => {
    expect(forkDifferences(store, id.rec!)).toBeNull();
    expect(forkDifferences(store, id.clean!)).toBeNull();
    expect(forkDifferences(store, '01NOSUCHRUN000000000000000')).toBeNull();
  });
});

describe('GET /api/runs/:id/differences', () => {
  let dash: Dashboard;
  beforeAll(async () => {
    dash = await startDashboard({ store });
  });
  afterAll(async () => {
    await dash.close();
  });
  const get = (path: string) => fetch(`${dash.url}/api/${path}`, { headers: { 'x-shadowlap-token': dash.token } });

  it('answers a fork with what it did differently, and any other run with nothing', async () => {
    const fork = await get(`runs/${id.fork}/differences`);
    expect(fork.status).toBe(200);
    expect(((await fork.json()) as { differences: { rank: number } }).differences.rank).toBe(1);
    expect(await (await get(`runs/${id.rec}/differences`)).json()).toEqual({ differences: null });
    expect((await get('runs/01NOSUCHRUN000000000000000/differences')).status).toBe(404);
  });
});
