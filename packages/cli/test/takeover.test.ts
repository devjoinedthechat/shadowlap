import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeResponse, Store, storeApiRequest } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { startMockOpenAI, toolCall, turn, type MockServer as OpenAIServer } from '@shadowlap-testing/mock-openai';
import { needsTakeover, resolveTarget, startTakeover, targetVia } from '../src/takeover.js';
import { askedModel } from '../src/tasks.js';

/**
 * The model under test and how a recorded conversation reaches it: what --model, --base-url and
 * --key-env ask for, when a takeover upstream translates, the upstream itself against the mock
 * providers in both directions, and how a score checks which model the takeover call asked.
 */

let anthropic: MockServer;
let openai: OpenAIServer;

beforeAll(async () => {
  anthropic = await startMockAnthropic({ script: () => ({ message: message([text('Above the limit.'), toolUse('escalate', { reason: 'over $100' }, 'toolu_9')]) }), eventDelayMs: () => 0 });
  openai = await startMockOpenAI({ script: () => ({ turn: turn('Above the limit.', { tool_calls: [toolCall('escalate', { reason: 'over $100' })] }) }) });
});
afterAll(async () => {
  await anthropic.close();
  await openai.close();
});

function post(url: string, body: unknown): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => (data += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: data }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const ANTHROPIC_REQUEST = {
  model: 'claude-sonnet-5',
  max_tokens: 256,
  system: 'You are a support agent. Follow the refund policy.',
  tools: [{ name: 'escalate', description: 'Hand the case to a manager.', input_schema: { type: 'object', properties: { reason: { type: 'string' } } } }],
  messages: [
    { role: 'user', content: 'Refund A-1042: $240.' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Policy first.', signature: 's' }, { type: 'tool_use', id: 'toolu_1', name: 'read_policy', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Refunds above $100 need a manager.' }] },
  ],
};

const OPENAI_REQUEST = {
  model: 'gpt-5-mini',
  messages: [
    { role: 'system', content: 'You are a support agent. Follow the refund policy.' },
    { role: 'user', content: 'Refund A-1042: $240.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_policy', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'Refunds above $100 need a manager.' },
  ],
  tools: [{ type: 'function', function: { name: 'escalate', parameters: { type: 'object', properties: { reason: { type: 'string' } } } } }],
};

