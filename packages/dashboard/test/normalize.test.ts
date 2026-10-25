import { describe, expect, it } from 'vitest';
import { applyDeltas, normalizeConversation, normalizeResponse } from '../src/index.js';

const sse = (events: unknown[]) => Buffer.from(events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join(''));
const SSE = 'text/event-stream';

describe('normalizeResponse', () => {
  it('OpenAI Chat Completions, streamed: text and parallel tool calls with recorded timing', () => {
    const body = sse([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Look' } }] },
      { choices: [{ index: 0, delta: { content: 'ing.' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'read', arguments: '{"p":"a"}' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ]);
    const r = normalizeResponse(body, SSE, [[10, 5], [20, 9], [30, 14], [40, 15], [50, 21], [60, 30]], 'openai');
    expect(r.blocks).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_call', name: 'search', input: { q: 'x' } },
      { type: 'tool_call', name: 'read', input: { p: 'a' } },
    ]);
    expect(r.stopReason).toBe('tool_calls');
    expect(r.deltas[0]).toMatchObject({ t: 5, op: 'start', block: 'text' });
    expect(r.deltas.at(-1)).toMatchObject({ t: 30, op: 'stop' });
    expect(applyDeltas(r.deltas)).toEqual({ blocks: r.blocks, stopReason: r.stopReason });
  });

  it('OpenAI JSON, the Responses API streamed, and Gemini streamed', () => {
    const chat = normalizeResponse(Buffer.from(JSON.stringify({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 't', function: { name: 'f', arguments: '{"a":1}' } }] }, finish_reason: 'tool_calls' }] })), 'application/json');
    expect(chat).toMatchObject({ kind: 'json', stopReason: 'tool_calls', blocks: [{ type: 'text', text: 'hi' }, { type: 'tool_call', name: 'f', input: { a: 1 }, id: 't' }] });

    const responses = normalizeResponse(
      sse([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'lookup' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"id":' },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '7}' },
        { type: 'response.output_text.delta', output_index: 1, delta: 'Done.' },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
      SSE,
      [],
      'openai',
    );
    expect(responses.blocks).toEqual([{ type: 'tool_call', name: 'lookup', input: { id: 7 } }, { type: 'text', text: 'Done.' }]);
    expect(responses.stopReason).toBe('completed');

    const gemini = normalizeResponse(
      sse([
        { candidates: [{ content: { role: 'model', parts: [{ text: 'Hel' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] }, finishReason: 'STOP' }] },
      ]),
      SSE,
    );
    expect(gemini.blocks).toEqual([{ type: 'text', text: 'Hello' }, { type: 'tool_call', name: 'search', input: { q: 'x' } }]);
    expect(gemini.stopReason).toBe('STOP');
  });

  it('handles empty and non-JSON bodies', () => {
    expect(normalizeResponse(null, 'application/json').kind).toBe('empty');
    expect(normalizeResponse(Buffer.from('upstream error'), 'text/plain')).toMatchObject({ kind: 'text', raw: 'upstream error' });
  });
});

describe('normalizeConversation', () => {
  it('Anthropic: system, typed blocks, tool results as a tool turn', () => {
    const c = normalizeConversation({
      model: 'claude-opus-5',
      system: [{ type: 'text', text: 'Be brief.' }],
      tools: [{ name: 'search' }],
      messages: [
        { role: 'user', content: 'Find it.' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'found' }], is_error: false }] },
      ],
    })!;
    expect(c.model).toBe('claude-opus-5');
    expect(c.tools).toEqual(['search']);
    expect(c.turns.map((t) => t.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(c.turns[2].blocks).toEqual([{ type: 'thinking', text: 'hmm' }, { type: 'tool_call', name: 'search', input: { q: 'x' }, id: 't1' }]);
    expect(c.turns[3].blocks).toEqual([{ type: 'tool_result', content: 'found', id: 't1' }]);
  });

  it('OpenAI Chat Completions: tool_calls on assistant turns, tool role messages', () => {
    const c = normalizeConversation({
      model: 'gpt-5',
      tools: [{ type: 'function', function: { name: 'search' } }],
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'Find it.' }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'found' },
      ],
    })!;
    expect(c.turns.map((t) => t.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(c.turns[2].blocks).toEqual([{ type: 'tool_call', name: 'search', input: { q: 'x' }, id: 'c1' }]);
    expect(c.turns[3].blocks).toEqual([{ type: 'tool_result', content: 'found', id: 'c1' }]);
    expect(c.tools).toEqual(['search']);
  });

  it('OpenAI Responses input and Gemini contents', () => {
    const r = normalizeConversation({ model: 'gpt-5', instructions: 'Be brief.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }, { type: 'function_call', call_id: 'f', name: 'look', arguments: '{}' }, { type: 'function_call_output', call_id: 'f', output: 'ok' }] })!;
    expect(r.turns.map((t) => t.role)).toEqual(['system', 'user', 'assistant', 'tool']);

    const g = normalizeConversation(
      {
        systemInstruction: { parts: [{ text: 'Be brief.' }] },
        tools: [{ functionDeclarations: [{ name: 'search' }] }],
        contents: [
          { role: 'user', parts: [{ text: 'Find it.' }] },
          { role: 'model', parts: [{ functionCall: { name: 'search', args: { q: 'x' } } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'search', response: { hits: 1 } } }] },
        ],
      },
      'gemini-2.5-flash',
    )!;
    expect(g.model).toBe('gemini-2.5-flash');
    expect(g.tools).toEqual(['search']);
    expect(g.turns.map((t) => t.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(normalizeConversation('not a conversation')).toBeNull();
  });
});

describe('callName', () => {
  it('drops the method and API version from model endpoints and leaves tools alone', async () => {
    const { callName } = await import('../ui/format.js');
    expect(callName('api', 'POST /v1/messages')).toBe('messages');
    expect(callName('api', 'POST /v1/chat/completions')).toBe('chat/completions');
    expect(callName('api', 'POST /v1/responses')).toBe('responses');
    expect(callName('api', 'POST /v1beta/models/gemini-2.5-flash:streamGenerateContent')).toBe('streamGenerateContent');
    expect(callName('api', 'POST /api/chat')).toBe('api/chat');
    expect(callName('tool', 'POST /v1/looks_like_a_path')).toBe('POST /v1/looks_like_a_path');
  });
});
