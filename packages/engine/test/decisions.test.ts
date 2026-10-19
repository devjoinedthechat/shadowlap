import { describe, expect, it } from 'vitest';
import { compareDecisions, decisionOf, decisionOfResponse, effectsOf, formatDecisions, isHandover, type DecisionsReport, type EffectOf, type ModelDecision } from '../src/decisions.js';
import type { Effect } from '../src/types.js';

/**
 * The decision in an answer, read the same way for every provider, and how two decisions differ,
 * ranked by consequence with the run's effects.
 */

const json = (v: unknown) => Buffer.from(JSON.stringify(v));
const sse = (events: Array<[string | null, unknown]>) => Buffer.from(events.map(([e, d]) => `${e ? `event: ${e}\n` : ''}data: ${JSON.stringify(d)}\n\n`).join(''));

describe('decisionOf, per provider', () => {
  it('reads an Anthropic answer, as JSON and streamed', () => {
    const body = { content: [{ type: 'text', text: 'Sending.' }, { type: 'tool_use', id: 'toolu_1', name: 'send_email', input: { to: 'a@b.c' } }], stop_reason: 'tool_use' };
    const d = decisionOfResponse(json(body), 'application/json', 'anthropic');
    expect(d).toEqual({ stop: 'tools', stopReason: 'tool_use', tools: [{ name: 'send_email', args: { to: 'a@b.c' } }], text: 'Sending.', handover: null });

    const streamed = sse([
      ['message_start', { type: 'message_start', message: { content: [], usage: { input_tokens: 10, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }],
    ]);
    expect(decisionOfResponse(streamed, 'text/event-stream', 'anthropic')).toMatchObject({ stop: 'answer', stopReason: 'end_turn', tools: [], text: 'Done.' });
    expect(decisionOfResponse(json({ content: [{ type: 'text', text: 'Part' }], stop_reason: 'max_tokens' }), 'application/json', 'anthropic').stop).toBe('limit');
    expect(decisionOfResponse(json({ content: [], stop_reason: 'refusal' }), 'application/json', 'anthropic').stop).toBe('refused');
  });

  it('reads OpenAI Chat Completions, whose arguments arrive as JSON text', () => {
    const body = { choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"A-1042"}' } }] }, finish_reason: 'tool_calls' }] };
    expect(decisionOfResponse(json(body), 'application/json', 'openai')).toMatchObject({ stop: 'tools', tools: [{ name: 'lookup_order', args: { order_id: 'A-1042' } }] });
    const answer = { choices: [{ message: { content: 'Refunded.' }, finish_reason: 'stop' }] };
    expect(decisionOfResponse(json(answer), 'application/json', 'openai')).toMatchObject({ stop: 'answer', text: 'Refunded.' });
    expect(decisionOfResponse(json({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }), 'application/json', 'openai').stop).toBe('limit');
  });

  it('reads the Responses API: a completed answer with a function call is a tool turn', () => {
    const body = { status: 'completed', output: [{ type: 'function_call', name: 'search_web', arguments: '{"query":"refunds"}', call_id: 'c1' }] };
    expect(decisionOfResponse(json(body), 'application/json', 'openai')).toMatchObject({ stop: 'tools', tools: [{ name: 'search_web', args: { query: 'refunds' } }] });
    const said = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'All done.' }] }] };
    expect(decisionOfResponse(json(said), 'application/json', 'openai')).toMatchObject({ stop: 'answer', text: 'All done.' });
  });

  it('reads Gemini: a STOP with a function call is a tool turn', () => {
    const body = { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'escalate', args: { reason: 'over limit' } } }] }, finishReason: 'STOP' }] };
    expect(decisionOfResponse(json(body), 'application/json', 'gemini')).toMatchObject({ stop: 'tools', stopReason: 'STOP', tools: [{ name: 'escalate', args: { reason: 'over limit' } }] });
    expect(decisionOfResponse(json({ candidates: [{ content: { parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }] }), 'application/json', 'gemini').stop).toBe('answer');
    expect(decisionOfResponse(json({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] }), 'application/json', 'gemini').stop).toBe('refused');
  });

  it('reads Bedrock Converse', () => {
    const body = { output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'issue_refund', input: { amount: 240 } } }] } }, stopReason: 'tool_use' };
    expect(decisionOfResponse(json(body), 'application/json', 'bedrock')).toMatchObject({ stop: 'tools', tools: [{ name: 'issue_refund', args: { amount: 240 } }] });
    expect(decisionOfResponse(json({ output: { message: { content: [{ text: 'No.' }] } }, stopReason: 'guardrail_intervened' }), 'application/json', 'bedrock').stop).toBe('refused');
  });

  it("compares arguments and text after the project's normalizers and the clock", () => {
    const at = Date.parse('2026-10-19T10:00:00Z');
    const said = (id: string, when: string): ModelDecision =>
      decisionOf(
        { blocks: [{ type: 'text', text: `Ticket ${id} filed  at ${when}.` }, { type: 'tool_call', name: 'open_ticket', input: { request: id, at: when } }], stopReason: 'tool_use' },
        { normalizers: [{ kind: 'tool', name: 'open_ticket', path: '$.args.request', replace: '<id>' }, { pattern: '/req_\\w+/', replace: '<req>' }], clock: at },
      );
    const a = said('req_1', '2026-10-19T09:58:00Z');
    const b = said('req_2', '2026-10-19T10:01:00Z');
    expect(a.tools).toEqual(b.tools);
    expect(a.text).toBe(b.text);
    expect(a.text).toBe('Ticket <req> filed at <datetime>.');
  });

  it('names a handover by the tool it hands over with', () => {
    expect(isHandover('transfer_to_billing')).toBe(true);
    expect(isHandover('handoff')).toBe(true);
    expect(isHandover('escalate')).toBe(false);
    expect(decisionOf({ blocks: [{ type: 'tool_call', name: 'transfer_to_billing', input: {} }], stopReason: 'tool_use' }).handover).toBe('transfer_to_billing');
  });
});

