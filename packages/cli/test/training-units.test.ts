import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gateResult, normalizeResponse, Store, type CallRecord, type TaskScoreRow, type TestFailure, type TestResultData } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { functionCall, startMockGemini, turn as geminiTurn, type MockServer as GeminiServer } from '@shadowlap-testing/mock-gemini';
import { startMockOpenAI, toolCall, turn, type MockServer as OpenAIServer } from '@shadowlap-testing/mock-openai';
import { parseTests } from '../src/checks.js';
import { volatileWarning } from '../src/golden-update.js';
import { keptLine, replayedBefore } from '../src/commands/training.js';
import { ANSWERED_BY, modelUnswitchable, resolveTarget, startTakeover, switchModel, takeoverMode, targetVia } from '../src/takeover.js';
import { addJudge, answeredBy, attemptCost, cannotScore, keepScores, lastResults, lastTest, taskChecks, type LoadedTask, type TaskScore } from '../src/tasks.js';

/**
 * The CLI's training parts on their own: the task block under tests, the model under test and how a
 * recorded conversation reaches it (what --model, --base-url and --key-env ask for, how a takeover
 * upstream asks it, the upstream itself against the mock providers: another model of the same
 * provider, and a translation in both directions), and how a score knows the model under test
 * answered and what it cost.
 */

let anthropic: MockServer;
let openai: OpenAIServer;
let gemini: GeminiServer;

beforeAll(async () => {
  anthropic = await startMockAnthropic({ script: () => ({ message: message([text('Above the limit.'), toolUse('escalate', { reason: 'over $100' }, 'toolu_9')]) }), eventDelayMs: () => 0 });
  openai = await startMockOpenAI({ script: () => ({ turn: turn('Above the limit.', { tool_calls: [toolCall('escalate', { reason: 'over $100' })] }) }) });
  gemini = await startMockGemini({ script: () => ({ turn: geminiTurn('Above the limit.', { functionCalls: [functionCall('escalate', { reason: 'over $100' })] }) }) });
});
afterAll(async () => {
  await anthropic.close();
  await openai.close();
  await gemini.close();
});

interface Reply {
  status: number;
  type: string;
  body: string;
  headers: IncomingHttpHeaders;
}

function post(url: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => (data += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : JSON.stringify(body));
  });
}

