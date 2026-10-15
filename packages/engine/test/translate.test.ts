import { describe, expect, it } from 'vitest';
import { normalizeResponse } from '../src/responses.js';
import {
  anthropicMessageEvents,
  anthropicMessageToOpenAIChat,
  anthropicToOpenAIChat,
  chatCompletionChunks,
  chatShapeOf,
  errorBody,
  errorMessage,
  openAIChatToAnthropic,
  openAIChatToAnthropicMessage,
  openAITools,
  untranslatable,
} from '../src/translate.js';

/**
 * Another provider at the takeover: a recorded Anthropic conversation asked of an OpenAI-compatible
 * model, its answer handed back as Anthropic's, and the reverse.
 */

const anthropicRequest = {
  model: 'claude-sonnet-5',
  max_tokens: 512,
  stream: true,
  top_k: 5,
  temperature: 0.4,
  stop_sequences: ['</done>'],
  system: [{ type: 'text', text: 'You are a support agent.', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'Follow the refund policy.' }],
  tools: [
    { name: 'lookup_order', description: 'Look an order up.', input_schema: { type: 'object', properties: { order_id: { type: 'string' } } } },
    { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
  ],
  tool_choice: { type: 'any', disable_parallel_tool_use: true },
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Refund A-1042, please.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'The policy matters here.', signature: 'abc' },
        { type: 'text', text: 'Looking it up.' },
        { type: 'tool_use', id: 'toolu_01A', name: 'lookup_order', input: { order_id: 'A-1042' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01A', content: [{ type: 'text', text: '{"amount":240}' }] }, { type: 'text', text: 'Be quick.' }] },
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'zzz' }, { type: 'tool_use', id: 'toolu_01B', name: 'lookup_order', input: { order_id: 'A-1043' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01B', content: 'not found', is_error: true }] },
    { role: 'system', content: 'Prefer escalating.' },
  ],
};

describe('Anthropic to OpenAI chat', () => {
  it('carries the system prompt, messages, tool calls and results, and drops thinking', () => {
    const { body, dropped } = anthropicToOpenAIChat(anthropicRequest, { model: 'qwen2.5:7b' });
    expect(body.model).toBe('qwen2.5:7b');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a support agent.\nFollow the refund policy.' },
      { role: 'user', content: [{ type: 'text', text: 'Refund A-1042, please.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBOR' } }] },
      { role: 'assistant', content: 'Looking it up.', tool_calls: [{ id: 'toolu_01A', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"A-1042"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_01A', content: '{"amount":240}' },
      { role: 'user', content: 'Be quick.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_01B', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"A-1043"}' } }] },
      { role: 'tool', tool_call_id: 'toolu_01B', content: 'Error: not found' },
      { role: 'system', content: 'Prefer escalating.' },
    ]);
    expect(body.tools).toEqual([{ type: 'function', function: { name: 'lookup_order', description: 'Look an order up.', parameters: { type: 'object', properties: { order_id: { type: 'string' } } } } }]);
    expect(body).toMatchObject({ tool_choice: 'required', parallel_tool_calls: false, max_tokens: 512, temperature: 0.4, stop: ['</done>'] });
    expect(body.stream).toBeUndefined();
    expect(dropped.sort()).toEqual(['the web_search tool', 'thinking blocks', 'top_k']);
    expect(anthropicToOpenAIChat({ ...anthropicRequest, tool_choice: { type: 'tool', name: 'lookup_order' } }, { maxTokensField: 'max_completion_tokens' }).body).toMatchObject({ model: 'claude-sonnet-5', max_completion_tokens: 512, tool_choice: { type: 'function', function: { name: 'lookup_order' } } });
  });

  it('turns the chat answer back into the message the Anthropic SDK reads, as JSON or as a stream', () => {
    const completion = {
      id: 'chatcmpl-9x',
      object: 'chat.completion',
      model: 'qwen2.5:7b',
      choices: [{ index: 0, message: { role: 'assistant', content: '<think>escalate, surely</think>\nAbove the limit.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'escalate', arguments: '{"reason":"over $100"}' } }] }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1200, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 200 } },
    };
    const message = openAIChatToAnthropicMessage(completion, { model: 'qwen2.5:7b' });
    expect(message).toEqual({
      id: 'msg_chatcmpl-9x',
      type: 'message',
      role: 'assistant',
      model: 'qwen2.5:7b',
      content: [{ type: 'text', text: 'Above the limit.' }, { type: 'tool_use', id: 'call_1', name: 'escalate', input: { reason: 'over $100' } }],
      // A server that says "stop" after calling a tool would end the agent's loop.
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1000, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 200 },
    });

    const sse = anthropicMessageEvents(message);
    const parsed = normalizeResponse(Buffer.from(sse), 'text/event-stream', [], 'anthropic');
    expect(parsed.blocks).toEqual([{ type: 'text', text: 'Above the limit.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'over $100' } }]);
    expect(parsed.stopReason).toBe('tool_use');
    expect(sse).toContain('"output_tokens":30');
    expect(sse.indexOf('message_start')).toBeLessThan(sse.indexOf('message_stop'));

    const plain = openAIChatToAnthropicMessage({ choices: [{ message: { content: 'Done.' }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }, { model: 'm' });
    expect(plain).toMatchObject({ content: [{ type: 'text', text: 'Done.' }], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 2 } });
    // Broken JSON arguments are still a call; the agent gets what the model wrote.
    const broken = openAIChatToAnthropicMessage({ choices: [{ message: { content: null, tool_calls: [{ function: { name: 'escalate', arguments: '{"reason":' } }] }, finish_reason: 'tool_calls' }] }, { model: 'm' });
    expect(broken.content[0]).toMatchObject({ type: 'tool_use', name: 'escalate', input: { arguments: '{"reason":' } });
    expect((broken.content[0] as { id: string }).id).toMatch(/^toolu_shadowlap_/);
  });
});

describe('OpenAI chat to Anthropic', () => {
  it('folds system messages into the system prompt and tool results into user turns', () => {
    const { body, dropped } = openAIChatToAnthropic(
      {
        model: 'gpt-5-mini',
        temperature: 1.5,
        max_completion_tokens: 300,
        parallel_tool_calls: false,
        tool_choice: 'auto',
        seed: 7,
        tools: [{ type: 'function', function: { name: 'lookup_order', description: 'Look an order up.', parameters: { type: 'object', properties: {} } } }],
        messages: [
          { role: 'developer', content: 'You are a support agent.' },
          { role: 'user', content: [{ type: 'text', text: 'Refund A-1042.' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } }] },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"order_id":"A-1042"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', content: '{"amount":240}' },
          { role: 'user', content: 'And be quick.' },
        ],
      },
      { model: 'claude-haiku-4-5' },
    );
    expect(body).toEqual({
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: 'You are a support agent.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Refund A-1042.' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'lookup_order', input: { order_id: 'A-1042' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"amount":240}' }, { type: 'text', text: 'And be quick.' }] },
      ],
      tools: [{ name: 'lookup_order', description: 'Look an order up.', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      temperature: 1,
    });
    expect(dropped).toEqual(['seed']);
  });

  it('turns the Anthropic answer into a chat completion, as JSON or as chunks', () => {
    const message = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Escalating.' }, { type: 'tool_use', id: 'toolu_1', name: 'escalate', input: { reason: 'over' } }], stop_reason: 'tool_use', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } };
    const completion = anthropicMessageToOpenAIChat(message, { model: 'claude-haiku-4-5' });
    expect(completion.choices[0]).toEqual({ index: 0, message: { role: 'assistant', content: 'Escalating.', tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'escalate', arguments: '{"reason":"over"}' } }], refusal: null }, finish_reason: 'tool_calls', logprobs: null });
    expect(completion.usage).toEqual({ prompt_tokens: 150, completion_tokens: 20, total_tokens: 170, prompt_tokens_details: { cached_tokens: 50 } });
    const chunks = chatCompletionChunks(completion, { includeUsage: true });
    const parsed = normalizeResponse(Buffer.from(chunks), 'text/event-stream', [], 'openai');
    expect(parsed.blocks).toEqual([{ type: 'text', text: 'Escalating.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'over' } }]);
    expect(parsed.stopReason).toBe('tool_calls');
    expect(chunks.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(chunks).toContain('"prompt_tokens":150');
  });
});

describe('what can be translated', () => {
  it('knows the APIs it carries and says why it refuses the others', () => {
    expect(chatShapeOf('anthropic', 'POST /v1/messages')).toBe('anthropic');
    expect(chatShapeOf('openai', 'POST /v1/chat/completions')).toBe('openai-chat');
    expect(chatShapeOf('openai', 'POST /v1/responses')).toBeNull();
    expect(chatShapeOf('gemini', 'POST /v1beta/models/gemini-2.5-flash:generateContent')).toBeNull();
    expect(untranslatable('openai', 'POST /v1/responses')).toBe('it uses the OpenAI Responses API');
    expect(untranslatable('gemini', 'POST /v1beta/models/x:streamGenerateContent')).toBe('it uses the Gemini API');
    expect(untranslatable('bedrock', 'POST /model/x/converse')).toBe('it goes through Amazon Bedrock');
    expect(untranslatable('openai', 'POST /v1/completions')).toBe('it is an openai request (/v1/completions)');
    expect(untranslatable('mistral', 'POST /v1/fim/completions')).toBe('it is a mistral request (/v1/fim/completions)');
  });

  it('reads tool definitions from every provider shape', () => {
    expect(openAITools({ tools: [{ name: 'a', input_schema: { type: 'object' } }, { type: 'function', function: { name: 'b', parameters: { type: 'object' } } }, { type: 'function', name: 'c', parameters: { type: 'object' } }, { functionDeclarations: [{ name: 'd', description: 'D' }] }, { type: 'web_search_20250305', name: 'web_search' }], toolConfig: { tools: [{ toolSpec: { name: 'e', inputSchema: { json: { type: 'object' } } } }] } }).map((t) => t.function.name)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('reports errors in the shape the client speaks', () => {
    expect(errorBody('anthropic', 429, 'slow down')).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    expect(errorBody('anthropic', 503, 'down')).toEqual({ type: 'error', error: { type: 'api_error', message: 'down' } });
    expect(errorBody('openai-chat', 400, 'bad')).toEqual({ error: { message: 'bad', type: 'invalid_request_error', param: null, code: null } });
    expect(errorMessage({ error: 'model "x" not found, try pulling it first' }, '?')).toBe('model "x" not found, try pulling it first');
    expect(errorMessage({ error: { message: 'Incorrect API key' } }, '?')).toBe('Incorrect API key');
    expect(errorMessage(null, 'HTTP 500')).toBe('HTTP 500');
  });
});
