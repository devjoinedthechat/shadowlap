import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storeApiRequest, Store, type Effect, type Origin, type RunMeta } from '@shadowlap/engine';
import { comparePairOf } from '../src/compare.js';
import { forkDifferences, pairDifferences } from '../src/fork-differences.js';

/**
 * Compare's decisions for any two runs (fork-differences.ts `pairDifferences`, `pair` in `GET
 * /api/compare`): what the second decided differently from the first after the calls they share,
 * ranked as a fork against its parent is, with how each ended from the run index and a link to
 * each call. The engine's own cases are in packages/engine/test/pair-decisions.test.ts.
 */

type Call =
  | { kind: 'api'; text: string; tools?: Array<{ name: string; args?: Record<string, unknown> }> }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; effect: Effect; origin?: Origin };

let n = 0;
function addRun(store: Store, calls: Call[], o: { parent?: string; divergence?: number; meta?: RunMeta } = {}): string {
  const run = store.createRun({ mode: o.parent ? 'replay' : 'record', ...(o.parent ? { parentRunId: o.parent } : {}), command: { argv: ['node', 'agent.mjs'], cwd: '/work' }, codeVersion: null, startedAt: 1_000 + ++n * 100, ...(o.meta ? { meta: o.meta } : {}) });
  calls.forEach((c, i) => {
    const callNo = i + 1;
    const origin = c.kind === 'tool' && c.origin ? c.origin : o.parent && o.divergence && callNo < o.divergence ? 'replayed' : 'live';
    if (c.kind === 'api') {
      const uses = (c.tools ?? []).map((t, j) => ({ type: 'tool_use', id: `t${callNo}_${j}`, name: t.name, input: t.args ?? {} }));
      const response = { id: `msg_${callNo}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: c.text }, ...uses], stop_reason: uses.length ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } };
      const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `fp${callNo}`, occurrence: 1 };
      store.appendCallStart({ runId: run.runId, callNo, ...identity, origin, effect: null, requestRef: storeApiRequest(store, { model: 'claude-sonnet-5', messages: [{ role: 'user', content: `turn ${callNo}` }] }), meta: { provider: 'anthropic' }, at: 1 });
      store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson(response), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: 2 });
      return;
    }
    const identity = { kind: 'tool' as const, name: c.name, fingerprint: `tfp${callNo}${c.name}${JSON.stringify(c.args)}`, occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin, effect: c.effect, requestRef: store.putJson({ args: c.args }), meta: {}, at: 1 });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result: { ok: true } }), outcome: origin === 'blocked' ? 'error' : 'ok', meta: {}, at: 2 });
  });
  if (o.divergence) store.setDivergence(run.runId, { type: 'request_changed', callNo: o.divergence, kind: 'api', name: 'POST /v1/messages', replayedBefore: o.divergence - 1 });
  store.endRun(run.runId, 'completed', 5_000);
  return run.runId;
}

const LOOKUP: Call = { kind: 'tool', name: 'lookup_order', args: { order_id: 'A-1042' }, effect: 'read' };
const ASK_LOOKUP: Call = { kind: 'api', text: 'Looking it up.', tools: [{ name: 'lookup_order', args: { order_id: 'A-1042' } }] };
const refundCheck = (ok: boolean): RunMeta => ({ checks: [{ ok, label: 'issue_refund called 0 times', detail: ok ? null : 'it was called 1 time' }] });
const refund: Call[] = [{ kind: 'api', text: 'Issuing the refund.', tools: [{ name: 'issue_refund', args: { amount: 240 } }] }, { kind: 'tool', name: 'issue_refund', args: { amount: 240 }, effect: 'write' }, { kind: 'api', text: 'Refunded $240.' }];
const escalate: Call[] = [{ kind: 'api', text: 'Above the limit.', tools: [{ name: 'escalate', args: { reason: 'over $100' } }] }, { kind: 'tool', name: 'escalate', args: { reason: 'over $100' }, effect: 'write', origin: 'blocked' }, { kind: 'api', text: 'I have asked a manager.' }];

let store: Store;
const id: Record<string, string> = {};

beforeAll(() => {
  store = Store.open(':memory:');
  id.rec = addRun(store, [ASK_LOOKUP, LOOKUP, ...refund], { meta: refundCheck(false) });
  // Forked at the decision (#3): it escalates instead, its write blocked. Its check passes.
  id.fork = addRun(store, [ASK_LOOKUP, LOOKUP, ...escalate], { parent: id.rec, divergence: 3, meta: refundCheck(true) });
  // A second recording that escalates, with no link to the first.
  id.other = addRun(store, [ASK_LOOKUP, LOOKUP, ...escalate]);
  // Two recordings that differ only in a ticket's id, which a project's rule masks.
  id.t1 = addRun(store, [{ kind: 'tool', name: 'create_ticket', args: { id: 'T-1', subject: 'Refund' }, effect: 'write' }]);
  id.t2 = addRun(store, [{ kind: 'tool', name: 'create_ticket', args: { id: 'T-2', subject: 'Refund' }, effect: 'write' }]);
});
afterAll(() => store.close());

describe("Compare's decisions on any two runs", () => {
  it('ranks a fork against its parent as its fork differences rank it, a link to each side', () => {
    const fork = forkDifferences(store, id.fork)!;
    const pair = pairDifferences(store, store.getRun(id.rec)!, store.getRun(id.fork)!, 2)!;
    expect(pair.from).toEqual({ a: 3, b: 3 });
    expect(pair.rank).toBe(fork.rank);
    expect(pair.changes.map((c) => [c.rank, c.kind, c.tool])).toEqual(fork.changes.map((c) => [c.rank, c.kind, c.tool]));
    expect(pair.changes.find((c) => c.kind === 'write-added')).toMatchObject({ tool: 'escalate', a: null, b: { callNo: 4, href: `#/run/${id.fork}/4` } });
    expect(pair.ended).toEqual({ a: fork.ended.parent, b: fork.ended.fork });
    // Each side's writes are its ending's, by what became of them, and its rows': the pair keeps no list of its own.
    expect(pair).not.toHaveProperty('writes');
    expect(pair.verdict).toEqual({ words: 'Different writes', where: 'after #2', tone: 'err' });
    // How each side ended after the calls they share: the fenced write under its origin's word.
    expect(pair.endings.b).toEqual({ failures: null, writes: [{ fate: 'blocked', tools: [{ tool: 'escalate', count: 1 }] }], end: { kind: 'answered', callNo: 5 }, quit: false });
  });

  it('compares two runs with no parent link between them from the call after their identical prefix', () => {
    const c = comparePairOf(store, id.rec, id.other)!;
    expect(c.identicalPrefix).toBe(2);
    expect(c.pair).toMatchObject({ from: { a: 3, b: 3 }, rank: 1, verdict: { words: 'Different writes', where: 'after #2' }, more: 0 });
    // The checks came out otherwise too: the recording's failed, the other has none.
    expect(c.pair!.changes.map((x) => x.kind)).toContain('ended');
    expect(c.pair!.rows.map((r) => [r.n, r.alike, r.similar])).toEqual([
      [3, false, false],
      [4, false, false],
      [5, false, false],
    ]);
  });

  it("compares arguments after the project's matching rules, and gives no verdict to a run against itself", () => {
    expect(comparePairOf(store, id.t1, id.t2)!.pair).toMatchObject({ rank: 1, verdict: { words: 'Different writes', where: 'from #1' } });
    const masked = comparePairOf(store, id.t1, id.t2, [{ kind: 'tool', path: '$.args.id', replace: '<id>' }])!.pair!;
    expect(masked.verdict).toEqual({ words: 'The same decisions', where: 'from #1', tone: 'done' });
    expect(masked.rows[0]).toMatchObject({ alike: true, similar: false, a: { kind: 'tool', name: 'create_ticket' } });
    expect(masked.rows[0].a).not.toHaveProperty('args');
    expect(comparePairOf(store, id.rec, id.rec)!.pair).toMatchObject({ verdict: null, rows: [], more: 0 });
  });
});
