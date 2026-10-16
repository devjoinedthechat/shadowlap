import { describe, expect, it } from 'vitest';
import { eventStreamFrames, eventStreamMessages } from '../src/eventstream.js';
import { anthropicAnswer, answerAs, errorAs, isTakeoverCall, requestFor, takeoverMode, takeoverRefusal, wantsStream, type TakeoverTarget } from '../src/takeover.js';
import { chatCompletionOf } from '../src/translate.js';
import { chatCompletionToConverse, converseStreamBody, converseToOpenAIChat } from '../src/translate-converse.js';
import { chatCompletionToGemini, geminiStreamBody, geminiToOpenAIChat, geminiUsesIds } from '../src/translate-gemini.js';
import { chatCompletionToResponse, responseEvents, responsesToOpenAIChat } from '../src/translate-responses.js';

/**
 * Another provider at the takeover, for the clouds (E8): a recording made on Bedrock, Vertex AI,
 * Azure OpenAI or the Gemini API answered by a model at an OpenAI-compatible endpoint or Anthropic's
 * API, with the answer back in the cloud's own API.
 */

const same: TakeoverTarget = { route: 'same', scoreBase: null };
const local: TakeoverTarget = { route: 'openai-chat', scoreBase: 'http://127.0.0.1:8000/v1' };
const openai: TakeoverTarget = { route: 'openai-chat', scoreBase: null };
const claude: TakeoverTarget = { route: 'anthropic', scoreBase: null };

const BEDROCK_CLAUDE = 'POST /model/anthropic.claude-sonnet-5-v1%3A0/invoke';
const CONVERSE = 'POST /model/amazon.nova-pro-v1%3A0/converse-stream';
const VERTEX_CLAUDE = 'POST /v1/projects/acme/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:streamRawPredict';
const AZURE = 'POST /openai/deployments/gpt-prod/chat/completions';
const GEMINI = 'POST /v1beta/models/gemini-2.5-flash:streamGenerateContent';