/** A provider, as a fake that says what it was sent and answers each path as that provider would. */
async function fakeProvider(): Promise<{ url: string; seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }>; close: () => Promise<void> }> {
  const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const asked = (() => {
        try {
          return (JSON.parse(body) as { model?: string }).model;
        } catch {
          return undefined;
        }
      })();
      const answer = req.url?.includes('count_tokens') ? { input_tokens: 42 } : req.url?.includes('embeddings') ? { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }] } : req.url?.includes('/responses') ? { id: 'resp_1', object: 'response', model: asked, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Escalating.' }] }], usage: { input_tokens: 900, output_tokens: 20 } } : { data: [{ id: 'gpt-5-mini' }] };
      res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_1' });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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

describe('the task block under tests', () => {
  it('is checked wherever tests are read, so shadowlap test and doctor report a mistake in it', () => {
    expect(parseTests({ 'goldens/a': { expect: { tools: { escalate: 1 } }, task: { takeover: 5, why: 'decides', rewards: 'escalate above the limit' } } })).toHaveLength(1);
    expect(() => parseTests({ 'goldens/a': { task: { takeover: 'five' } } })).toThrow('shadowlap.config.json: tests["goldens/a"].task.takeover must be a model call number');
    expect(() => parseTests({ 'goldens/a': { task: { teaches: 'x' } } })).toThrow('has an unknown key "teaches"');
  });

  it('scores the outcome checks, and lists token and cost budgets as caps', () => {
    const [entry] = parseTests({ 'goldens/a': { expect: { tools: { issue_refund: 0 }, modelCalls: '<= 12', inputTokens: '<= 60000', cost: '<= 0.05' } } });
    expect(taskChecks(entry.spec)).toEqual([
      { label: 'issue_refund called 0 times', cap: false },
      { label: 'at most 12 model calls', cap: false },
      { label: 'at most 60000 input tokens', cap: true },
      { label: 'cost at most $0.05', cap: true },
    ]);
    expect(taskChecks(null)).toEqual([]);
  });
});

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
    // A key in the URL would be kept with the scores and the runs: it belongs in the environment.
    expect(() => resolveTarget({ model: 'm', baseUrl: 'https://user:secret@gpu.example.com/v1' })).toThrow('--base-url must not carry credentials');
    expect(() => resolveTarget({ model: 'm', baseUrl: 'https://:secret@gpu.example.com/v1' })).toThrow('must not carry credentials');
    expect(targetVia(resolveTarget({ model: 'm' }, {}), 'anthropic')).toBe('Anthropic API');
  });

  it('is asked the recording\'s own way when it is the same provider, and through a translation when it isn\'t', () => {
    const same = resolveTarget({ model: 'claude-haiku-4-5' }, {});
    const claude = resolveTarget({ model: 'anthropic:claude-haiku-4-5' }, {});
    const gpt = resolveTarget({ model: 'openai:gpt-5-mini' }, {});
    const local = resolveTarget({ model: 'qwen', baseUrl: 'http://127.0.0.1:11434/v1' });
    expect(takeoverMode('anthropic', 'anthropic', same)).toBe('same');
    expect(takeoverMode('gemini', null, same)).toBe('same');
    expect(takeoverMode('anthropic', 'anthropic', claude)).toBe('same');
    expect(takeoverMode('openai', 'openai-chat', claude)).toBe('to-anthropic');
    expect(takeoverMode('openai', 'openai-chat', gpt)).toBe('same');
    expect(takeoverMode('openai', null, gpt)).toBe('same'); // the Responses API, asked for another model of OpenAI's
    expect(takeoverMode('openai', 'openai-chat', local)).toBe('endpoint');
    expect(takeoverMode('anthropic', 'anthropic', local)).toBe('to-openai');
    expect(takeoverMode('anthropic', 'anthropic', gpt)).toBe('to-openai');
    expect(takeoverMode('gemini', null, local)).toBeNull();
    expect(takeoverMode('openai', null, claude)).toBeNull();
  });

  it('is named in the request of the recording\'s own API: its model field, or its URL', () => {
    expect(switchModel('anthropic', 'POST', '/v1/messages', 'm')).toEqual({ path: '/v1/messages', field: true });
    expect(switchModel('anthropic', 'POST', '/v1/messages/count_tokens', 'm')).toBeNull();
    expect(switchModel('anthropic', 'GET', '/v1/models', 'm')).toBeNull();
    expect(switchModel('openai', 'POST', '/v1/responses', 'm')).toEqual({ path: '/v1/responses', field: true });
    expect(switchModel('openai', 'POST', '/v1/embeddings', 'm')).toBeNull();
    expect(switchModel('gemini', 'POST', '/v1beta/models/gemini-2.5-flash:streamGenerateContent', 'gemini-2.5-pro')).toEqual({ path: '/v1beta/models/gemini-2.5-pro:streamGenerateContent', field: false });
    expect(switchModel('gemini', 'POST', '/v1beta/models/gemini-2.5-flash:generateContent', 'tunedModels/refunds-7')).toEqual({ path: '/v1beta/tunedModels/refunds-7:generateContent', field: false });
    expect(switchModel('gemini', 'POST', '/v1beta/models/text-embedding-004:embedContent', 'm')).toBeNull();
    expect(modelUnswitchable('bedrock', 'POST /model/anthropic.claude-sonnet-5-v1%3A0/converse')).toContain('Amazon Bedrock');
    expect(modelUnswitchable('vertex', 'POST /v1/projects/p/locations/l/publishers/google/models/gemini-2.5-flash:generateContent')).toContain('Vertex AI');
    expect(modelUnswitchable('azure', 'POST /openai/deployments/gpt-prod/chat/completions')).toContain('the deployment in the URL picks the model');
    expect(modelUnswitchable('anthropic', 'POST /v1/messages')).toBeNull();
    expect(modelUnswitchable('openai', 'POST /v1/responses')).toBeNull();
  });
});