describe('the model under test', () => {
  it('is the recording\'s provider by name, a provider by prefix, or an OpenAI-compatible endpoint', () => {
    expect(resolveTarget({ model: 'claude-haiku-4-5' }, {})).toMatchObject({ model: 'claude-haiku-4-5', route: 'same', baseUrl: null, scoreBase: null, local: false });
    expect(resolveTarget({ model: 'anthropic:claude-haiku-4-5' }, {})).toMatchObject({ model: 'claude-haiku-4-5', route: 'anthropic', baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY', via: 'Anthropic API' });
    expect(resolveTarget({ model: 'openai:gpt-5-mini' }, {})).toMatchObject({ model: 'gpt-5-mini', route: 'openai-chat', baseUrl: 'https://api.openai.com/v1', scoreBase: null, via: 'OpenAI API' });
    // OpenAI's upstream pointed at a server on this machine: it is scored as that endpoint, not as OpenAI.
    expect(resolveTarget({ model: 'openai:qwen' }, { SHADOWLAP_UPSTREAM_OPENAI: 'http://127.0.0.1:11434' })).toMatchObject({ baseUrl: 'http://127.0.0.1:11434/v1', scoreBase: 'http://127.0.0.1:11434/v1', local: true });
    expect(resolveTarget({ model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1/' })).toMatchObject({ model: 'my-finetune', route: 'openai-chat', baseUrl: 'http://127.0.0.1:8000/v1', keyEnv: null, local: true, scoreBase: 'http://127.0.0.1:8000/v1', via: 'on this machine' });
    expect(resolveTarget({ model: 'gpt-5-mini', baseUrl: 'https://api.openai.com/v1' })).toMatchObject({ keyEnv: 'OPENAI_API_KEY', local: false, via: 'OpenAI API' });
    expect(resolveTarget({ model: 'm', baseUrl: 'https://gpu.example.com/v1', keyEnv: 'VLLM_API_KEY' })).toMatchObject({ keyEnv: 'VLLM_API_KEY', local: false, via: 'gpu.example.com' });
    expect(() => resolveTarget({ model: 'm; rm -rf /' })).toThrow('is not a model name');
    expect(() => resolveTarget({ model: 'm', baseUrl: 'not a url' })).toThrow('--base-url must be a URL');
    expect(() => resolveTarget({ model: 'm', baseUrl: 'ftp://host/v1' })).toThrow('http or https');
    expect(() => resolveTarget({ model: 'm', keyEnv: 'NOT-A-NAME' })).toThrow('--key-env');
    expect(targetVia(resolveTarget({ model: 'm' }, {}), 'anthropic')).toBe('Anthropic API');
  });

  it('needs a takeover upstream only when the model speaks another API than the recording, or lives elsewhere', () => {
    const same = resolveTarget({ model: 'claude-haiku-4-5' }, {});
    const claude = resolveTarget({ model: 'anthropic:claude-haiku-4-5' }, {});
    const gpt = resolveTarget({ model: 'openai:gpt-5-mini' }, {});
    const local = resolveTarget({ model: 'qwen', baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(needsTakeover('anthropic', same, 'anthropic')).toBe(false);
    expect(needsTakeover('anthropic', claude, 'anthropic')).toBe(false);
    expect(needsTakeover('openai-chat', claude, 'openai')).toBe(true);
    expect(needsTakeover('openai-chat', gpt, 'openai')).toBe(false);
    expect(needsTakeover('openai-chat', local, 'openai')).toBe(true);
    expect(needsTakeover('anthropic', local, 'anthropic')).toBe(true);
  });
});

describe('the takeover upstream', () => {
  it('asks an OpenAI-compatible model an Anthropic conversation, and answers as Anthropic, streamed or not', async () => {
    const before = openai.requests.length;
    const t = await startTakeover('anthropic', resolveTarget({ model: 'my-finetune', baseUrl: `${openai.url}/v1` }), {});
    try {
      const plain = await post(`${t.url}/v1/messages`, ANTHROPIC_REQUEST);
      expect(plain.status).toBe(200);
      expect(JSON.parse(plain.body)).toMatchObject({ type: 'message', role: 'assistant', model: 'my-finetune', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Above the limit.' }, { type: 'tool_use', name: 'escalate', input: { reason: 'over $100' } }] });
      const streamed = await post(`${t.url}/v1/messages`, { ...ANTHROPIC_REQUEST, stream: true });
      expect(streamed.type).toContain('text/event-stream');
      const parsed = normalizeResponse(Buffer.from(streamed.body), streamed.type, [], 'anthropic');
      expect(parsed.blocks).toEqual([{ type: 'text', text: 'Above the limit.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'over $100' } }]);
      expect(parsed.stopReason).toBe('tool_use');

      const asked = openai.requests.slice(before);
      expect(asked).toHaveLength(2);
      const body = asked[0]!.body as { model: string; stream: boolean; messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>; tools: unknown[] };
      expect(body).toMatchObject({ model: 'my-finetune', stream: false, max_tokens: 256 });
      expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
      // Thinking is bound to the model that wrote it: it is dropped, and the tool call stays.
      expect(JSON.stringify(body.messages)).not.toContain('Policy first.');
      expect(t.dropped).toEqual(new Set(['thinking blocks']));
      expect(t.answered).toBe(2);
    } finally {
      await t.close();
    }
  });

  it('asks an Anthropic model an OpenAI conversation, and answers as a chat completion, streamed or not', async () => {
    const before = anthropic.requests.length;
    const t = await startTakeover('openai-chat', resolveTarget({ model: 'anthropic:claude-good' }, { SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url }), { ANTHROPIC_API_KEY: 'test-key' });
    try {
      const plain = await post(`${t.url}/v1/chat/completions`, OPENAI_REQUEST);
      expect(plain.status).toBe(200);
      const completion = JSON.parse(plain.body) as { choices: Array<{ message: { content: string; tool_calls: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }>; usage: { prompt_tokens: number } };
      expect(completion.choices[0]!.message.content).toBe('Above the limit.');
      expect(completion.choices[0]!.message.tool_calls[0]!.function).toEqual({ name: 'escalate', arguments: '{"reason":"over $100"}' });
      expect(completion.choices[0]!.finish_reason).toBe('tool_calls');
      expect(completion.usage.prompt_tokens).toBeGreaterThan(0);
      const streamed = await post(`${t.url}/v1/chat/completions`, { ...OPENAI_REQUEST, stream: true, stream_options: { include_usage: true } });
      expect(streamed.type).toContain('text/event-stream');
      const parsed = normalizeResponse(Buffer.from(streamed.body), streamed.type, [], 'openai');
      expect(parsed.blocks).toEqual([{ type: 'text', text: 'Above the limit.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'over $100' } }]);
      expect(streamed.body.trim().endsWith('data: [DONE]')).toBe(true);

      const asked = anthropic.requests.slice(before);
      expect(asked).toHaveLength(2);
      expect(asked[0]!.headers['x-api-key']).toBe('test-key');
      expect(asked[0]!.body).toMatchObject({ model: 'claude-good', system: 'You are a support agent. Follow the refund policy.', stream: false });
      expect(asked[0]!.body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    } finally {
      await t.close();
    }
  });

  it('answers in the recording\'s error shape when the model can\'t be reached, and refuses anything but its own path', async () => {
    const closed: Server = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const t = await startTakeover('anthropic', resolveTarget({ model: 'my-finetune', baseUrl: `http://127.0.0.1:${port}/v1` }), {});
    try {
      const down = await post(`${t.url}/v1/messages`, ANTHROPIC_REQUEST);
      expect(down.status).toBe(502);
      expect(JSON.parse(down.body)).toMatchObject({ type: 'error', error: { type: 'api_error', message: expect.stringContaining("isn't reachable") } });
      const elsewhere = await post(t.url.replace(/\/t\/[0-9a-f]+$/, '/t/0000/v1/messages'), ANTHROPIC_REQUEST);
      expect(elsewhere.status).toBe(404);
    } finally {
      await t.close();
    }
    // A paid API without its key is refused before anything is sent.
    await expect(startTakeover('openai-chat', resolveTarget({ model: 'anthropic:claude-good' }, {}), {})).rejects.toThrow('ANTHROPIC_API_KEY is not set');
  });
});

describe('which model a takeover call asked', () => {
  it('reads the model a request named, in its URL first and else in its body', () => {
    const store = Store.open(':memory:');
    const ref = storeApiRequest(store, { model: 'claude-haiku-4-5', messages: [] });
    expect(askedModel(store, { name: 'POST /v1/messages', requestRef: ref })).toBe('claude-haiku-4-5');
    const gemini = storeApiRequest(store, { contents: [] });
    expect(askedModel(store, { name: 'POST /v1beta/models/gemini-2.5-flash:generateContent', requestRef: gemini })).toBe('gemini-2.5-flash');
    expect(askedModel(store, { name: 'POST /model/anthropic.claude-sonnet-5-v1%3A0/converse', requestRef: gemini })).toBe('anthropic.claude-sonnet-5-v1:0');
    // Azure's deployment decides the model, whatever the body says.
    expect(askedModel(store, { name: 'POST /openai/deployments/gpt-prod/chat/completions', requestRef: ref })).toBe('gpt-prod');
    expect(askedModel(store, { name: 'POST /v1/messages', requestRef: gemini })).toBeNull();
    expect(askedModel(store, { name: 'POST /v1/messages', requestRef: null })).toBeNull();
    store.close();
  });
});