const decision = (tools: Array<[string, unknown]>, o: { stop?: ModelDecision['stop']; text?: string } = {}): ModelDecision => ({
  stop: o.stop ?? (tools.length ? 'tools' : 'answer'),
  stopReason: null,
  tools: tools.map(([name, args]) => ({ name, args })),
  text: o.text ?? '',
  handover: tools.map(([n]) => n).find(isHandover) ?? null,
});
const effects: Record<string, Effect> = { send_email: 'write', issue_refund: 'write', escalate: 'write', search_web: 'read', lookup_policy: 'read', read_file: 'pure' };
const effectOf: EffectOf = (t) => effects[t] ?? null;

describe('compareDecisions: ranked by consequence', () => {
  it('ranks 1: a write added, removed or called with other arguments', () => {
    const refund = decision([['issue_refund', { amount: 240 }]]);
    const escalated = compareDecisions(refund, decision([['escalate', {}]]), effectOf);
    expect(escalated.rank).toBe(1);
    expect(escalated.changes.map((c) => c.kind)).toEqual(['write-removed', 'write-added']);
    expect(escalated.changes[0]).toMatchObject({ tool: 'issue_refund', effect: 'write', before: { amount: 240 }, after: null, detail: 'issue_refund is no longer called' });

    const less = compareDecisions(refund, decision([['issue_refund', { amount: 100 }]]), effectOf);
    expect(less).toMatchObject({ rank: 1, changes: [{ kind: 'write-arguments', before: { amount: 240 }, after: { amount: 100 } }] });

    const order = compareDecisions(decision([['send_email', { to: 'a' }], ['issue_refund', { amount: 1 }]]), decision([['issue_refund', { amount: 1 }], ['send_email', { to: 'a' }]]), effectOf);
    expect(order).toMatchObject({ rank: 1, changes: [{ kind: 'write-order', before: ['send_email', 'issue_refund'], after: ['issue_refund', 'send_email'] }] });
  });

  it('ranks a tool no recording gives an effect as a write', () => {
    const c = compareDecisions(decision([['search_web', { query: 'x' }]]), decision([['search_web', { query: 'x' }], ['post_to_slack', { text: 'hi' }]]), effectOf);
    expect(c.rank).toBe(1);
    expect(c.changes[0]).toMatchObject({ kind: 'write-added', tool: 'post_to_slack', effect: 'unknown' });
    expect(c.changes[0]!.detail).toMatch(/no recording gives an effect, so it counts as a write/);
  });

  it('ranks 2: when it stops or hands over; stopping instead of emailing is a write removed first', () => {
    const stops = compareDecisions(decision([['search_web', { query: 'x' }]]), decision([], { text: 'Here is what I found.' }), effectOf);
    expect(stops.rank).toBe(2);
    expect(stops.changes.map((c) => [c.rank, c.kind])).toEqual([
      [2, 'stops'],
      [3, 'read-removed'],
      [5, 'text'],
    ]);
    const email = compareDecisions(decision([['send_email', { to: 'team@example.com' }]], { text: 'Sending the summary.' }), decision([], { text: 'Not emailing.' }), effectOf);
    expect(email.rank).toBe(1);
    expect(email.changes.map((c) => c.kind)).toEqual(['write-removed', 'stops', 'text']);

    const handover = compareDecisions(decision([['transfer_to_billing', {}]]), decision([['transfer_to_support', {}]]), effectOf);
    expect(handover).toMatchObject({ rank: 2, changes: [{ kind: 'handover', before: 'transfer_to_billing', after: 'transfer_to_support' }] });
  });

  it('ranks 3 for a read added or removed, 4 for a read asked differently, and ignores the order of reads', () => {
    const removed = compareDecisions(decision([['search_web', { query: 'a' }], ['lookup_policy', {}]]), decision([['search_web', { query: 'a' }]]), effectOf);
    expect(removed).toMatchObject({ rank: 3, changes: [{ kind: 'read-removed', tool: 'lookup_policy' }] });
    const asked = compareDecisions(decision([['search_web', { query: 'refund policy' }]]), decision([['search_web', { query: 'refunds' }]]), effectOf);
    expect(asked).toMatchObject({ rank: 4, changes: [{ kind: 'read-arguments', before: { query: 'refund policy' }, after: { query: 'refunds' } }] });
    const reordered = compareDecisions(decision([['read_file', { path: 'a' }], ['search_web', { query: 'b' }]]), decision([['search_web', { query: 'b' }], ['read_file', { path: 'a' }]]), effectOf);
    expect(reordered).toEqual({ rank: null, changes: [] });
  });

  it('ranks 5 for text only, and null for the same decision', () => {
    expect(compareDecisions(decision([], { text: 'Done.' }), decision([], { text: 'All done.' }), effectOf)).toMatchObject({ rank: 5, changes: [{ kind: 'text', before: 'Done.', after: 'All done.' }] });
    expect(compareDecisions(decision([['send_email', { to: 'a' }]], { text: 'x' }), decision([['send_email', { to: 'a' }]], { text: 'x' }), effectOf)).toEqual({ rank: null, changes: [] });
  });

  it("takes each tool's effect from a run's calls, the most consequential when they disagree", () => {
    const calls = [
      { kind: 'tool' as const, name: 'fetch', effect: 'read' as const },
      { kind: 'tool' as const, name: 'fetch', effect: 'write' as const },
      { kind: 'tool' as const, name: 'read_file', effect: 'pure' as const },
      { kind: 'api' as const, name: 'POST /v1/messages', effect: null },
    ];
    expect(Object.fromEntries(effectsOf(calls))).toEqual({ fetch: 'write', read_file: 'pure' });
  });
});

