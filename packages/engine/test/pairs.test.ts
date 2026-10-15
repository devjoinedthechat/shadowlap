import { describe, expect, it } from 'vitest';
import { contextLine, countPairs, findPairs, pairRows } from '../src/pairs.js';
import { normalizeConversation } from '../src/conversation.js';
import { loadApiRequest } from '../src/manifest.js';
import { Store } from '../src/store.js';
import { DONE, ESCALATE, ESCALATE_2, LOOKUP, POLICY, REFUND, recordRun, type Step } from './training-fixtures.js';

/**
 * Preference pairs from attempts already in the store. The support agent's run turns on its third
 * model call (#5): refunding $240 loses it, escalating passes. Blame, verify and --repeat each leave
 * attempts that answered #5 one way or the other.
 */

const LOST = [LOOKUP, POLICY, REFUND, DONE];
const SAVED = [LOOKUP, POLICY, ESCALATE, DONE];

function blamed(store: Store) {
  const { run } = recordRun(store, LOST, { status: 'failed', meta: { labels: ['refund-bug'] } });
  store.updateRunMeta(run.runId, { blame: { at: 2_000, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: ['the agent exits 0', 'issue_refund called 0 times'], probes: [{ callNo: 5, passes: 4, attempts: 5, rescued: true }], spent: 0.02 } });
  const probe = (steps: Step[], passed: boolean) => recordRun(store, steps, { parentRunId: run.runId, status: 'completed', meta: { probe: { of: run.runId, callNo: 5, passed }, repeat: { group: 'b1-5', attempt: 1, of: 5 } } }).run;
  const attempts = [probe(SAVED, true), probe(SAVED, true), probe(LOST, true), probe([LOOKUP, POLICY, ESCALATE_2, DONE], true), probe(LOST, false)];
  return { run, attempts };
}

