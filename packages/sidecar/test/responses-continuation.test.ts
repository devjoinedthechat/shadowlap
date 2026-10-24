import { describe, expect, it } from 'vitest';
import type { CallRecord } from '@shadowlap/engine';
import { isResponsesCreate, recordedResponse, ResponsesState } from '../src/responses-state.js';

/**
 * How a fork's live Responses call is sent when it continues what the recording kept on OpenAI's
 * side: the conversation rebuilt from the recorded requests and their answers, item by item.
 */

const sse = (events: object[]) => Buffer.from(events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));

/** A recording of Responses calls: each a request and the response it got (JSON, or as a stream). */
function recording(calls: Array<{ request: object; response: object; stream?: boolean; path?: string }>) {
  const records = calls.map(
    (c, i): CallRecord => ({
      runId: 'R',
      callNo: i + 1,
      kind: 'api',
      name: `POST ${c.path ?? '/v1/responses'}`,
      fingerprint: `f${i}`,
      occurrence: 1,
      origin: 'live',
      effect: null,
      requestRef: `req${i}`,
      meta: { provider: 'openai' },
      at: i,
      end: { runId: 'R', callNo: i + 1, attempt: 0, responseRef: `res${i}`, outcome: 'ok', meta: { headers: { 'content-type': c.stream ? 'text/event-stream' : 'application/json' } }, at: i },
      attempts: [],
    }),
  );
  let reads = 0;
  const state = new ResponsesState(records, {
    request: (rec) => (reads++, calls[rec.callNo - 1]!.request),
    response: (rec) => {
      const c = calls[rec.callNo - 1]!;
      return { bytes: c.stream ? sse([{ type: 'response.created', response: { id: (c.response as { id: string }).id } }, { type: 'response.completed', response: c.response }]) : Buffer.from(JSON.stringify(c.response)), contentType: c.stream ? 'text/event-stream' : 'application/json' };
    },
  });
  return { state, reads: () => reads };
}

const said = (text: string, id = `msg_${text.length}`) => ({ type: 'message', id, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] });

describe('a live Responses call that continues a recorded response', () => {
  it('is sent with the whole chain it continues, first turn first, output items as the stateless pattern passes them', () => {
    const { state } = recording([
      { request: { model: 'gpt-5', input: 'Hi', instructions: 'Be brief.' }, response: { id: 'resp_1', output: [said('Hello.', 'msg_1')] }, stream: true },
      { request: { model: 'gpt-5', previous_response_id: 'resp_1', input: [{ role: 'user', content: 'Refund A-17?' }] }, response: { id: 'resp_2', output: [{ type: 'reasoning', id: 'rs_1', summary: [] }, { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'gAAA' }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'refund', arguments: '{"id":"A-17"}', status: 'completed' }] } },
    ]);
    const continued = state.continuation({ model: 'gpt-5', instructions: 'Be brief.', previous_response_id: 'resp_2', input: [{ type: 'function_call_output', call_id: 'call_1', output: 'done' }], store: true });
    expect(continued).toEqual({
      send: 'whole',
      previous: 'resp_2',
      from: [1, 2],
      body: {
        model: 'gpt-5',
        instructions: 'Be brief.',
        store: true,
        input: [
          { role: 'user', content: 'Hi' },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello.', annotations: [] }] },
          { role: 'user', content: 'Refund A-17?' },
          // Reasoning readable only on the provider's side is left out; one with its encrypted content goes along.
          { type: 'reasoning', id: 'rs_2', summary: [], encrypted_content: 'gAAA' },
          { type: 'function_call', call_id: 'call_1', name: 'refund', arguments: '{"id":"A-17"}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'done' },
        ],
      },
    });
  });

  it('puts the item a call refers to by id in its place, and keeps naming a response the chain began at before the recording', () => {
    const { state } = recording([{ request: { model: 'gpt-5', previous_response_id: 'resp_before', input: 'Go on.' }, response: { id: 'resp_1', output: [said('Going.', 'msg_7')] } }]);
    expect(state.continuation({ model: 'gpt-5', previous_response_id: 'resp_1', input: [{ type: 'item_reference', id: 'msg_7' }, { type: 'item_reference', id: 'msg_unknown' }] })).toMatchObject({
      send: 'whole',
      from: [1],
      body: {
        previous_response_id: 'resp_before',
        input: [{ role: 'user', content: 'Go on.' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Going.', annotations: [] }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Going.', annotations: [] }] }, { type: 'item_reference', id: 'msg_unknown' }],
      },
    });
  });

  it('is sent as it is when it continues nothing the recording made, and nothing is read for one that continues nothing', () => {
    const { state, reads } = recording([{ request: { model: 'gpt-5', input: 'Hi' }, response: { id: 'resp_1', output: [] } }]);
    expect(state.continuation({ model: 'gpt-5', input: 'Hi again' })).toEqual({ send: 'as-is' });
    expect(reads()).toBe(0);
    // A response the fork made live: the provider holds it for this key.
    expect(state.continuation({ model: 'gpt-5', previous_response_id: 'resp_made_live', input: 'And?' })).toEqual({ send: 'as-is' });
  });
});

describe('a live Responses call that names a recorded conversation', () => {
  it('is refused, naming the call that made the conversation', () => {
    const { state } = recording([
      { request: {}, response: { id: 'conv_1', object: 'conversation' }, path: '/v1/conversations' },
      { request: { model: 'gpt-5', conversation: 'conv_1', input: 'First' }, response: { id: 'resp_1', output: [said('ok')], conversation: { id: 'conv_1' } } },
    ]);
    const refused = state.continuation({ model: 'gpt-5', conversation: { id: 'conv_1' }, input: 'Second' });
    expect(refused).toMatchObject({ param: 'conversation' });
    expect((refused as { refuse: string }).refuse).toMatch(/^it continues conversation conv_1, which OpenAI keeps with every turn of the recorded run, .* Fork from call #1, which made the conversation \(--diverge-at 1\)/);
    // One the fork made itself holds nothing of the recording's.
    expect(state.continuation({ model: 'gpt-5', conversation: 'conv_new', input: 'Second' })).toEqual({ send: 'as-is' });
  });
});

describe('a recorded Response', () => {
  it('is read from its JSON, from its completed stream, and from a stream cut short', () => {
    expect(recordedResponse(Buffer.from('{"id":"resp_1","output":[{"type":"message"}]}'), 'application/json')).toEqual({ id: 'resp_1', output: [{ type: 'message' }], conversation: null });
    const cut = sse([{ type: 'response.created', response: { id: 'resp_2' } }, { type: 'response.output_item.done', output_index: 0, item: said('Partial') }]);
    expect(recordedResponse(cut, 'text/event-stream')).toEqual({ id: 'resp_2', output: [said('Partial')], conversation: null });
    expect(recordedResponse(Buffer.from('not json'), 'application/json')).toBeNull();
  });

  it('is a create only for POST …/responses in OpenAI\'s format', () => {
    expect(isResponsesCreate('POST', '/v1/responses', 'openai')).toBe(true);
    expect(isResponsesCreate('POST', '/openai/v1/responses', 'azure')).toBe(true);
    expect(isResponsesCreate('GET', '/v1/responses/resp_1', 'openai')).toBe(false);
    expect(isResponsesCreate('POST', '/v1/messages', 'anthropic')).toBe(false);
  });
});