/** A chat completion as an OpenAI-compatible server answers: a tool call, after a local model's thinking. */
const ANSWER = chatCompletionOf(
  {
    id: 'chatcmpl-1',
    choices: [{ message: { role: 'assistant', content: '<think>Policy says escalate.</think>Above the limit.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'escalate', arguments: '{"reason":"refund of $240 is above $100"}' } }] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 120, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } },
  },
  { model: 'my-finetune' },
);

describe('how a recorded call reaches the model under test', () => {
  it('carries every cloud to an endpoint or Anthropic, and refuses another model of the cloud itself', () => {
    expect(takeoverMode('azure', 'openai-chat', local)).toBe('endpoint');
    expect(takeoverMode('azure', 'openai-chat', openai)).toBe('endpoint');
    expect(takeoverMode('azure', 'openai-chat', claude)).toBe('to-anthropic');
    expect(takeoverMode('vertex', 'anthropic', local)).toBe('to-openai');
    expect(takeoverMode('vertex', 'anthropic', claude)).toBe('anthropic-api');
    expect(takeoverMode('bedrock', 'anthropic', claude)).toBe('anthropic-api');
    expect(takeoverMode('bedrock', 'converse', local)).toBe('to-openai');
    expect(takeoverMode('bedrock', 'converse', claude)).toBe('to-anthropic');
    expect(takeoverMode('gemini', 'gemini', local)).toBe('to-openai');
    expect(takeoverMode('vertex', 'gemini', claude)).toBe('to-anthropic');
    expect(takeoverMode('openai', null, claude)).toBeNull();
    expect(takeoverMode('bedrock', 'converse', same)).toBe('same');

    expect(takeoverRefusal('bedrock', CONVERSE, local)).toBeNull();
    expect(takeoverRefusal('bedrock', BEDROCK_CLAUDE, claude)).toBeNull();
    expect(takeoverRefusal('azure', AZURE, same)).toBe('its takeover call goes through Azure OpenAI, where the deployment in the URL picks the model');
    expect(takeoverRefusal('vertex', VERTEX_CLAUDE, same)).toContain('Vertex AI');
    expect(takeoverRefusal('gemini', GEMINI, same)).toBeNull();
    expect(takeoverRefusal('openai', 'POST /v1/responses', local)).toBeNull();
    expect(takeoverRefusal('openai', 'POST /v1/completions', claude)).toBe('it is an openai request (/v1/completions), which only another model of its own provider can answer');
    expect(takeoverRefusal('bedrock', 'POST /model/meta.llama4-maverick-17b-instruct-v1%3A0/invoke', local)).toContain("through Bedrock's InvokeModel");
    expect(takeoverRefusal(null, AZURE, local)).toBe("its recording doesn't say which provider the takeover call went to");
  });

  it('knows the model call among a cloud\'s requests, and when its answer streams', () => {
    expect(isTakeoverCall('bedrock', 'converse', 'POST', '/model/amazon.nova-pro-v1%3A0/converse-stream')).toBe(true);
    expect(isTakeoverCall('bedrock', 'converse', 'POST', '/model/amazon.nova-pro-v1%3A0/count-tokens')).toBe(false);
    expect(isTakeoverCall('vertex', 'anthropic', 'POST', '/v1/projects/acme/locations/us-east5/publishers/anthropic/models/claude-sonnet-5:rawPredict')).toBe(true);
    expect(isTakeoverCall('azure', 'openai-chat', 'GET', '/openai/deployments/gpt-prod/chat/completions')).toBe(false);
    expect(isTakeoverCall('azure', 'openai-chat', 'POST', '/openai/deployments/gpt-prod/embeddings')).toBe(false);
    expect(wantsStream('bedrock', 'converse', '/model/x/converse-stream', {})).toBe(true);
    expect(wantsStream('bedrock', 'converse', '/model/x/converse', { stream: true })).toBe(false);
    expect(wantsStream('bedrock', 'anthropic', '/model/x/invoke-with-response-stream', {})).toBe(true);
    expect(wantsStream('vertex', 'anthropic', '/x:streamRawPredict', { stream: true })).toBe(true);
    expect(wantsStream('gemini', 'gemini', '/v1beta/models/g:streamGenerateContent', {})).toBe(true);
    expect(wantsStream('azure', 'openai-chat', '/openai/deployments/d/chat/completions', { stream: true })).toBe(true);
  });
});

describe('Bedrock Converse', () => {
  const request = {
    system: [{ text: 'You are a support agent.' }, { cachePoint: { type: 'default' } }],
    messages: [
      { role: 'user', content: [{ text: 'Refund order A-1042.' }, { image: { format: 'png', source: { bytes: 'iVBORw0KGgo=' } } }] },
      { role: 'assistant', content: [{ reasoningContent: { reasoningText: { text: 'look it up', signature: 's' } } }, { text: 'Looking it up.' }, { toolUse: { toolUseId: 'tooluse_1', name: 'lookup_order', input: { order_id: 'A-1042' } } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 'tooluse_1', content: [{ json: { amount: 240 } }], status: 'success' } }] },
      { role: 'assistant', content: [{ toolUse: { toolUseId: 'tooluse_2', name: 'read_policy', input: {} } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 'tooluse_2', content: [{ text: 'policy unavailable' }], status: 'error' } }] },
    ],
    toolConfig: { tools: [{ toolSpec: { name: 'escalate', description: 'Hand it to a manager.', inputSchema: { json: { type: 'object', properties: { reason: { type: 'string' } } } } } }], toolChoice: { any: {} } },
    inferenceConfig: { maxTokens: 512, temperature: 0.2, topP: 0.9, stopSequences: ['END'] },
    additionalModelRequestFields: { top_k: 40 },
  };

  it('turns a Converse conversation into OpenAI chat, tool results and errors included, and names what it drops', () => {
    const t = converseToOpenAIChat(request, { model: 'my-finetune' });
    expect(t.body).toEqual({
      model: 'my-finetune',
      messages: [
        { role: 'system', content: 'You are a support agent.' },
        { role: 'user', content: [{ type: 'text', text: 'Refund order A-1042.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] },
        { role: 'assistant', content: 'Looking it up.', tool_calls: [{ id: 'tooluse_1', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"A-1042"}' } }] },
        { role: 'tool', tool_call_id: 'tooluse_1', content: '{"amount":240}' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'tooluse_2', type: 'function', function: { name: 'read_policy', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'tooluse_2', content: 'Error: policy unavailable' },
      ],
      tools: [{ type: 'function', function: { name: 'escalate', description: 'Hand it to a manager.', parameters: { type: 'object', properties: { reason: { type: 'string' } } } } }],
      tool_choice: 'required',
      max_tokens: 512,
      temperature: 0.2,
      top_p: 0.9,
      stop: ['END'],
    });
    expect(t.dropped.sort()).toEqual(['additionalModelRequestFields', 'reasoning blocks']);
  });

  it('answers as a Converse response, or the event stream converse-stream sends', () => {
    const r = chatCompletionToConverse(ANSWER);
    expect(r).toEqual({
      output: { message: { role: 'assistant', content: [{ text: 'Above the limit.' }, { toolUse: { toolUseId: 'call_1', name: 'escalate', input: { reason: 'refund of $240 is above $100' } } }] } },
      stopReason: 'tool_use',
      usage: { inputTokens: 20, outputTokens: 20, totalTokens: 140, cacheReadInputTokens: 100 },
      metrics: { latencyMs: 0 },
    });
    const body = converseStreamBody(r);
    // Every frame's checksums hold, as the AWS SDK checks them.
    expect(eventStreamFrames(body)).not.toBeNull();
    const events = [...eventStreamMessages(body)];
    expect(events.map((e) => e.type)).toEqual(['messageStart', 'contentBlockDelta', 'contentBlockStop', 'contentBlockStart', 'contentBlockDelta', 'contentBlockStop', 'messageStop', 'metadata']);
    expect(events[1]!.payload).toEqual({ contentBlockIndex: 0, delta: { text: 'Above the limit.' } });
    expect(events[3]!.payload).toEqual({ contentBlockIndex: 1, start: { toolUse: { toolUseId: 'call_1', name: 'escalate' } } });
    expect(events[4]!.payload).toEqual({ contentBlockIndex: 1, delta: { toolUse: { input: '{"reason":"refund of $240 is above $100"}' } } });
    expect(events[6]!.payload).toEqual({ stopReason: 'tool_use' });
    expect(events[7]!.payload).toMatchObject({ usage: { inputTokens: 20, outputTokens: 20 } });
  });
});

describe('Gemini generateContent', () => {
  const request = {
    systemInstruction: { parts: [{ text: 'You are a support agent.' }] },
    contents: [
      { role: 'user', parts: [{ text: 'Refund order A-1042.' }] },
      { role: 'model', parts: [{ text: 'thinking it over', thought: true }, { functionCall: { name: 'lookup_order', args: { order_id: 'A-1042' } }, thoughtSignature: 'sig' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'lookup_order', response: { output: '{"amount":240}' } } }] },
      { role: 'model', parts: [{ functionCall: { name: 'read_policy', args: {} } }, { functionCall: { name: 'read_policy', args: { section: 'refunds' } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read_policy', response: { text: 'a' } } }, { functionResponse: { name: 'read_policy', response: { text: 'b' } } }] },
    ],
    tools: [{ functionDeclarations: [{ name: 'escalate', description: 'Hand it to a manager.', parameters: { type: 'object' } }] }, { googleSearch: {} }],
    toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['escalate'] } },
    generationConfig: { maxOutputTokens: 256, temperature: 0, topK: 3, thinkingConfig: { thinkingBudget: 0 } },
  };

  it('turns contents into OpenAI chat, giving calls ids and matching each response to its call in order', () => {
    const t = geminiToOpenAIChat(request, { model: 'my-finetune' });
    const messages = (t.body as { messages: Array<Record<string, unknown>> }).messages;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a support agent.' });
    expect(messages[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_shadowlap_1', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"A-1042"}' } }] });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_shadowlap_1', content: '{"amount":240}' });
    // Two calls of one tool: each response answers the next call of that name.
    expect(messages.slice(5).map((m) => m.tool_call_id)).toEqual(['call_shadowlap_2', 'call_shadowlap_3']);
    expect(messages[6]!.content).toBe('{"text":"b"}');
    expect(t.body).toMatchObject({ tool_choice: { type: 'function', function: { name: 'escalate' } }, max_tokens: 256, temperature: 0, tools: [{ function: { name: 'escalate' } }] });
    expect(t.dropped.sort()).toEqual(['the googleSearch tool', 'the thinking setting', 'thought parts', 'topK']);
    expect(geminiUsesIds(request)).toBe(false);
    expect(geminiUsesIds({ contents: [{ role: 'model', parts: [{ functionCall: { id: 'x', name: 'n' } }] }] })).toBe(true);
  });

  it('answers as a GenerateContentResponse, as server-sent events or a JSON array when streamed', () => {
    const r = chatCompletionToGemini(ANSWER, { model: 'my-finetune' });
    expect(r).toEqual({
      candidates: [{ content: { role: 'model', parts: [{ text: 'Above the limit.' }, { functionCall: { name: 'escalate', args: { reason: 'refund of $240 is above $100' } } }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, totalTokenCount: 140, cachedContentTokenCount: 100 },
      modelVersion: 'my-finetune',
    });
    expect(chatCompletionToGemini(ANSWER, { model: 'm', ids: true }).candidates[0]!.content.parts[1]).toEqual({ functionCall: { name: 'escalate', args: { reason: 'refund of $240 is above $100' }, id: 'call_1' } });
    expect(geminiStreamBody(r, true)).toBe(`data: ${JSON.stringify(r)}\r\n\r\n`);
    expect(JSON.parse(geminiStreamBody(r, false))).toEqual([r]);
  });
});

describe('OpenAI\'s Responses API', () => {
  const request = {
    model: 'gpt-5',
    instructions: 'You are a support agent.',
    input: [
      { role: 'user', content: 'Refund order A-1042.' },
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking it up.' }] },
      { type: 'function_call', call_id: 'call_1', name: 'lookup_order', arguments: '{"order_id":"A-1042"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"amount":240}' },
      { type: 'function_call', call_id: 'call_2', name: 'read_policy', arguments: '{}' },
      { type: 'function_call', call_id: 'call_3', name: 'lookup_customer', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: [{ type: 'input_text', text: 'escalate above $100' }] },
      { type: 'function_call_output', call_id: 'call_3', output: '{"tier":"gold"}' },
    ],
    tools: [{ type: 'function', name: 'escalate', description: 'Hand it to a manager.', parameters: { type: 'object' } }, { type: 'web_search' }],
    tool_choice: 'required',
    parallel_tool_calls: false,
    max_output_tokens: 300,
    text: { format: { type: 'json_schema', name: 'decision', schema: { type: 'object' }, strict: true } },
    reasoning: { effort: 'low' },
  };

  it('turns input items into chat messages, a turn\'s calls together, and names what it drops', () => {
    const t = responsesToOpenAIChat(request, { model: 'my-finetune' });
    expect(t.body).toEqual({
      model: 'my-finetune',
      messages: [
        { role: 'system', content: 'You are a support agent.' },
        { role: 'user', content: 'Refund order A-1042.' },
        { role: 'assistant', content: 'Looking it up.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"A-1042"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"amount":240}' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'read_policy', arguments: '{}' } }, { id: 'call_3', type: 'function', function: { name: 'lookup_customer', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_2', content: 'escalate above $100' },
        { role: 'tool', tool_call_id: 'call_3', content: '{"tier":"gold"}' },
      ],
      tools: [{ type: 'function', function: { name: 'escalate', description: 'Hand it to a manager.', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      parallel_tool_calls: false,
      max_tokens: 300,
      response_format: { type: 'json_schema', json_schema: { name: 'decision', schema: { type: 'object' }, strict: true } },
    });
    expect(t.dropped.sort()).toEqual(['reasoning items', 'the reasoning setting', 'the web_search tool']);
    expect(responsesToOpenAIChat({ input: 'Hi', previous_response_id: 'resp_0' }, { model: 'm' }).dropped).toEqual(["the conversation kept on OpenAI's side (previous_response_id)"]);
  });

  it('answers as a Response, or as the events a streaming client reads, ending in response.completed', () => {
    const r = chatCompletionToResponse(ANSWER, { model: 'my-finetune', request });
    expect(r).toMatchObject({
      object: 'response',
      status: 'completed',
      model: 'my-finetune',
      output: [
        { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Above the limit.', annotations: [] }] },
        { type: 'function_call', call_id: 'call_1', name: 'escalate', arguments: '{"reason":"refund of $240 is above $100"}', status: 'completed' },
      ],
      parallel_tool_calls: false,
      tool_choice: 'required',
      usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 20, total_tokens: 140 },
    });
    const events = responseEvents(r)
      .split('\n\n')
      .filter(Boolean)
      .map((e) => JSON.parse(e.split('\n')[1]!.slice('data: '.length)) as { type: string; sequence_number: number; response?: unknown; delta?: string });
    expect(events.map((e) => e.type)).toEqual([
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
    expect(events.map((e) => e.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)!.response).toEqual(r);
    // Cut short by the token limit: incomplete, and said so.
    const cut = chatCompletionToResponse(chatCompletionOf({ choices: [{ message: { content: 'Above' }, finish_reason: 'length' }] }, { model: 'm' }), { model: 'm' });
    expect(cut).toMatchObject({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    expect(responseEvents(cut)).toContain('event: response.incomplete');
  });

  it('is scored with another model through chat completions, or another of OpenAI\'s as it is', () => {
    expect(takeoverMode('openai', 'openai-responses', local)).toBe('to-openai');
    expect(takeoverMode('openai', 'openai-responses', claude)).toBe('to-anthropic');
    expect(takeoverMode('openai', 'openai-responses', openai)).toBe('same');
    expect(takeoverMode('azure', 'openai-responses', openai)).toBe('to-openai');
    expect(JSON.parse(answerAs('openai', 'openai-responses', ANSWER, { model: 'm', stream: false }).body.toString())).toMatchObject({ object: 'response' });
    expect(answerAs('openai', 'openai-responses', ANSWER, { model: 'm', stream: true }).contentType).toMatch(/^text\/event-stream/);
  });
});

describe('answers in the recording\'s own API', () => {
  it('reads any chat answer: thinking stripped, a tool call always ends the turn as one', () => {
    expect(ANSWER.choices[0]).toMatchObject({ message: { content: 'Above the limit.' }, finish_reason: 'tool_calls' });
    expect(ANSWER.usage).toEqual({ prompt_tokens: 120, completion_tokens: 20, total_tokens: 140, prompt_tokens_details: { cached_tokens: 100 } });
    expect(() => chatCompletionOf({ error: 'x' }, { model: 'm' })).toThrow('not a chat completion');
  });

  it('streams Claude on Bedrock as base64 events in an AWS event stream, and on Vertex AI as Anthropic\'s events', () => {
    const bedrock = answerAs('bedrock', 'anthropic', ANSWER, { model: 'my-finetune', stream: true });
    expect(bedrock.contentType).toBe('application/vnd.amazon.eventstream');
    expect(eventStreamFrames(bedrock.body)).not.toBeNull();
    const events = [...eventStreamMessages(bedrock.body)];
    expect(events.map((e) => e.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
    expect(events[7]!.payload).toMatchObject({ delta: { stop_reason: 'tool_use' } });
    const vertex = answerAs('vertex', 'anthropic', ANSWER, { model: 'my-finetune', stream: true });
    expect(vertex.contentType).toMatch(/^text\/event-stream/);
    expect(vertex.body.toString()).toContain('event: message_stop');
    const plain = JSON.parse(answerAs('bedrock', 'anthropic', ANSWER, { model: 'my-finetune', stream: false }).body.toString()) as Record<string, unknown>;
    expect(plain).toMatchObject({ type: 'message', role: 'assistant', model: 'my-finetune', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Above the limit.' }, { type: 'tool_use', name: 'escalate' }] });
  });

  it('streams OpenAI chat with usage when the client asked for it, and Gemini as its client asked', () => {
    const chunks = answerAs('azure', 'openai-chat', ANSWER, { model: 'my-finetune', stream: true, request: { stream: true, stream_options: { include_usage: true } } }).body.toString();
    expect(chunks).toContain('"usage":{"prompt_tokens":120');
    expect(chunks.trim().endsWith('data: [DONE]')).toBe(true);
    expect(answerAs('gemini', 'gemini', ANSWER, { model: 'm', stream: true, search: '?alt=sse' }).contentType).toMatch(/^text\/event-stream/);
    expect(answerAs('gemini', 'gemini', ANSWER, { model: 'm', stream: true, search: '' }).contentType).toBe('application/json');
    expect(JSON.parse(answerAs('bedrock', 'converse', ANSWER, { model: 'm', stream: false }).body.toString())).toMatchObject({ stopReason: 'tool_use' });
  });

  it('passes an Anthropic API answer to Claude on a cloud as it came, and reports errors as each cloud does', () => {
    const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-good', content: [{ type: 'text', text: 'Escalating.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 3 } };
    expect(JSON.parse(anthropicAnswer('vertex', message, false).body.toString())).toEqual(message);
    expect([...eventStreamMessages(anthropicAnswer('bedrock', message, true).body)].at(-1)!.type).toBe('message_stop');
    const aws = errorAs('bedrock', 'converse', 429, 'slow down');
    expect(aws).toMatchObject({ status: 429, headers: { 'x-amzn-errortype': 'ThrottlingException' } });
    expect(JSON.parse(aws.body.toString())).toEqual({ message: 'slow down' });
    expect(JSON.parse(errorAs('vertex', 'gemini', 404, 'no such model').body.toString())).toEqual({ error: { code: 404, message: 'no such model', status: 'NOT_FOUND' } });
    expect(JSON.parse(errorAs('vertex', 'anthropic', 529, 'busy').body.toString())).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } });
  });

  it('asks Anthropic\'s API for Claude on a cloud in the same shape, without the cloud\'s version field or another model\'s thinking', () => {
    const t = requestFor('anthropic-api', 'anthropic', { anthropic_version: 'bedrock-2023-05-31', max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 50 }, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 's' }, { type: 'text', text: 'ok' }] }] }, { model: 'claude-good' });
    expect(t.body).toEqual({ max_tokens: 100, model: 'claude-good', stream: false, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] });
    expect(t.dropped.sort()).toEqual(['the thinking setting', 'thinking blocks']);
  });
});
