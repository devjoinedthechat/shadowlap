import { describe, expect, it } from 'vitest';
import { JUDGE_SCOPE, loadApiRequest, previewRedaction, redactRun, redactRunDetails, redactRunWithDetails, Store, storeApiRequest, type Normalizer } from '../src/index.js';

/**
 * A judge check in every copy of a run: its reason, a model's words about what it read, is masked
 * as the check's detail is, and counted by the preview; its own request takes only the rules
 * without a path, since a rule with a path names a place in the agent's requests.
 */

const CARD: Normalizer = { pattern: '/SECRET\\d+/', replace: '<CARD>' };
const SYSTEM: Normalizer = { path: '$.system', replace: '<SYSTEM>' };
const MESSAGE: Normalizer = { path: '$.messages[0].content', replace: '<MESSAGE>' };
const cmd = { argv: ['node', 'agent.js'], cwd: '/srv' };

/** A run with the agent's model call and its judge's, and the judge check as `shadowlap test` keeps it. */
function judgedRun(store: Store): string {
  const run = store.createRun({ mode: 'replay', command: cmd });
  const call = (callNo: number, body: Record<string, unknown>, answer: string, scope?: string) => {
    const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: String(callNo).repeat(64).slice(0, 64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta: { provider: 'anthropic', ...(scope ? { scope, judge: { check: 'card SECRET42', ask: 'abc' } } : {}) }, at: callNo });
    store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ type: 'message', role: 'assistant', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn' }), outcome: 'ok', meta: { status: 200 }, at: callNo });
  };
  call(1, { model: 'claude-sonnet-5', system: 'You refund orders.', messages: [{ role: 'user', content: 'Refund to card SECRET42.' }] }, 'Refunded to card SECRET42.');
  call(2, { model: 'claude-haiku-4-5', system: 'You judge.', messages: [{ role: 'user', content: 'Question: Does it name the card?\n\n<material>\nRefunded to card SECRET42.\n</material>' }] }, '{"verdict":"yes","reason":"it names SECRET42"}', JUDGE_SCOPE);
  store.endRun(run.runId, 'completed');
  store.updateRunMeta(run.runId, {
    checks: [
      {
        ok: true,
        status: 'passed',
        label: 'card SECRET42: the judge answers yes to "Does it name the card?"',
        detail: 'the judge answered yes: it names SECRET42',
        reason: 'it names SECRET42',
        judge: { name: 'card SECRET42', model: 'claude-haiku-4-5', of: 'answer', verdict: 'yes', source: 'live', cost: 0.001, redactions: 0, cut: 0, callNo: 2 },
      },
    ],
  });
  return run.runId;
}

describe("a judge check's reason in a copy of the run", () => {
  it('is masked in a pack and in a copy that is only read, as the label and the detail are, and counted by the preview', () => {
    const store = Store.open(':memory:');
    const runId = judgedRun(store);
    const pack = Store.open(':memory:');
    const copy = redactRun(store, runId, [CARD], pack);
    expect(copy.meta?.checks?.[0]).toMatchObject({ label: 'card <CARD>: the judge answers yes to "Does it name the card?"', detail: 'the judge answered yes: it names <CARD>', reason: 'it names <CARD>', judge: { name: 'card <CARD>', verdict: 'yes', callNo: 2 } });
    const html = Store.open(':memory:');
    redactRunWithDetails(store, runId, [CARD], html);
    expect(JSON.stringify(html.getRun(runId))).not.toContain('SECRET42');
    expect(JSON.stringify(redactRunDetails(store.getRun(runId)!, [CARD]).meta?.checks)).not.toContain('SECRET42');
    // Nothing of the run's own record keeps it, and the preview counts what the copy masked there.
    expect(JSON.stringify(pack.getRun(runId))).not.toContain('SECRET42');
    const counted = previewRedaction(store, runId, [CARD]).rules[0]!.count;
    // The same run with no reason or judge kept beside the check: two values fewer to mask.
    const { reason: _reason, judge: _judge, ...plain } = store.getRun(runId)!.meta!.checks![0]!;
    store.updateRunMeta(runId, { checks: [plain] });
    expect(counted).toBe(previewRedaction(store, runId, [CARD]).rules[0]!.count + 2);
    pack.close();
    html.close();
    store.close();
  });

  it("masks a judge's own request with the rules without a path only, and the preview counts what the copy changes", () => {
    const store = Store.open(':memory:');
    const runId = judgedRun(store);
    const pack = Store.open(':memory:');
    redactRun(store, runId, [CARD, SYSTEM, MESSAGE], pack);
    const [agent, judge] = pack.getCalls(runId);
    // The agent's request takes every rule; the judge's keeps its instructions and its question.
    expect(loadApiRequest(pack, agent!.requestRef!)).toMatchObject({ system: '<SYSTEM>', messages: [{ content: '<MESSAGE>' }] });
    expect(loadApiRequest(pack, judge!.requestRef!)).toEqual({ model: 'claude-haiku-4-5', system: 'You judge.', messages: [{ role: 'user', content: 'Question: Does it name the card?\n\n<material>\nRefunded to card <CARD>.\n</material>' }] });
    // The preview counts the path rules where they masked something: the agent's request alone.
    const p = previewRedaction(store, runId, [CARD, SYSTEM, MESSAGE]);
    expect(p.rules[1]!.count).toBe(1);
    expect(p.rules[2]!.count).toBe(1);
    expect(p.rules[1]!.samples).toEqual([{ before: 'You refund orders.', after: '<SYSTEM>' }]);
    pack.close();
    store.close();
  });
});