describe('pairs from blame', () => {
  it('pairs each passing answer at the blamed call with the recorded one, counting identical answers once', () => {
    const store = Store.open(':memory:');
    const { run, attempts } = blamed(store);
    const { pairs, sources } = findPairs(store);
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.confidence === 'high' && p.callNo === 5 && p.runId === run.runId && p.sourceKind === 'blame')).toBe(true);
    expect(pairs[0]).toMatchObject({
      rejected: { runId: run.runId, callNo: 5, what: 'the recording', text: '"Issuing the refund.", issue_refund({"order_id":"A-1042","amount":240})' },
      chosen: { runId: attempts[0]!.runId, callNo: 5, what: 'blame attempt, passed', text: '"Above the limit.", escalate({"reason":"refund of $240 is above $100"})' },
      model: 'claude-sonnet-5',
    });
    expect(pairs[1]!.chosen.text).toContain('above the refund limit');
    expect(pairs[0]!.id).toMatch(/^pr-[0-9a-f]{12}$/);
    expect(pairs[0]!.context).toBe('The customer asks for a refund on order A-1042. · read_policy returned {"text":"Refunds above $100 need a manager: escalate them."}');
    expect(sources).toEqual([
      expect.objectContaining({ key: `blame:${run.runId}`, kind: 'blame', label: 'blame · refund-bug', made: 2, attempts: 5, callNo: 5, confidence: 'high' }),
    ]);
    expect(sources[0]!.why).toBe('Probe #5 rescued the run: 3 attempts passed after a different answer at #5. One answered like another, so it counts once. 1 attempt that passed answered as the recording did.');
    // The same store read twice makes the same pairs.
    expect(findPairs(store).pairs.map((p) => p.id)).toEqual(pairs.map((p) => p.id));
    store.close();
  });

  it('lists a blame that made no pairs, and why', () => {
    const store = Store.open(':memory:');
    const { run } = recordRun(store, LOST, { status: 'failed' });
    store.updateRunMeta(run.runId, { blame: { at: 1, outcome: 'unrescuable', callNo: null, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
    const other = recordRun(store, LOST, { status: 'failed' }).run;
    store.updateRunMeta(other.runId, { blame: { at: 2, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: [], probes: [], spent: 0 } });
    const { pairs, sources } = findPairs(store);
    expect(pairs).toEqual([]);
    expect(sources.map((s) => [s.label.startsWith('blame · '), s.made, s.why])).toEqual([
      [true, 0, 'No attempt that passed at #5 is in the store any more.'],
      [true, 0, 'Not rescued from any model call: no answer made the run pass, so there is none to prefer.'],
    ]);
    store.close();
  });
});

describe('pairs from verify and --repeat', () => {
  it('pairs a failing attempt with a passing one at the first model call where their answers differ', () => {
    const store = Store.open(':memory:');
    const target = recordRun(store, LOST, { status: 'failed' }).run;
    const attempt = (steps: Step[], passed: boolean, n: number) => recordRun(store, steps, { parentRunId: target.runId, status: passed ? 'completed' : 'failed', codeVersion: '370712a+dirty', meta: { verify: { role: 'target', passed }, repeat: { group: `v1-${target.runId}`, attempt: n, of: 3 } } }).run;
    const failed = attempt(LOST, false, 1);
    const passed = attempt(SAVED, true, 2);
    // Parts from the failing attempt at its first call, where another attempt answered as the failing one did and passed.
    attempt([{ text: 'Let me check.', tools: LOOKUP.tools! }, POLICY, ESCALATE, DONE], true, 3);
    // A second verify where every attempt passed makes nothing.
    const good = recordRun(store, SAVED).run;
    recordRun(store, SAVED, { parentRunId: good.runId, codeVersion: 'b7e40c2', meta: { verify: { role: 'good', passed: true }, repeat: { group: `v2-${good.runId}`, attempt: 1, of: 1 } } });

    const { pairs, sources } = findPairs(store);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ confidence: 'medium', sourceKind: 'verify', runId: target.runId, callNo: 5, rejected: { runId: failed.runId, what: 'verify attempt, failed' }, chosen: { runId: passed.runId, what: 'verify attempt, passed' } });
    const verify = sources.filter((s) => s.kind === 'verify');
    expect(verify.map((s) => [s.label, s.made])).toEqual([
      ['verify · b7e40c2', 0],
      ['verify · 370712a+dirty', 1],
    ]);
    expect(verify[0]!.why).toBe('No run both passed and failed: each passed every attempt or none.');
    expect(verify[1]!.why).toContain(`Target ${target.runId.slice(0, 10)} failed 1 of 3.`);
    expect(verify[1]!.why).toContain('1 answer left out: the same answer, from the same point, also passed (or failed) elsewhere.');
    expect(countPairs(pairs)).toEqual({ all: 1, high: 0, medium: 1 });
    store.close();
  });

  it('pairs --repeat attempts by exit status, and leaves out those whose paths parted before their answers', () => {
    const store = Store.open(':memory:');
    const rec = recordRun(store, SAVED).run;
    const repeat = (group: string, steps: Step[], status: 'completed' | 'failed' | 'crashed', n: number, results?: (name: string, input: Record<string, unknown>) => unknown) =>
      recordRun(store, steps, { parentRunId: rec.runId, status, meta: { repeat: { group, attempt: n, of: 3 } }, ...(results ? { results } : {}) }).run;
    repeat('r1', SAVED, 'completed', 1);
    const lost = repeat('r1', LOST, 'failed', 2);
    repeat('r1', LOST, 'crashed', 3);
    repeat('r2', SAVED, 'completed', 1);
    repeat('r2', SAVED, 'completed', 2);
    repeat('r3', SAVED, 'completed', 1);
    repeat('r3', LOST, 'failed', 2, (name, input) => (name === 'lookup_order' ? { order_id: input.order_id, amount: 80 } : { text: 'Refunds above $100 need a manager: escalate them.' }));

    const { pairs, sources } = findPairs(store);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ confidence: 'medium', sourceKind: 'repeat', callNo: 5, rejected: { runId: lost.runId, what: 'attempt, exited with an error' }, chosen: { what: 'attempt, exited 0' } });
    const bySource = Object.fromEntries(sources.map((s) => [s.key, s]));
    expect(bySource['repeat:r1']).toMatchObject({ made: 1, label: `replay --repeat 3 · ${rec.runId.slice(0, 10)}`, attempts: 3 });
    expect(bySource['repeat:r2']).toMatchObject({ made: 0, why: 'All 2 attempts exited 0, so there is nothing to contrast.' });
    expect(bySource['repeat:r3']!.made).toBe(0);
    expect(bySource['repeat:r3']!.why).toContain('saw different conversations before their answers differed');
    store.close();
  });

  it('never takes blame, verify, test or scoring attempts for --repeat ones', () => {
    const store = Store.open(':memory:');
    const rec = recordRun(store, SAVED).run;
    recordRun(store, LOST, { parentRunId: rec.runId, status: 'failed', meta: { repeat: { group: 'x', attempt: 1, of: 2 }, task: { golden: 'goldens/a', model: 'm', takeover: 5, attempt: 1, of: 2, score: 0, session: 's' } } });
    recordRun(store, SAVED, { parentRunId: rec.runId, meta: { repeat: { group: 'x', attempt: 2, of: 2 }, task: { golden: 'goldens/a', model: 'm', takeover: 5, attempt: 2, of: 2, score: 1, session: 's' } } });
    expect(findPairs(store)).toEqual({ pairs: [], sources: [] });
    store.close();
  });
});

