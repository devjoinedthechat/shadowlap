import { describe, expect, it } from 'vitest';
import { compareDecisions, decisionOf, decisionOfResponse, decisionView, effectsOf, estimatedTokens, formatDecisions, hostedToolEffect, isHandover, isReservedScope, majorityRank, modelFamily, sameModel, type DecisionsReport, type EffectOf, type ModelDecision } from '../src/decisions.js';
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

  it("reads the tools a provider runs itself, with what each does: Anthropic's server tools and MCP connector, the Responses API's built-in tools", () => {
    const anthropic = { content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'refund policy' } }, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [] }, { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'create_ticket', server_name: 'desk', input: { title: 'x' } }], stop_reason: 'end_turn' };
    expect(decisionOfResponse(json(anthropic), 'application/json', 'anthropic').tools).toEqual([
      { name: 'web_search', args: { query: 'refund policy' }, effect: 'read' },
      // An MCP server's tool says nothing by its name: the runs and the config tell, else it is a write.
      { name: 'create_ticket', args: { title: 'x' } },
    ]);
    const streamed = sse([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"url":"https://example.com"}' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
    ]);
    expect(decisionOfResponse(streamed, 'text/event-stream', 'anthropic').tools).toEqual([{ name: 'web_fetch', args: { url: 'https://example.com' }, effect: 'read' }]);

    const responses = {
      status: 'completed',
      output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'refunds' } },
        { type: 'file_search_call', id: 'fs_1', queries: ['policy'], status: 'completed' },
        { type: 'computer_call', id: 'cu_1', call_id: 'call_1', action: { type: 'click', x: 10, y: 20, button: 'left' }, status: 'completed' },
        { type: 'computer_call', id: 'cu_2', call_id: 'call_2', action: { type: 'screenshot' }, status: 'completed' },
        { type: 'image_generation_call', id: 'ig_1', result: 'aGVsbG8=', status: 'completed' },
        { type: 'mcp_call', id: 'mcp_1', server_label: 'desk', name: 'close_ticket', arguments: '{"id":7}' },
        { type: 'custom_tool_call', call_id: 'ct_1', name: 'run_sql', input: 'SELECT 1' },
      ],
    };
    expect(decisionOfResponse(json(responses), 'application/json', 'openai').tools).toEqual([
      { name: 'web_search', args: { type: 'search', query: 'refunds' }, effect: 'read' },
      { name: 'file_search', args: { queries: ['policy'] }, effect: 'read' },
      { name: 'computer.click', args: { type: 'click', x: 10, y: 20, button: 'left' }, effect: 'write' },
      { name: 'computer.screenshot', args: { type: 'screenshot' }, effect: 'read' },
      { name: 'image_generation', args: {}, effect: 'pure' },
      { name: 'close_ticket', args: { id: 7 } },
      { name: 'run_sql', args: 'SELECT 1' },
    ]);
    const done = sse([[null, { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', id: 'ws_1', action: { type: 'search', query: 'refunds' } } }], [null, { type: 'response.completed', response: { status: 'completed' } }]]);
    expect(decisionOfResponse(done, 'text/event-stream', 'openai').tools).toEqual([{ name: 'web_search', args: { type: 'search', query: 'refunds' }, effect: 'read' }]);
    expect([hostedToolEffect('code_execution'), hostedToolEffect('computer.wait'), hostedToolEffect('computer.type'), hostedToolEffect('local_shell'), hostedToolEffect('close_ticket')]).toEqual(['read', 'read', 'write', 'write', null]);
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

  it('compares all of a long text and keeps enough of it to read', () => {
    const long = 'a'.repeat(5000);
    const c = compareDecisions(decision([], { text: long }), decision([], { text: `${long}b` }), effectOf);
    expect(c.rank).toBe(5);
    expect(c.changes[0]!.before).toBe(`${'a'.repeat(2000)}… (3000 more characters)`);
    expect(decisionView(decision([], { text: long }), effectOf).text).toHaveLength(2000 + '… (3000 more characters)'.length);
  });

  it('ranks a search the provider runs itself as a read, whatever the runs say of a tool of that name', () => {
    const search = (query: string): ModelDecision => decisionOf({ blocks: [{ type: 'tool_call', name: 'web_search', input: { query }, hosted: true }], stopReason: 'end_turn' });
    const noEffects: EffectOf = () => null;
    expect(compareDecisions(search('refunds'), search('refund policy'), noEffects)).toMatchObject({ rank: 4, changes: [{ kind: 'read-arguments', tool: 'web_search', effect: 'read' }] });
    expect(compareDecisions(search('refunds'), decisionOf({ blocks: [], stopReason: 'end_turn' }), noEffects)).toMatchObject({ rank: 2, changes: [{ kind: 'stops' }, { kind: 'read-removed', tool: 'web_search', effect: 'read' }] });
    // A click is a write; a screenshot a read.
    const click = decisionOf({ blocks: [{ type: 'tool_call', name: 'computer.click', input: { x: 1, y: 2 }, hosted: true }], stopReason: 'completed' });
    const moved = decisionOf({ blocks: [{ type: 'tool_call', name: 'computer.click', input: { x: 9, y: 2 }, hosted: true }], stopReason: 'completed' });
    expect(compareDecisions(click, moved, noEffects)).toMatchObject({ rank: 1, changes: [{ kind: 'write-arguments', effect: 'write' }] });
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

describe('samples, costs and models', () => {
  it('flags a change by what most samples show, and keeps the worst for the report', () => {
    expect(majorityRank([1])).toBe(1);
    expect(majorityRank([0])).toBeNull();
    // A write changed in 1 of 3 samples: the model's own variation until most samples show it.
    expect(majorityRank([1, 0, 0])).toBeNull();
    expect(majorityRank([1, 3, 0])).toBe(3);
    expect(majorityRank([1, 1, 0])).toBe(1);
    expect(majorityRank([2, 0])).toBeNull();
    expect(majorityRank([2, 1])).toBe(2);
    expect(majorityRank([])).toBeNull();
  });

  it("estimates a step's tokens in a run like the recorded one: the new input split as the recorded call's was", () => {
    // Recorded: most of its input read from the cache the step before wrote.
    const recorded = { input: 100, cacheRead: 9_000, cacheWrite: 900, output: 50 };
    expect(estimatedTokens(recorded, 11_000, 80)).toEqual({ input: 110, cacheRead: 9_900, cacheWrite: 990, output: 80 });
    // Without a recorded split, all of it is plain input.
    expect(estimatedTokens(null, 500, 10)).toEqual({ input: 500, cacheRead: 0, cacheWrite: 0, output: 10 });
    expect(estimatedTokens({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, 500, 10)).toEqual({ input: 500, cacheRead: 0, cacheWrite: 0, output: 10 });
  });

  it("tells a model's family and its other names, and the scopes that are Shadowlap's own", () => {
    expect(['claude-sonnet-4-5-20250929', 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-3-7-sonnet@20250219', 'gpt-4o', 'o3-mini', 'models/gemini-2.5-pro', 'my-deployment', 'llama-3'].map(modelFamily)).toEqual(['claude', 'claude', 'claude', 'openai', 'openai', 'gemini', null, null]);
    expect(sameModel('claude-sonnet-4-5-20250929', 'claude-sonnet-4-5')).toBe(true);
    expect(sameModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'claude-sonnet-4-5-20250929')).toBe(true);
    expect(sameModel('claude-sonnet-4-20250514', 'claude-sonnet-4-0')).toBe(true);
    expect(sameModel('gemini-2.0-flash-001', 'gemini-2.0-flash')).toBe(true);
    expect(sameModel('gpt-4o-2024-08-06', 'gpt-4o')).toBe(true);
    expect(sameModel('gpt-4o-2024-08-06', 'gpt-4o-2024-05-13')).toBe(false);
    expect(sameModel('claude-sonnet-4-5-20250929', 'claude-sonnet-4-6')).toBe(false);
    expect(sameModel('gpt-4.1-mini', 'gpt-4.1')).toBe(false);
    expect(sameModel(null, 'gpt-4.1')).toBe(false);
    expect([isReservedScope('shadowlap:judge'), isReservedScope('agent'), isReservedScope(undefined)]).toEqual([true, false, false]);
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
      majority: rank,
      samples: { asked: 1, answered: 1, changed: rank ? 1 : 0, ranks: [rank ?? 0] },
      model: { recorded: 'claude-opus-5', asked: 'claude-opus-5' },
      tokens: { before: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, after: { input: 90, output: 10, cacheRead: 0, cacheWrite: 0 } },
      cost: { before: 0.001, after: 0.0009, spent: 0.0009 },
      thinkingStripped: 0,
      error: null,
    });
    const report: DecisionsReport = {
      decisionsId: 'dc-01K00000000000000000000000',
      kind: 'decisions',
      at: 0,
      change: { model: null, fields: {}, from: null, fromCode: null, text: 'the prompt and tools in the working tree' },
      command: 'shadowlap decisions 01K1 --from-code',
      samples: 1,
      runs: [{ runId: '01K1AAAAAAAAAAAAAAAAAAAAAA', golden: null, steps: 2, asked: 2, rank: 1, majority: 1, counts: { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, same: 1, untouched: 0, notAsked: 0 }, cost: { before: 0.002, after: 0.0018, spent: 0.0018 }, tokens: { before: { input: 200, output: 20, cacheRead: 0, cacheWrite: 0 }, after: { input: 180, output: 20, cacheRead: 0, cacheWrite: 0 } }, thinkingStripped: 0, refused: null, decisions: [step(10, 1, 'send_email is no longer called'), step(3, null, '')], warnings: [] }],
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
    expect(text).toContain('1 of 1 run decides a write or when to stop differently, under the prompt and tools in the working tree');
    expect(text).toMatch(/#10 +step 10 +rank 1 +send_email is no longer called/);
    expect(text).toContain('recorded send_email({"to":"team@example.com"})');
    expect(text).toContain('now      answers and stops: "Not emailing."');
    expect(text).toContain("Later steps are judged in the recorded run's state.");
    expect(text).not.toContain('#3 ');

    // A run --from-code refuses counts no step: the headline says it could not be asked, in amber,
    // never that the runs hold no model call.
    const none = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, same: 0, untouched: 0, notAsked: 0 };
    const refusal = 'the first request differs in more than its system prompt and tools ($.model changed): verify it instead';
    const refusedRun = { ...report.runs[0]!, steps: 11, asked: 0, rank: null, majority: null, counts: { ...none }, refused: refusal, decisions: [] };
    const allRefused = formatDecisions({ ...report, runs: [refusedRun], counts: { ...none }, flagged: [] });
    expect(allRefused.split('\n')[0]).toBe('! 1 of 1 run could not be asked, under the prompt and tools in the working tree (why below)');
    expect(allRefused).toContain(`01K1AAAAAA  not asked: ${refusal}`);
    expect(allRefused).not.toMatch(/Nothing to ask|no model call/);
    // One run asked the same, another refused: amber, with the refusal named in the headline.
    const sameRun = { ...report.runs[0]!, runId: '01K1BBBBBBBBBBBBBBBBBBBBBB', rank: null, majority: null, counts: { ...none, same: 2 }, decisions: [step(3, null, ''), step(10, null, '')] };
    const mixed = formatDecisions({ ...report, runs: [sameRun, refusedRun], counts: { ...none, same: 2 }, flagged: [] });
    expect(mixed.split('\n')[0]).toBe('! The same decisions at every step asked, under the prompt and tools in the working tree; 1 of 2 runs could not be asked (why below)');
    // Runs that hold no model call still say so.
    const empty = formatDecisions({ ...report, runs: [{ ...sameRun, steps: 0, asked: 0, counts: { ...none }, decisions: [] }], counts: { ...none }, flagged: [] });
    expect(empty.split('\n')[0]).toBe('✓ Nothing to ask: the runs hold no model call, under the prompt and tools in the working tree');
  });
});