describe('the takeover upstream', () => {
  it('asks an OpenAI-compatible model an Anthropic conversation, and answers as Anthropic, streamed or not', async () => {
    const before = openai.requests.length;
    const t = await startTakeover({ provider: 'anthropic', shape: 'anthropic', mode: 'to-openai' }, resolveTarget({ model: 'my-finetune', baseUrl: `${openai.url}/v1` }), { env: {} });
    try {
      const plain = await post(`${t.url}/v1/messages`, ANTHROPIC_REQUEST);
      expect(plain.status).toBe(200);
      expect(plain.headers[ANSWERED_BY]).toBe('my-finetune');
      expect(JSON.parse(plain.body)).toMatchObject({ type: 'message', role: 'assistant', model: 'my-finetune', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Above the limit.' }, { type: 'tool_use', name: 'escalate', input: { reason: 'over $100' } }] });
      const streamed = await post(`${t.url}/v1/messages`, { ...ANTHROPIC_REQUEST, stream: true });
      expect(streamed.type).toContain('text/event-stream');
      const parsed = normalizeResponse(Buffer.from(streamed.body), streamed.type, [], 'anthropic');
      expect(parsed.blocks).toEqual([{ type: 'text', text: 'Above the limit.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'over $100' } }]);
      expect(parsed.stopReason).toBe('tool_use');

      const asked = openai.requests.slice(before);
      expect(asked).toHaveLength(2);
      const body = asked[0].body as { model: string; stream: boolean; messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[] }>; tools: unknown[] };
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
    const t = await startTakeover({ provider: 'openai', shape: 'openai-chat', mode: 'to-anthropic' }, resolveTarget({ model: 'anthropic:claude-good' }, { SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url }), { env: { ANTHROPIC_API_KEY: 'test-key' } });
    try {
      const plain = await post(`${t.url}/v1/chat/completions`, OPENAI_REQUEST);
      expect(plain.status).toBe(200);
      expect(plain.headers[ANSWERED_BY]).toBe('claude-good');
      const completion = JSON.parse(plain.body) as { choices: Array<{ message: { content: string; tool_calls: Array<{ function: { name: string; arguments: string } }> }; finish_reason: string }>; usage: { prompt_tokens: number } };
      expect(completion.choices[0].message.content).toBe('Above the limit.');
      expect(completion.choices[0].message.tool_calls[0].function).toEqual({ name: 'escalate', arguments: '{"reason":"over $100"}' });
      expect(completion.choices[0].finish_reason).toBe('tool_calls');
      expect(completion.usage.prompt_tokens).toBeGreaterThan(0);
      const streamed = await post(`${t.url}/v1/chat/completions`, { ...OPENAI_REQUEST, stream: true, stream_options: { include_usage: true } });
      expect(streamed.type).toContain('text/event-stream');
      const parsed = normalizeResponse(Buffer.from(streamed.body), streamed.type, [], 'openai');
      expect(parsed.blocks).toEqual([{ type: 'text', text: 'Above the limit.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'over $100' } }]);
      expect(streamed.body.trim().endsWith('data: [DONE]')).toBe(true);

      const asked = anthropic.requests.slice(before);
      expect(asked).toHaveLength(2);
      expect(asked[0].headers['x-api-key']).toBe('test-key');
      expect(asked[0].body).toMatchObject({ model: 'claude-good', system: 'You are a support agent. Follow the refund policy.', stream: false });
      expect(asked[0].body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    } finally {
      await t.close();
    }
  });

  it('answers in the recording\'s error shape when the model can\'t be reached, and refuses anything but its own path', async () => {
    const closed: Server = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const t = await startTakeover({ provider: 'anthropic', shape: 'anthropic', mode: 'to-openai' }, resolveTarget({ model: 'my-finetune', baseUrl: `http://127.0.0.1:${port}/v1` }), { env: {} });
    try {
      const down = await post(`${t.url}/v1/messages`, ANTHROPIC_REQUEST);
      expect(down.status).toBe(502);
      // Asked, and unanswered: the store records the model that was asked.
      expect(down.headers[ANSWERED_BY]).toBe('my-finetune');
      expect(JSON.parse(down.body)).toMatchObject({ type: 'error', error: { type: 'api_error', message: expect.stringContaining("isn't reachable") } });
      const elsewhere = await post(t.url.replace(/\/t\/[0-9a-f]+$/, '/t/0000/v1/messages'), ANTHROPIC_REQUEST);
      expect(elsewhere.status).toBe(404);
    } finally {
      await t.close();
    }
    // A paid API without its key is refused before anything is sent.
    await expect(startTakeover({ provider: 'openai', shape: 'openai-chat', mode: 'to-anthropic' }, resolveTarget({ model: 'anthropic:claude-good' }, {}), { env: {} })).rejects.toThrow('ANTHROPIC_API_KEY is not set');
    // Another model of the recording's provider needs somewhere to send it.
    await expect(startTakeover({ provider: 'anthropic', shape: 'anthropic', mode: 'same' }, resolveTarget({ model: 'claude-haiku-4-5' }, {}), { env: {} })).rejects.toThrow("there is nowhere to send anthropic's calls to claude-haiku-4-5");
  });

  it('asks another model of the recording\'s provider: the request names it, the agent\'s own key goes with it, and the answer streams back as it came', async () => {
    const before = anthropic.requests.length;
    const t = await startTakeover({ provider: 'anthropic', shape: 'anthropic', mode: 'same' }, resolveTarget({ model: 'claude-haiku-4-5' }, {}), { env: {}, upstream: anthropic.url });
    try {
      const plain = await post(`${t.url}/v1/messages`, ANTHROPIC_REQUEST, { 'x-api-key': 'agent-key', 'anthropic-version': '2023-06-01' });
      expect(plain.status).toBe(200);
      expect(plain.headers[ANSWERED_BY]).toBe('claude-haiku-4-5');
      const streamed = await post(`${t.url}/v1/messages`, { ...ANTHROPIC_REQUEST, stream: true }, { 'x-api-key': 'agent-key' });
      expect(streamed.type).toContain('text/event-stream');
      expect(normalizeResponse(Buffer.from(streamed.body), streamed.type, [], 'anthropic').blocks).toEqual([{ type: 'text', text: 'Above the limit.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'over $100' } }]);
      const asked = anthropic.requests.slice(before);
      expect(asked.map((r) => [r.body.model, r.headers['x-api-key']])).toEqual([
        ['claude-haiku-4-5', 'agent-key'],
        ['claude-haiku-4-5', 'agent-key'],
      ]);
      // Nothing else in the request changes: thinking stays, since the provider reads it.
      expect(JSON.stringify(asked[0].body.messages)).toContain('Policy first.');
      expect(t.answered).toBe(2);
      expect(t.dropped.size).toBe(0);
    } finally {
      await t.close();
    }
  });

  it('asks another OpenAI model through the Responses API, and another Gemini model by its URL', async () => {
    const provider = await fakeProvider();
    const responses = await startTakeover({ provider: 'openai', shape: null, mode: 'same' }, resolveTarget({ model: 'gpt-5-mini' }, {}), { env: {}, upstream: provider.url });
    const before = gemini.requests.length;
    const g = await startTakeover({ provider: 'gemini', shape: null, mode: 'same' }, resolveTarget({ model: 'gemini-2.5-pro' }, {}), { env: {}, upstream: gemini.url });
    try {
      const r = await post(`${responses.url}/v1/responses`, { model: 'gpt-5', input: [{ role: 'user', content: 'Refund A-1042: $240.' }] }, { authorization: 'Bearer agent-key' });
      expect(r.status).toBe(200);
      expect(r.headers[ANSWERED_BY]).toBe('gpt-5-mini');
      expect(provider.seen[0]).toMatchObject({ method: 'POST', url: '/v1/responses', headers: { authorization: 'Bearer agent-key' } });
      expect(JSON.parse(provider.seen[0].body)).toEqual({ model: 'gpt-5-mini', input: [{ role: 'user', content: 'Refund A-1042: $240.' }] });

      const answer = await post(`${g.url}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`, { contents: [{ role: 'user', parts: [{ text: 'Refund A-1042: $240.' }] }] }, { 'x-goog-api-key': 'agent-key' });
      expect(answer.status).toBe(200);
      expect(answer.headers[ANSWERED_BY]).toBe('gemini-2.5-pro');
      expect(normalizeResponse(Buffer.from(answer.body), answer.type, [], 'gemini').blocks).toEqual([{ type: 'text', text: 'Above the limit.' }, { type: 'tool_call', name: 'escalate', input: { reason: 'over $100' } }]);
      expect(gemini.requests.slice(before).map((x) => [x.path, x.headers['x-goog-api-key']])).toEqual([['/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', 'agent-key']]);
    } finally {
      await Promise.all([responses.close(), g.close(), provider.close()]);
    }
  });

  it('passes what isn\'t the model call to the provider as the agent sent it: embeddings, token counts, a model list', async () => {
    const provider = await fakeProvider();
    const { seen } = provider;
    const upstream = provider.url;
    const local = resolveTarget({ model: 'my-finetune', baseUrl: `${openai.url}/v1` });
    const chat = await startTakeover({ provider: 'openai', shape: 'openai-chat', mode: 'endpoint' }, local, { env: {}, upstream });
    const messages = await startTakeover({ provider: 'anthropic', shape: 'anthropic', mode: 'to-openai' }, local, { env: {}, upstream });
    const same = await startTakeover({ provider: 'anthropic', shape: 'anthropic', mode: 'same' }, resolveTarget({ model: 'claude-haiku-4-5' }, {}), { env: {}, upstream });
    const nowhere = await startTakeover({ provider: 'openai', shape: 'openai-chat', mode: 'endpoint' }, local, { env: {} });
    const before = openai.requests.length;
    try {
      const embedded = await post(`${chat.url}/v1/embeddings`, { model: 'text-embedding-3-small', input: 'refund policy' }, { authorization: 'Bearer agent-key' });
      expect(embedded.status).toBe(200);
      expect(JSON.parse(embedded.body)).toMatchObject({ object: 'list', data: [{ embedding: [0.1, 0.2] }] });
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/embeddings', headers: { authorization: 'Bearer agent-key' } });
      expect(JSON.parse(seen[0].body)).toEqual({ model: 'text-embedding-3-small', input: 'refund policy' });
      const counted = await post(`${messages.url}/v1/messages/count_tokens`, ANTHROPIC_REQUEST, { 'x-api-key': 'agent-key' });
      expect(JSON.parse(counted.body)).toEqual({ input_tokens: 42 });
      expect(seen[1]).toMatchObject({ method: 'POST', url: '/v1/messages/count_tokens', headers: { 'x-api-key': 'agent-key' } });
      expect(JSON.parse(seen[1].body).model).toBe('claude-sonnet-5');
      const listed = await post(`${chat.url}/v1/models?limit=5`, null, {}, 'GET');
      expect(listed.status).toBe(200);
      expect(seen[2]).toMatchObject({ method: 'GET', url: '/v1/models?limit=5' });
      expect(listed.headers[ANSWERED_BY]).toBeUndefined();
      // Another model of the provider: its token counts still name the model the agent asked, which the provider knows.
      const sameCount = await post(`${same.url}/v1/messages/count_tokens`, ANTHROPIC_REQUEST, { 'x-api-key': 'agent-key' });
      expect(JSON.parse(sameCount.body)).toEqual({ input_tokens: 42 });
      expect(sameCount.headers[ANSWERED_BY]).toBeUndefined();
      expect(JSON.parse(seen[3].body).model).toBe('claude-sonnet-5');
      // None of it went to the model under test, and nothing counts as its answer.
      expect(openai.requests.length).toBe(before);
      expect(chat.answered + messages.answered + same.answered).toBe(0);
      // With nowhere to pass it to, it is refused, naming the endpoint, rather than sent to the model.
      const refused = await post(`${nowhere.url}/v1/embeddings`, { model: 'text-embedding-3-small', input: 'x' });
      expect(refused.status).toBe(501);
      expect(JSON.parse(refused.body).error.message).toContain("POST /v1/embeddings isn't sent anywhere while my-finetune takes over");
      expect(openai.requests.length).toBe(before);
    } finally {
      await Promise.all([chat.close(), messages.close(), same.close(), nowhere.close()]);
      await provider.close();
    }
  });
});

describe('a golden\'s last test', () => {
  it('is its newest result in the test history, read by the verdict the result kept', () => {
    const store = Store.open(':memory:');
    const root = '/project';
    let at = 1_760_000_000_000;
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/*'], revision: 'c91d0f4', startedAt: at });
    const result = (golden: string, ok: boolean, failure: TestFailure | null, data: TestResultData = {}) => store.addTestResult({ sessionId: session.sessionId, golden, ok, ...(failure ? { failure } : {}), reason: null, runId: `R${at}`, revision: 'c91d0f4', at: at++, data });
    const failedCheck = { ok: false, status: 'failed' as const, label: 'issue_refund called 0 times', detail: 'called 1 time (1 blocked or stubbed)' };
    const undecided = { ok: false, status: 'inconclusive' as const, label: 'judge "calm" answers yes', detail: 'not judged: no recorded verdict and the test runs offline' };
    const sprt = { kind: 'sprt' as const, good: 0.9, bad: 0.7, risk: 0.05, max: 12 };
    result('goldens/a', false, 'check', { verdict: 'failed', checks: [failedCheck] });
    result('/project/goldens/a', true, null, { verdict: 'passed' }); // the same golden by its whole path, fixed since
    result('goldens/b', false, 'check', { verdict: 'failed', checks: [failedCheck] });
    // Its gate ran out of attempts between its bounds: inconclusive, though the attempt the result
    // shows failed a check (as one of an inconclusive gate's attempts always has).
    const outcomes = [false, true, true, false, true, true, false, true, true, false, true, true];
    result('goldens/gated', false, 'inconclusive', { verdict: 'inconclusive', checks: [failedCheck], gate: gateResult(sprt, outcomes), attempts: { total: 12, passed: 8, required: null, runs: [] } });
    // Failed nothing, but a check could not be decided.
    result('goldens/judged', false, 'inconclusive', { verdict: 'inconclusive', checks: [undecided] });
    // Its replay passed, and its injection test showed too little to say.
    result('goldens/planted', false, 'injection', { verdict: 'inconclusive', gate: gateResult(sprt, [true], { clean: true }) });
    // A golden that may fork passed, forking at #3.
    result('goldens/forks', true, null, { verdict: 'passed', divergence: { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, text: '' } });
    // A result kept before results had a verdict reads as its ok and failure say.
    result('goldens/old', false, 'diverged');
    const results = lastResults(store, root);
    expect([...results.keys()].sort()).toEqual(['goldens/a', 'goldens/b', 'goldens/forks', 'goldens/gated', 'goldens/judged', 'goldens/old', 'goldens/planted']);
    const fork = { fork: true, repeat: 1, passes: 1, tools: [] };
    expect(lastTest(results.get('goldens/a'), null)).toEqual({ failed: false, inconclusive: null, forkedAt: null, forkedRun: null });
    expect(lastTest(results.get('goldens/b'), null)).toMatchObject({ failed: true, inconclusive: null });
    expect(lastTest(results.get('goldens/gated'), fork)).toEqual({ failed: false, inconclusive: 'gate', forkedAt: null, forkedRun: null });
    expect(lastTest(results.get('goldens/judged'), null)).toMatchObject({ failed: false, inconclusive: 'check' });
    expect(lastTest(results.get('goldens/planted'), null)).toMatchObject({ failed: false, inconclusive: 'injection' });
    expect(lastTest(results.get('goldens/old'), null)).toMatchObject({ failed: true, inconclusive: null });
    // Where it forked counts for a task only when it may fork: otherwise the divergence failed it.
    expect(lastTest(results.get('goldens/forks'), fork)).toEqual({ failed: false, inconclusive: null, forkedAt: 3, forkedRun: results.get('goldens/forks')!.runId });
    expect(lastTest(results.get('goldens/forks'), null)).toMatchObject({ forkedAt: null, forkedRun: null });
    // Never tested: nothing is known.
    expect(lastTest(undefined, fork)).toEqual({ failed: null, inconclusive: null, forkedAt: null, forkedRun: null });
    expect(lastResults(null, root).size).toBe(0);
    store.close();
  });
});

describe('the warning test --update gives about a value that changes every run', () => {
  const added = { type: 'request_changed' as const, callNo: 3, kind: 'api' as const, name: 'POST /v1/messages', replayedBefore: 2, diff: [{ path: '$.metadata', op: 'added' as const, after: { user_id: '9b2f6c1e-4d7a-4c3b-9e8f-2a1b3c4d5e6f' } }] };
  it('names the rule for a field new in the request, and says nothing once the config has it', () => {
    expect(volatileWarning(added).map((w) => w.command)).toEqual(["shadowlap normalize add --kind api --path '$.metadata.user_id' --pattern uuid --replace '<UUID>'"]);
    // Added just before the update (Training's Update the golden adds it first): the next run is masked, nothing to say.
    expect(volatileWarning(added, [{ kind: 'api', path: '$.metadata.user_id', pattern: 'uuid', replace: '<UUID>' }])).toEqual([]);
    expect(volatileWarning(added, [{ path: '$.metadata.user_id', replace: '<ID>' }])).toEqual([]);
    // A rule for another kind of call, or another path, is no rule for it.
    expect(volatileWarning(added, [{ kind: 'tool', path: '$.metadata.user_id', replace: '<ID>' }])).toHaveLength(1);
    expect(volatileWarning(added, [{ kind: 'api', path: '$.metadata.trace_id', pattern: 'ulid', replace: '<ULID>' }])).toHaveLength(1);
  });
});

describe('what a score refuses before anything runs', () => {
  const call = (callNo: number, name: string, provider: string) => ({ runId: 'r', callNo, kind: 'api', name, fingerprint: 'f', occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: { provider }, at: 1, end: { runId: 'r', callNo, attempt: 0, responseRef: null, outcome: 'ok', meta: { provider }, at: 2 }, attempts: [] }) as unknown as CallRecord;
  const task = (name: string, provider: string, before: CallRecord[] = []): LoadedTask => {
    return { golden: 'goldens/g', name: 'g', status: 'ready', note: null, runId: 'r', takeover: { callNo: 3, why: 'w', from: 'config' }, scope: null, scopes: [null], rewards: null, checks: [], after: { live: [], stubbed: [] }, prefix: 2, model: 'm', provider, callName: name, tokensAfter: null, spec: null, dir: '/g', pack: { path: 'goldens/g', dir: '/g', run: {} as never, lineage: [], calls: [...before, call(3, name, provider)] } };
  };

  it('a model scoring can\'t switch: Bedrock, Vertex AI and Azure deployments', () => {
    const same = (m: string) => resolveTarget({ model: m }, {});
    expect(cannotScore(task('POST /model/anthropic.claude-sonnet-5-v1%3A0/converse', 'bedrock'), same('anthropic.claude-haiku-4-5-v1:0'))).toBe("goldens/g can't be scored with anthropic.claude-haiku-4-5-v1:0: its takeover call goes through Amazon Bedrock, whose request signature covers the model in its URL: score Anthropic's or OpenAI's API, or a model at your own endpoint, instead");
    expect(cannotScore(task('POST /openai/deployments/gpt-prod/chat/completions', 'azure'), same('gpt-test'))).toContain('Azure OpenAI');
    // Within their own provider, Anthropic, OpenAI (the Responses API too) and Gemini switch.
    expect(cannotScore(task('POST /v1beta/models/gemini-2.5-flash:generateContent', 'gemini'), same('gemini-2.5-pro'))).toBeNull();
    expect(cannotScore(task('POST /v1/responses', 'openai'), same('gpt-5'))).toBeNull();
    expect(cannotScore(task('POST /v1/messages', 'anthropic'), same('claude-haiku-4-5'))).toBeNull();
    expect(cannotScore(task('POST /v1/chat/completions', 'openai'), same('gpt-5'))).toBeNull();
    // Another provider's model is refused for these: they don't translate.
    expect(cannotScore(task('POST /v1/completions', 'openai'), resolveTarget({ model: 'm', baseUrl: 'http://127.0.0.1:8000/v1' }))).toBe("goldens/g can't be answered by m at http://127.0.0.1:8000/v1: it is an openai request (/v1/completions), which only another model of its own provider can answer");
    // The Responses API translates for another model's chat completions.
    expect(cannotScore(task('POST /v1/responses', 'openai'), resolveTarget({ model: 'm', baseUrl: 'http://127.0.0.1:8000/v1' }))).toBeNull();
  });

  it('a takeover asked at a call that asks a model nothing', () => {
    const t = task('POST /v1/messages', 'anthropic', [call(1, 'GET /v1/models', 'anthropic'), call(2, 'POST /v1/embeddings', 'openai')]);
    const weak = resolveTarget({ model: 'weak-model' }, {});
    expect(cannotScore(t, weak)).toBeNull();
    expect(cannotScore(t, weak, 1)).toBe("#1 is not a model call of goldens/g's run (GET /v1/models)");
    expect(cannotScore(t, weak, 2)).toBe("#2 is not a model call of goldens/g's run (POST /v1/embeddings)");
    expect(cannotScore(t, weak, 9)).toBe("#9 is not a model call of goldens/g's run");
  });
});

describe('keeping a model\'s scores', () => {
  it('replaces them with a whole re-score, and keeps them when a re-score stops short', () => {
    const store = Store.open(':memory:');
    const target = resolveTarget({ model: 'weak-model' }, {});
    const score = (n: number, value: number): TaskScore => ({ task: 'goldens/g', takeover: 5, why: 'w', prefix: 4, via: 'Anthropic API', attempts: Array.from({ length: n }, (_, i) => ({ attempt: i + 1, runId: `run-${value}-${i + 1}`, score: value, checks: [], spent: 0, judge: null, exitCode: 0, ms: 1 })), mean: value, spent: 0, judge: null, stopped: null, dropped: [], unknownModels: [] });
    const rows = () => store.listTaskScores().map((r: TaskScoreRow) => [r.attempt, r.runId, r.score]);
    // Stopped short with nothing before it: what it has is kept.
    expect(keepScores(store, target, score(1, 0.25), 's1', 4).outcome).toBe('new');
    expect(rows()).toEqual([[1, 'run-0.25-1', 0.25]]);
    expect(keepScores(store, target, score(4, 0.5), 's2', 4)).toMatchObject({ outcome: 'replaced', before: [{ score: 0.25 }] });
    expect(rows()).toHaveLength(4);
    // A re-score that stopped after one attempt of four leaves the whole score standing.
    expect(keepScores(store, target, score(1, 1), 's3', 4)).toMatchObject({ outcome: 'kept', before: [{ score: 0.5 }, { score: 0.5 }, { score: 0.5 }, { score: 0.5 }] });
    expect(rows().map((r) => r[2])).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(keepScores(store, target, score(0, 0), 's4', 4).outcome).toBe('none');
    store.close();
  });

  it('says what it replaced or kept in words that count right', () => {
    const score = (n: number): TaskScore => ({ task: 'goldens/g', takeover: 5, why: 'w', prefix: 4, via: 'Anthropic API', attempts: Array.from({ length: n }, (_, i) => ({ attempt: i + 1, runId: `run-${i}`, score: 1, checks: [], spent: 0, judge: null, exitCode: 0, ms: 1 })), mean: 1, spent: 0, judge: null, stopped: null, dropped: [], unknownModels: [] });
    const before = [{ score: 0.5 }, { score: 0.25 }] as TaskScoreRow[];
    expect(keptLine(score(1), { outcome: 'replaced', before }, 1)).toBe('g: replaced 2 earlier attempts (0.38) with this one');
    expect(keptLine(score(3), { outcome: 'replaced', before: before.slice(0, 1) }, 3)).toBe('g: replaced 1 earlier attempt (0.50) with these 3');
    expect(keptLine(score(1), { outcome: 'kept', before }, 4)).toBe('g: kept the earlier score (0.38 over 2 attempts): this one stopped after 1 of 4');
    expect(keptLine(score(2), { outcome: 'new', before: [] }, 2)).toBeNull();
  });

  it('names the calls a takeover replays first', () => {
    expect(replayedBefore(1)).toBeNull();
    expect(replayedBefore(2)).toBe('#1');
    expect(replayedBefore(5)).toBe('#1–#4');
  });
});

describe('which model answered, and what it cost', () => {
  const live = (callNo: number, o: { model?: string; answered?: string; usage?: { inputTokens: number; outputTokens: number }; origin?: string; name?: string; scope?: string }) =>
    ({ runId: 'r', callNo, kind: 'api', name: o.name ?? 'POST /v1/messages', fingerprint: 'f', occurrence: 1, origin: o.origin ?? 'live', effect: null, requestRef: null, meta: { provider: 'anthropic', ...(o.scope ? { scope: o.scope } : {}) }, at: 1, end: { runId: 'r', callNo, attempt: 0, responseRef: null, outcome: 'ok', meta: { provider: 'anthropic', ...(o.model ? { model: o.model } : {}), ...(o.usage ? { usage: o.usage } : {}), headers: o.answered ? { [ANSWERED_BY]: o.answered } : {} }, at: 2 }, attempts: [] }) as unknown as CallRecord;
  const usage = { inputTokens: 1_000_000, outputTokens: 0 };

  it('is the model the takeover upstream says answered, else the model the request named', () => {
    expect(answeredBy(live(5, { model: 'small-model', answered: 'claude-haiku-4-5' }))).toBe('claude-haiku-4-5');
    expect(answeredBy(live(5, { model: 'small-model' }))).toBe('small-model');
    expect(answeredBy(live(5, {}))).toBeNull();
  });

  it('prices each live call as the model that answered it, and a model on this machine at nothing', () => {
    const calls = [
      live(3, { model: 'claude-sonnet-5', usage, origin: 'replayed' }), // before the takeover: replayed, free
      live(5, { model: 'small-model', answered: 'claude-haiku-4-5', usage }),
      live(6, { model: 'text-embedding-3-small', usage, name: 'POST /v1/embeddings' }),
    ];
    const unknown = new Set<string>();
    expect(attemptCost(calls, resolveTarget({ model: 'claude-haiku-4-5' }, {}), undefined, unknown)).toBeCloseTo(1);
    expect([...unknown]).toEqual(['text-embedding-3-small']);
    const local = new Set<string>();
    expect(attemptCost([live(5, { model: 'small-model', answered: 'my-finetune', usage })], resolveTarget({ model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1' }), undefined, local)).toBe(0);
    expect(local.size).toBe(0);
  });

  it("leaves a judge check's calls out of what the attempt cost: they are reported apart", () => {
    const judge = live(7, { model: 'claude-haiku-4-5', usage, scope: 'shadowlap:judge' });
    const unknown = new Set<string>();
    // The model scored, $1, and a judge asked about it, priced apart; one with no price isn't named here either.
    expect(attemptCost([live(5, { model: 'small-model', answered: 'claude-haiku-4-5', usage }), judge, live(8, { model: 'judge-without-a-price', usage, scope: 'shadowlap:judge' })], resolveTarget({ model: 'claude-haiku-4-5' }, {}), undefined, unknown)).toBeCloseTo(1);
    expect(unknown.size).toBe(0);
    // A model on this machine costs nothing, and the judge's call is still not the provider's own.
    expect(attemptCost([live(5, { model: 'small-model', answered: 'my-finetune', usage }), judge], resolveTarget({ model: 'my-finetune', baseUrl: 'http://127.0.0.1:8000/v1' }), undefined, unknown)).toBe(0);
  });

  it("adds up what judge checks' calls did and cost over attempts", () => {
    const one = { calls: 1, replayed: 0, live: 1, notAsked: 0, upstreamRequests: 1, spent: 0.002, saved: 0, unknownModels: [] };
    const two = { calls: 2, replayed: 1, live: 1, notAsked: 0, upstreamRequests: 1, spent: 0.001, saved: 0.002, unknownModels: ['openai:my-judge'] };
    expect(addJudge(null, null)).toBeNull();
    expect(addJudge(null, one)).toEqual(one);
    expect(addJudge(one, undefined)).toBe(one);
    expect(addJudge(addJudge(one, two), two)).toEqual({ calls: 5, replayed: 2, live: 3, notAsked: 0, upstreamRequests: 3, spent: expect.closeTo(0.004, 6), saved: expect.closeTo(0.004, 6), unknownModels: ['openai:my-judge'] });
  });
});