describe('formatDecisions', () => {
  it("says what changed in rank order, with the recorded and the new action, and that later steps are judged in the recorded run's state", () => {
    const step = (callNo: number, rank: 1 | 3 | null, detail: string) => ({
      callNo,
      step: callNo,
      scope: null,
      rank,
      changes: rank ? [{ rank, kind: 'write-removed' as const, tool: 'send_email', effect: 'write' as const, before: { to: 'team@example.com' }, after: null, detail }] : [],
      recorded: { stop: 'tools' as const, stopReason: 'tool_use', tools: [{ name: 'send_email', args: { to: 'team@example.com' }, effect: 'write' as const }], text: '' },
      now: { stop: 'answer' as const, stopReason: 'end_turn', tools: [], text: 'Not emailing.' },
      samples: { asked: 1, answered: 1, changed: rank ? 1 : 0, ranks: [rank ?? 0] },
      model: { recorded: 'claude-opus-5', asked: 'claude-opus-5' },
      tokens: { before: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, after: { input: 90, output: 10, cacheRead: 0, cacheWrite: 0 } },
      cost: { before: 0.001, after: 0.0009 },
      thinkingStripped: 0,
      error: null,
    });
    const report: DecisionsReport = {
      decisionsId: 'dc-01K00000000000000000000000',
      kind: 'decisions',
      at: 0,
      change: { model: null, fields: {}, fromCode: null, text: 'the prompt and tools in the working tree' },
      command: 'shadowlap decisions 01K1 --from-code',
      samples: 1,
      runs: [{ runId: '01K1AAAAAAAAAAAAAAAAAAAAAA', golden: null, steps: 2, asked: 2, rank: 1, counts: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, same: 1, untouched: 0, notAsked: 0 }, cost: { before: 0.002, after: 0.0018 }, tokens: { before: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }, after: { input: 180, output: 20, cacheRead: 0, cacheWrite: 0 } }, thinkingStripped: 0, refused: null, decisions: [step(10, 1, 'send_email is no longer called'), step(3, null, '')], warnings: [] }],
      counts: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, same: 1, untouched: 0, notAsked: 0 },
      flagged: ['01K1AAAAAAAAAAAAAAAAAAAAAA'],
      cost: { before: 0.002, after: 0.0018, spent: 0.0018, upstreamRequests: 2, unknownModels: [] },
      tokens: { before: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }, after: { input: 180, output: 20, cacheRead: 0, cacheWrite: 0 } },
      retirements: [],
      notes: ["Later steps are judged in the recorded run's state."],
      warnings: [],
      verify: null,
      remedies: [],
      stopReason: null,
    };
    const text = formatDecisions(report);
    expect(text).toContain('1 of 1 run decide a write or when to stop differently, under the prompt and tools in the working tree');
    expect(text).toMatch(/#10 +step 10 +rank 1 +send_email is no longer called/);
    expect(text).toContain('recorded send_email({"to":"team@example.com"})');
    expect(text).toContain('now      answers and stops: "Not emailing."');
    expect(text).toContain("Later steps are judged in the recorded run's state.");
    expect(text).not.toContain('#3 ');
  });
});