describe('context lines', () => {
  it('say what was asked and the last thing the model saw', () => {
    const turns = normalizeConversation({ system: 's', messages: [{ role: 'user', content: 'Summarize the Q3 filing.' }, { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'F-2291, 10-Q, filed 2026-09-29' }] }] })!.turns;
    expect(contextLine(turns)).toBe('Summarize the Q3 filing. · search returned F-2291, 10-Q, filed 2026-09-29');
    const chat = normalizeConversation({ system: 's', messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello' }, { role: 'user', content: 'Refund my order, please' }] })!.turns;
    expect(contextLine(chat)).toBe('Hi · then: Refund my order, please');
    expect(contextLine(normalizeConversation({ system: 's', messages: [{ role: 'user', content: 'x'.repeat(300) }] })!.turns)).toHaveLength(140);
  });
});

describe('pairs as training rows', () => {
  it('writes OpenAI preference and TRL rows with the conversation as the model saw it and the two answers', () => {
    const store = Store.open(':memory:');
    const { run } = blamed(store);
    const { pairs } = findPairs(store);
    const [row] = pairRows(store, pairs.slice(0, 1), { format: 'openai-preference' }) as Array<{ input: { messages: Array<Record<string, unknown>>; tools: unknown[] }; preferred_output: Array<Record<string, unknown>>; non_preferred_output: Array<Record<string, unknown>> }>;
    expect(row!.input.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
    expect(row!.input.messages[2]).toMatchObject({ role: 'assistant', content: 'Looking the order up.', tool_calls: [{ type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"A-1042"}' } }] });
    expect(row!.input.tools).toHaveLength(4);
    expect(row!.input.tools[0]).toEqual({ type: 'function', function: { name: 'lookup_order', description: 'Look an order up.', parameters: { type: 'object', properties: { order_id: { type: 'string' } } } } });
    expect(row!.preferred_output).toEqual([{ role: 'assistant', content: 'Above the limit.', tool_calls: [{ id: expect.stringMatching(/^toolu_/), type: 'function', function: { name: 'escalate', arguments: '{"reason":"refund of $240 is above $100"}' } }] }]);
    expect(row!.non_preferred_output[0]).toMatchObject({ role: 'assistant', content: 'Issuing the refund.' });

    const [trl] = pairRows(store, pairs.slice(0, 1), { format: 'trl' }) as Array<{ prompt: Array<Record<string, unknown>>; chosen: Array<Record<string, unknown>>; rejected: unknown[]; tools: unknown[] }>;
    expect(Object.keys(trl!)).toEqual(['prompt', 'chosen', 'rejected', 'tools']);
    expect(trl!.prompt[3]).toMatchObject({ role: 'tool', name: 'lookup_order' });
    expect(trl!.chosen[0]).toMatchObject({ tool_calls: [{ function: { name: 'escalate', arguments: { reason: 'refund of $240 is above $100' } } }] });
    expect(run.runId).toBeTruthy();
    store.close();
  });

  it('applies redaction: rules without a path everywhere, path rules to the message fields kept', () => {
    const store = Store.open(':memory:');
    blamed(store);
    const { pairs } = findPairs(store);
    const rules = [
      { pattern: 'email', replace: '<EMAIL>' },
      { kind: 'api' as const, path: '$.system', replace: '<SYSTEM>' },
      { kind: 'tool' as const, name: 'issue_refund', path: '$.args.order_id', replace: '<ORDER>' },
      { kind: 'tool' as const, name: 'lookup_order', path: '$.result.amount', replace: '<AMOUNT>' },
    ];
    const [row] = pairRows(store, pairs.slice(0, 1), { format: 'openai-preference', redact: rules }) as Array<{ input: { messages: Array<{ role: string; content: string; tool_calls?: Array<{ function: { arguments: string } }> }> }; non_preferred_output: Array<{ tool_calls: Array<{ function: { arguments: string } }> }> }>;
    const text = JSON.stringify(row);
    expect(text).not.toContain('dana@example.com');
    expect(text).toContain('<EMAIL>');
    expect(row!.input.messages[0]).toEqual({ role: 'system', content: '<SYSTEM>' });
    expect(row!.input.messages[3]!.content).toContain('"amount":"<AMOUNT>"');
    // The order id is masked where issue_refund is called, not where lookup_order is.
    expect(row!.non_preferred_output[0]!.tool_calls[0]!.function.arguments).toBe('{"order_id":"<ORDER>","amount":240}');
    expect(row!.input.messages[2]!.tool_calls![0]!.function.arguments).toBe('{"order_id":"A-1042"}');
    // The store is unchanged.
    const call = store.getCalls(pairs[0]!.rejected.runId).find((c) => c.callNo === 5)!;
    expect(JSON.stringify(loadApiRequest(store, call.requestRef!))).toContain('dana@example.com');
    store.close();
  });
});
