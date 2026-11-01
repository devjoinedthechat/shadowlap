import { describe, expect, it } from 'vitest';
import { compareDecisions, controlOpen, decisionOf, decisionOfResponse, decisionsHeadline, decisionsMoved, decisionsName, decisionsUnsettled, decisionView, effectsOf, emptyCounts, estimatedTokens, formatDecisions, hostedToolEffect, isHandover, isReservedScope, judgedOutcome, judgeOpen, majorityRank, migrateBreaks, migrateUnsettled, modelFamily, NO_TOKENS, promoteByJudge, RANK_LABELS, sameModel, shownSample, unjudgedSample, unsettledRun, type DecisionJudge, type DecisionRun, type DecisionStep, type DecisionsReport, type EffectOf, type ModelDecision, type UnsettledRun } from '../src/decisions.js';
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
    expect(c.changes[0].detail).toMatch(/no recording gives an effect, so it counts as a write/);
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
    expect(c.changes[0].before).toBe(`${'a'.repeat(2000)}… (3000 more characters)`);
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
      judge: null,
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
    const refusedRun = { ...report.runs[0], steps: 11, asked: 0, rank: null, majority: null, counts: { ...none }, refused: refusal, decisions: [] };
    const allRefused = formatDecisions({ ...report, runs: [refusedRun], counts: { ...none }, flagged: [] });
    expect(allRefused.split('\n')[0]).toBe('! 1 of 1 run could not be asked, under the prompt and tools in the working tree (why below)');
    expect(allRefused).toContain(`01K1AAAAAA  not asked: ${refusal}`);
    expect(allRefused).not.toMatch(/Nothing to ask|no model call/);
    // One run asked the same, another refused: amber, with the refusal named in the headline.
    const sameRun = { ...report.runs[0], runId: '01K1BBBBBBBBBBBBBBBBBBBBBB', rank: null, majority: null, counts: { ...none, same: 2 }, decisions: [step(3, null, ''), step(10, null, '')] };
    const mixed = formatDecisions({ ...report, runs: [sameRun, refusedRun], counts: { ...none, same: 2 }, flagged: [] });
    expect(mixed.split('\n')[0]).toBe('! The same decisions at every step asked, under the prompt and tools in the working tree; 1 of 2 runs could not be asked (why below)');
    // A refusal of several lines, as an unrecorded write's is, prints them as lines, never as \n.
    const unrecorded = '01K1AAAAAA holds model calls of a tool Shadowlap never recorded, which writes: a replay would run it again for real.\n    Bash  1 call from model call #1 · a built-in that writes\n  If running it again is safe, declare it a read.';
    const lines = formatDecisions({ ...report, runs: [{ ...refusedRun, refused: unrecorded }], counts: { ...none }, flagged: [] }).split('\n');
    expect(lines).toContain('01K1AAAAAA  not asked: 01K1AAAAAA holds model calls of a tool Shadowlap never recorded, which writes: a replay would run it again for real.');
    expect(lines).toContain('      Bash  1 call from model call #1 · a built-in that writes');
    expect(lines).toContain('    If running it again is safe, declare it a read.');
    expect(lines.join('\n')).not.toContain('\\n');
    // Runs that hold no model call still say so.
    const empty = formatDecisions({ ...report, runs: [{ ...sameRun, steps: 0, asked: 0, counts: { ...none }, decisions: [] }], counts: { ...none }, flagged: [] });
    expect(empty.split('\n')[0]).toBe('✓ Nothing to ask: the runs hold no model call, under the prompt and tools in the working tree');
  });

  it('gives its headline in parts, for the dashboard to say a preview in the same words', () => {
    const none = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, same: 0, untouched: 0, notAsked: 0 };
    const run = (runId: string, refused: string | null = null) => ({ runId, refused, decisions: [] });
    expect(decisionsHeadline({ counts: { ...none, same: 4 }, flagged: [], runs: [run('A')] })).toEqual({ mark: '✓', lead: 'The same decisions', rest: ' at every step asked', detail: '', unasked: null, asked: true });
    // One decision differs, two differ: the verb agrees. The count follows the sentence, apart from it.
    expect(decisionsHeadline({ counts: { ...none, 3: 1, same: 3 }, flagged: [], runs: [run('A')] })).toMatchObject({ mark: '!', lead: 'No write and no stop changes', rest: '', detail: ': 1 decision differs in reads or text' });
    expect(decisionsHeadline({ counts: { ...none, 3: 1, 5: 1 }, flagged: [], runs: [run('A')] })).toMatchObject({ detail: ': 2 decisions differ in reads or text' });
    // A run that could not be asked: the headline when no step was, said beside it otherwise.
    expect(decisionsHeadline({ counts: { ...none }, flagged: [], runs: [run('A', 'its first request differs in more than its prompt')] })).toEqual({ mark: '!', lead: '1 of 1 run could not be asked', rest: '', detail: '', unasked: '1 of 1 run could not be asked', asked: false });
    expect(decisionsHeadline({ counts: { ...none, same: 2 }, flagged: [], runs: [run('A'), run('B', 'refused')] })).toMatchObject({ mark: '!', lead: 'The same decisions', unasked: '1 of 2 runs could not be asked', asked: true });
    expect(decisionsHeadline({ counts: { ...none, notAsked: 3 }, flagged: [], runs: [run('A')] })).toMatchObject({ mark: '!', lead: 'No step was answered', rest: '', detail: ' (the warnings say why)' });
    expect(decisionsHeadline({ counts: { ...none, untouched: 2 }, flagged: [], runs: [run('A')] })).toMatchObject({ mark: '✓', lead: 'Nothing to ask', rest: '', detail: ': the change leaves every request as recorded' });
    // A run flagged by a write.
    const write = { runId: 'A', refused: null, decisions: [{ majority: 1, changes: [{ rank: 1, kind: 'write-removed', tool: 'send_email', effect: 'write', before: {}, after: null, detail: 'send_email is no longer called' }] }] } as unknown as Parameters<typeof decisionsHeadline>[0]['runs'][number];
    expect(decisionsHeadline({ counts: { ...none, 1: 1, same: 5 }, flagged: ['A'], runs: [write, run('B')] })).toMatchObject({ mark: '✗', lead: '1 of 2 runs', rest: ' decides a write or when to stop differently', detail: '' });
  });

  it('prints the headline it gives, its verb agreeing with one decision', () => {
    const counts = { 1: 0, 2: 0, 3: 1, 4: 0, 5: 0, same: 3, untouched: 0, notAsked: 0 };
    const run: DecisionRun = { runId: '01K1AAAAAAAAAAAAAAAAAAAAAA', golden: null, steps: 4, asked: 4, rank: 3, majority: 3, counts, cost: { before: null, after: null, spent: 0 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions: [], warnings: [] };
    const report: DecisionsReport = { decisionsId: null, kind: 'decisions', at: 0, change: { model: 'claude-haiku-4-5', fields: {}, from: null, fromCode: null, text: 'the model claude-haiku-4-5' }, command: 'shadowlap decisions 01K1 --model claude-haiku-4-5', samples: 1, runs: [run], counts, flagged: [], cost: { before: null, after: null, spent: 0, upstreamRequests: 4, unknownModels: [] }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, retirements: [], notes: [], warnings: [], verify: null, judge: null, remedies: [], stopReason: null };
    expect(formatDecisions(report).split('\n')[0]).toBe('! No write and no stop changes: 1 decision differs in reads or text, under the model claude-haiku-4-5');
  });

  it('names a session as the dialog that makes it, and a migration by its switch', () => {
    expect(decisionsName({ kind: 'decisions', change: { model: 'claude-haiku-4-5', fields: {}, fromCode: null } })).toBe('Model switch to claude-haiku-4-5');
    expect(decisionsName({ kind: 'decisions', change: { model: null, fields: {}, fromCode: { calls: 3 } } })).toBe('Changed prompt and tools');
    expect(decisionsName({ kind: 'decisions', change: { model: null, fields: { temperature: 0 }, fromCode: null } })).toBe('Field change to temperature=0');
    // What else the change set comes after its name, never dropped.
    expect(decisionsName({ kind: 'decisions', change: { model: 'claude-sonnet-5-5', fields: { temperature: 1, stop: 'END' }, fromCode: null } })).toBe('Model switch to claude-sonnet-5-5 with temperature=1, stop=END');
    expect(decisionsName({ kind: 'decisions', change: { model: 'claude-haiku-4-5', fields: { top_p: 0.9 }, fromCode: { calls: 1 } } })).toBe('Changed prompt and tools with the model claude-haiku-4-5 and top_p=0.9');
    expect(decisionsName({ kind: 'migrate', change: { model: 'claude-sonnet-5-5' }, from: ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'], to: 'claude-sonnet-5-5' })).toBe('claude-sonnet-4-5, claude-sonnet-4-5-20250929 → claude-sonnet-5-5');
    // A kept report missing a part: named by what it has.
    expect(decisionsName({ kind: 'migrate', change: null, from: [], to: 'claude-haiku-4-5' })).toBe('Migration to claude-haiku-4-5');
    expect(decisionsName({ kind: 'decisions', change: null })).toBe('No change');
  });

  it('counts what a preview moved by rank: its writes, stops and reads', () => {
    const none = { 1: 0, 2: 0, 3: 0, 4: 0 };
    expect(decisionsMoved({ ...none, 1: 2, 2: 3, 3: 1, 4: 2 })).toEqual(['2 writes changed', '3 stops changed', '3 reads changed']);
    expect(decisionsMoved({ ...none, 1: 1, 2: 1 })).toEqual(['1 write changed', '1 stop changed']);
    expect(decisionsMoved({ ...none, 4: 1 })).toEqual(['1 read changed']);
    // Text alone, or nothing: nothing moved.
    expect(decisionsMoved(none)).toEqual([]);
  });
});

describe('why a preview or a migration settles nothing', () => {
  /** A run as decisionsUnsettled reads it: asked whole and settled, unless told otherwise. */
  const facts = (runId: string, o: Partial<UnsettledRun> = {}): UnsettledRun => ({ runId, refused: false, steps: 4, asked: 4, notAsked: 0, judgeOpen: false, controlOpen: false, ...o });
  const preview = (runs: UnsettledRun[], o: Partial<Parameters<typeof decisionsUnsettled>[0]> = {}) => decisionsUnsettled({ stopReason: null, flagged: [], runs, verify: null, ...o });

  it('settles a preview whose every run was asked and none waits', () => {
    expect(preview([facts('A'), facts('B')])).toBeNull();
    // A run that holds no model call has nothing to ask: it isn't one that could not be asked.
    expect(preview([facts('A', { steps: 0, asked: 0 })])).toBeNull();
    // Some of a run's steps got no answer, others did: it was asked.
    expect(preview([facts('A', { asked: 3, notAsked: 1 })])).toBeNull();
  });

  it('names what settles nothing first: a stop, a run not asked, a judge, the control, then verify', () => {
    expect(preview([facts('A', { refused: true })], { stopReason: 'the budget of $0.10 is spent' })).toBe('it stopped before every step was asked: the budget of $0.10 is spent');
    expect(preview([facts('A', { refused: true }), facts('B')])).toBe('1 run could not be asked');
    // Every model call of a run got no answer, of two runs.
    expect(preview([facts('A', { asked: 0, notAsked: 4 }), facts('B', { asked: 0, notAsked: 4 }), facts('C', { judgeOpen: true })])).toBe('2 runs could not be asked');
    expect(preview([facts('A', { judgeOpen: true }), facts('B', { controlOpen: true })])).toBe('1 run has a text-only change a judge check reads that could not be judged');
    expect(preview([facts('A', { controlOpen: true }), facts('B', { controlOpen: true })])).toBe("2 runs have a changed step the request as recorded got no answer for, so it could not be told from the model's own variation");
    expect(preview([facts('A')], { verify: { verdict: 'incomplete', reasons: [] } })).toBe('verify did not settle every run it took');
    expect(preview([facts('A')], { verify: { verdict: 'not-run', reasons: ['it was interrupted before verify started'] } })).toBe('verify did not run: it was interrupted before verify started');
    expect(preview([facts('A')], { verify: { verdict: 'not-run', reasons: [] } })).toBeNull();
  });

  it('leaves a run it flags to verify: its waiting steps settle nothing more', () => {
    expect(preview([facts('A', { judgeOpen: true, controlOpen: true })], { flagged: ['A'] })).toBeNull();
    expect(preview([facts('A', { judgeOpen: true }), facts('B', { judgeOpen: true })], { flagged: ['A'] })).toBe('1 run has a text-only change a judge check reads that could not be judged');
  });

  it("reads a run's steps for a judge and the control to wait on", () => {
    const step = (o: Partial<DecisionStep>): DecisionStep => ({ callNo: 1, step: 1, scope: null, rank: null, majority: null, changes: [], recorded: { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'a' }, now: null, samples: { asked: 3, answered: 3, changed: 0, ranks: [0, 0, 0] }, model: { recorded: 'm', asked: 'n' }, tokens: { before: null, after: null }, cost: { before: null, after: null, spent: 0 }, thinkingStripped: 0, error: null, ...o });
    const waits = step({ rank: 5, majority: 5, samples: { asked: 3, answered: 3, changed: 3, ranks: [5, 5, 5], unjudged: 1 } });
    const uncontrolled = step({ sampled: 2, samples: { asked: 3, answered: 3, changed: 2, ranks: [2, 2, 0] }, control: { asked: 3, answered: 1, changed: 0, ranks: [0], error: 'HTTP 529' } });
    expect([judgeOpen(waits), controlOpen(uncontrolled)]).toEqual([true, true]);
    const run: DecisionRun = { runId: 'A', golden: null, steps: 3, asked: 2, rank: 5, majority: 5, counts: { ...emptyCounts(), 5: 1, same: 1, notAsked: 1 }, cost: { before: null, after: null, spent: 0 }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, thinkingStripped: 0, refused: null, decisions: [waits, uncontrolled, step({})], warnings: [] };
    expect(unsettledRun(run)).toEqual({ runId: 'A', refused: false, steps: 3, asked: 2, notAsked: 1, judgeOpen: true, controlOpen: true });
    expect(unsettledRun({ ...run, refused: 'its first request differs in more than its prompt', asked: 0, decisions: [step({ samples: { asked: 0, answered: 0, changed: 0, ranks: [] } })] })).toMatchObject({ refused: true, judgeOpen: false, controlOpen: false });
  });

  it("says a migration breaks a run when verify rejected it or a run it verified fails, and settles nothing while a run is inconclusive", () => {
    const passes = (verdict: 'accepted' | 'rejected' | 'incomplete' | 'not-run', runs: Array<{ verdict: string; verified: boolean }>) => ({ verdict, runs });
    expect(migrateBreaks(passes('rejected', []))).toBe(true);
    expect(migrateBreaks(passes('accepted', [{ verdict: 'failed', verified: true }]))).toBe(true);
    // A run that failed as recorded, not re-run: no run the switch broke.
    expect(migrateBreaks(passes('accepted', [{ verdict: 'failed', verified: false }, { verdict: 'passed', verified: true }]))).toBe(false);
    expect(migrateUnsettled({ stopReason: 'the budget of $1.00 is spent', passes: passes('accepted', []) })).toBe('it stopped before every step was asked: the budget of $1.00 is spent');
    expect(migrateUnsettled({ stopReason: null, passes: passes('incomplete', [{ verdict: 'inconclusive', verified: true }]) })).toBe('verify did not settle every run it took');
    expect(migrateUnsettled({ stopReason: null, passes: passes('accepted', [{ verdict: 'passed', verified: true }, { verdict: 'inconclusive', verified: false }]) })).toBe('1 run is inconclusive');
    expect(migrateUnsettled({ stopReason: null, passes: passes('not-run', [{ verdict: 'inconclusive', verified: false }, { verdict: 'inconclusive', verified: false }]) })).toBe('2 runs are inconclusive');
    expect(migrateUnsettled({ stopReason: null, passes: passes('accepted', [{ verdict: 'passed', verified: true }, { verdict: 'passed', verified: false }]) })).toBeNull();
  });
});

describe('a text-only change a judge check reads', () => {
  const recorded: ModelDecision = { stop: 'answer', stopReason: 'end_turn', tools: [], text: 'A manager will review your refund: it is over the limit.', handover: null };
  const now: ModelDecision = { ...recorded, text: 'A manager will review your refund.' };
  const side = (status: 'passed' | 'failed' | 'inconclusive', o: Partial<DecisionJudge['now']> = {}): DecisionJudge['now'] => ({ status, verdict: status === 'passed' ? 'yes' : status === 'failed' ? 'no' : null, reason: status === 'inconclusive' ? 'not judged: no recorded verdict and no key for openai (OPENAI_API_KEY)' : `it ${status}`, source: status === 'inconclusive' ? null : 'live', cost: status === 'inconclusive' ? null : 0.0024, request: status === 'inconclusive' ? null : 'f'.repeat(32), ...o });
  const check = (r: DecisionJudge['recorded'], n: DecisionJudge['now']): DecisionJudge => ({ name: 'explains-escalation', of: 'answer', model: 'claude-haiku-4-5', pass: 'yes', recorded: r, now: n, changed: r.status === 'inconclusive' || n.status === 'inconclusive' ? null : r.status !== n.status });

  it('ranks 2 when a check comes out otherwise for the new words, ahead of the text, and stays text only when none does', () => {
    const text = compareDecisions(recorded, now, () => null);
    expect(text.rank).toBe(5);
    const fails = promoteByJudge(text, [check(side('passed', { source: 'recording', cost: 0 }), side('failed'))]);
    expect(fails.rank).toBe(2);
    expect(fails.changes.map((c) => [c.rank, c.kind, c.before, c.after])).toEqual([
      [2, 'judge', 'passed', 'failed'],
      [5, 'text', recorded.text, now.text],
    ]);
    expect(fails.changes[0].detail).toBe('judge "explains-escalation" fails what it says now, which passed as recorded');
    expect(promoteByJudge(text, [check(side('failed'), side('passed'))]).changes[0].detail).toBe('judge "explains-escalation" passes what it says now, which failed as recorded');
    // As recorded, or not judged: a text-only change still, which no verdict it lacks may raise.
    expect(promoteByJudge(text, [check(side('passed'), side('passed'))])).toEqual(text);
    expect(promoteByJudge(text, [check(side('passed'), side('inconclusive'))])).toEqual(text);
    // A change in what the agent does keeps its own rank.
    const stops = compareDecisions(recorded, { ...now, stop: 'tools', tools: [{ name: 'escalate', args: {} }] }, () => 'write');
    expect(promoteByJudge(stops, [check(side('passed'), side('failed'))])).toEqual(stops);
    expect(RANK_LABELS[2]).toBe('it stops, hands over or is judged differently');
  });

  it('says how its checks came out, for a cell, and when a step waits on a judge', () => {
    const asRecorded = check(side('passed'), side('passed'));
    const notJudged = check(side('passed'), side('inconclusive'));
    const otherwise = check(side('passed'), side('failed'));
    // One sample: its own checks say.
    const once = (judge: DecisionJudge[] | null, rank: 2 | 5 | null, unjudged = 0) => ({ judge, majority: rank, samples: { asked: 1, answered: 1, changed: rank ? 1 : 0, unjudged, ranks: [rank ?? 0] } });
    expect(judgedOutcome(once(null, null))).toBeNull();
    expect(judgedOutcome(once([asRecorded], 5))).toBe('unchanged');
    expect(judgeOpen(once([asRecorded, notJudged], 5, 1))).toBe(true);
    expect(judgedOutcome(once([asRecorded, notJudged], 5, 1))).toBe('inconclusive');
    expect(judgeOpen(once([notJudged, otherwise], 2))).toBe(false);
    expect(judgedOutcome(once([notJudged, otherwise], 2))).toBe('changed');
    // Three samples: one came out otherwise, in fewer than half of them, and the judge could not judge the other two. Shown or not, they keep the step waiting.
    const minority = { judge: [otherwise], majority: 5 as const, samples: { asked: 3, answered: 3, changed: 3, unjudged: 2, ranks: [2, 5, 5] } };
    expect(judgeOpen(minority)).toBe(true);
    expect(judgedOutcome(minority)).toBe('inconclusive');
    // Behind a read changed in another sample, too.
    expect(judgeOpen({ majority: 5, samples: { asked: 2, answered: 2, changed: 2, unjudged: 1, ranks: [3, 5] } })).toBe(true);
    // Flagged by most of its samples: what the one not judged would make of its words changes nothing.
    const flagged = { ...minority, majority: 2 as const, samples: { ...minority.samples, unjudged: 1, ranks: [2, 2, 5] } };
    expect(judgeOpen(flagged)).toBe(false);
    expect(judgedOutcome(flagged)).toBe('changed');
    // A session kept before samples counted them waits on nothing.
    expect(judgeOpen({ majority: 5, samples: { asked: 1, answered: 1, changed: 1, ranks: [5] } })).toBe(false);
  });

  it('shows the most consequential sample, and of text-only ones, one a judge could not judge', () => {
    const asRecorded = [check(side('passed'), side('passed'))];
    const notJudged = [check(side('passed'), side('inconclusive'))];
    const otherwise = [check(side('passed'), side('failed'))];
    expect(unjudgedSample(notJudged)).toBe(true);
    expect(unjudgedSample(asRecorded)).toBe(false);
    expect(unjudgedSample(null)).toBe(false);
    // Raised to rank 2 by one check, whatever the other could not say.
    expect(unjudgedSample([...otherwise, ...notJudged])).toBe(false);
    expect(shownSample([])).toBe(-1);
    // The first sample came out as recorded and the second was not judged: the second shows the step, which never reads as judged.
    expect(shownSample([{ rank: 5, judge: asRecorded }, { rank: 5, judge: notJudged }])).toBe(1);
    expect(shownSample([{ rank: 5, judge: notJudged }, { rank: 5, judge: asRecorded }])).toBe(0);
    // A judged change, or any other more consequential one, comes first.
    expect(shownSample([{ rank: 5, judge: notJudged }, { rank: 2, judge: otherwise }])).toBe(1);
    expect(shownSample([{ rank: 1, judge: null }, { rank: 5, judge: notJudged }])).toBe(0);
    // Else the first of the most consequential, a sample that decided as recorded last.
    expect(shownSample([{ rank: null, judge: null }, { rank: 5, judge: asRecorded }, { rank: 5, judge: asRecorded }])).toBe(1);
  });

  it('shows each check beside the step, says the run is judged otherwise, and what judging cost apart from asking', () => {
    const promoted = promoteByJudge(compareDecisions(recorded, now, () => null), [check(side('passed', { source: 'recording', cost: 0 }), side('failed'))]);
    const view = (d: ModelDecision) => decisionView(d, () => null);
    const step = (callNo: number, o: { rank: 2 | 5; changes: typeof promoted.changes; judge: DecisionJudge[] }) => ({ callNo, step: callNo, scope: null, rank: o.rank, majority: o.rank, changes: o.changes, recorded: view(recorded), now: view(now), samples: { asked: 1, answered: 1, changed: 1, ranks: [o.rank] }, model: { recorded: 'claude-opus-5', asked: 'claude-opus-5' }, tokens: { before: null, after: null }, cost: { before: null, after: null, spent: 0.001 }, thinkingStripped: 0, error: null, judge: o.judge });
    const counts = { 1: 0, 2: 1, 3: 0, 4: 0, 5: 0, same: 10, untouched: 0, notAsked: 0 };
    const run = { runId: '01K1AAAAAAAAAAAAAAAAAAAAAA', golden: 'goldens/refund', steps: 11, asked: 11, rank: 2 as const, majority: 2 as const, counts, cost: { before: null, after: null, spent: 0.01 }, tokens: { before: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, after: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }, thinkingStripped: 0, refused: null, decisions: [step(30, { rank: 2, changes: promoted.changes, judge: promoted.changes.length ? [check(side('passed', { source: 'recording', cost: 0 }), side('failed', { reason: 'it no longer says why' }))] : [] })], warnings: [] };
    const report: DecisionsReport = {
      decisionsId: null,
      kind: 'decisions',
      at: 0,
      change: { model: 'claude-haiku-4-5', fields: {}, from: null, fromCode: null, text: 'the model claude-haiku-4-5' },
      command: 'shadowlap decisions goldens/refund --model claude-haiku-4-5',
      samples: 1,
      runs: [run],
      counts,
      flagged: [run.runId],
      cost: { before: null, after: null, spent: 0.01, upstreamRequests: 11, unknownModels: [] },
      tokens: { before: run.tokens.before, after: run.tokens.after },
      retirements: [],
      notes: [],
      warnings: [],
      verify: null,
      judge: { steps: 1, changed: 1, inconclusive: 0, spent: 0.0024, upstreamRequests: 1, unknownModels: [] },
      remedies: [],
      stopReason: null,
    };
    const text = formatDecisions(report);
    expect(text.split('\n')[0]).toBe('✗ 1 of 1 run is judged otherwise, under the model claude-haiku-4-5');
    expect(text).toContain('1 changed, most: rank 2 (it stops, hands over or is judged differently)');
    expect(text).toMatch(/#30 +step 30 +rank 2 +judge "explains-escalation" fails what it says now, which passed as recorded/);
    expect(text).toContain('judge "explains-escalation" passed → failed · it no longer says why (judged live, ≈$0.0024)');
    expect(text).toContain('  judging: 1 upstream request · ≈$0.0024 spent');
    // A write as well: both are said.
    const write = { ...run, runId: '01K1BBBBBBBBBBBBBBBBBBBBBB', rank: 1 as const, majority: 1 as const, decisions: [{ ...run.decisions[0], rank: 1 as const, majority: 1 as const, changes: [{ rank: 1 as const, kind: 'write-removed' as const, tool: 'send_email', effect: 'write' as const, before: {}, after: null, detail: 'send_email is no longer called' }], judge: null }] };
    expect(formatDecisions({ ...report, runs: [run, write], flagged: [run.runId, write.runId] }).split('\n')[0]).toBe('✗ 2 of 2 runs decide a write or when to stop differently, or are judged otherwise, under the model claude-haiku-4-5');
    // As recorded, and not judged: each says so.
    const same = formatDecisions({ ...report, flagged: [], runs: [{ ...run, rank: 5, majority: 5, decisions: [{ ...run.decisions[0], rank: 5, majority: 5, changes: [promoted.changes[1]], judge: [check(side('passed', { source: 'recording', cost: 0, reason: 'it says why' }), side('passed', { source: 'kept', cost: 0, reason: 'it says why' }))] }] }] });
    expect(same).toContain('judge "explains-escalation" passed, as recorded · it says why (asked before and kept, free)');
    const open = formatDecisions({ ...report, flagged: [], runs: [{ ...run, rank: 5, majority: 5, decisions: [{ ...run.decisions[0], rank: 5, majority: 5, changes: [promoted.changes[1]], judge: [check(side('passed', { source: 'recording', cost: 0 }), side('inconclusive'))] }] }] });
    expect(open).toContain('judge "explains-escalation" inconclusive · not judged: no recorded verdict and no key for openai (OPENAI_API_KEY)');
    // With samples, how many of them a judge could not judge, the one shown or not.
    const sampled = formatDecisions({ ...report, samples: 3, flagged: [], runs: [{ ...run, rank: 2, majority: 5, decisions: [{ ...run.decisions[0], majority: 5, samples: { asked: 3, answered: 3, changed: 3, unjudged: 2, ranks: [2, 5, 5] } }] }] });
    expect(sampled).toMatch(/#30 +step 30 +rank 2 +judge "explains-escalation" fails what it says now, which passed as recorded · in 3 of 3 samples, fewer than half: not flagged, 2 of them not judged/);
  });

  it('calls judging free only when no judge request went upstream: a judge with no price is no free call', () => {
    const report = { decisionsId: null, kind: 'decisions', at: 0, change: { model: 'mock-terse', fields: {}, from: null, fromCode: null, text: 'the model mock-terse' }, command: 'shadowlap decisions goldens/refund --model mock-terse', samples: 1, runs: [], counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, same: 0, untouched: 0, notAsked: 0 }, flagged: [], cost: { before: null, after: null, spent: 0, upstreamRequests: 0, unknownModels: [] }, tokens: { before: NO_TOKENS, after: NO_TOKENS }, retirements: [], notes: [], warnings: [], verify: null, remedies: [], stopReason: null } satisfies Omit<DecisionsReport, 'judge'>;
    const judging = (judge: DecisionsReport['judge']) => formatDecisions({ ...report, judge }).split('\n').find((l) => l.startsWith('  judging:'));
    expect(judging({ steps: 1, changed: 0, inconclusive: 0, spent: 0, upstreamRequests: 1, unknownModels: ['claude-mock-judge-9'] })).toBe('  judging: 1 upstream request · ≈$0 spent (no price for claude-mock-judge-9)');
    expect(judging({ steps: 1, changed: 0, inconclusive: 0, spent: 0.0012, upstreamRequests: 2, unknownModels: ['claude-mock-judge-9'] })).toBe('  judging: 2 upstream requests · ≈$0.0012 spent (no price for claude-mock-judge-9)');
    // Every verdict from the recording or kept: nothing went upstream.
    expect(judging({ steps: 1, changed: 0, inconclusive: 0, spent: 0, upstreamRequests: 0, unknownModels: [] })).toBe('  judging: 0 upstream requests · free');
    expect(judging(null)).toBeUndefined();
  });
});
