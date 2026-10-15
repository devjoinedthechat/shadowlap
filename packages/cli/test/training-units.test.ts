import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeResponse, Store, storeApiRequest, type CallRecord, type RunMeta, type TaskScoreRow } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { startMockOpenAI, toolCall, turn, type MockServer as OpenAIServer } from '@shadowlap-testing/mock-openai';
import { parseTests } from '../src/checks.js';
import { needsTakeover, resolveTarget, startTakeover, targetVia } from '../src/takeover.js';
import { askedModel, cannotScore, keepScores, lastTests, taskChecks, testFailed, type LoadedTask, type TaskScore } from '../src/tasks.js';

/**
 * The CLI's training parts on their own: the task block under tests, the model under test and how a
 * recorded conversation reaches it (what --model, --base-url and --key-env ask for, when a takeover
 * upstream translates, the upstream itself against the mock providers in both directions), and how a
 * score checks which model the takeover call asked.
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

function post(url: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      let data = '';
      res.on('data', (d: Buffer) => (data += d.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), body: data }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : JSON.stringify(body));
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

describe('the task block under tests', () => {
  it('is checked wherever tests are read, so shadowlap test and doctor report a mistake in it', () => {
    expect(parseTests({ 'goldens/a': { expect: { tools: { escalate: 1 } }, task: { takeover: 5, why: 'decides', rewards: 'escalate above the limit' } } })).toHaveLength(1);
    expect(() => parseTests({ 'goldens/a': { task: { takeover: 'five' } } })).toThrow('shadowlap.config.json: tests["goldens/a"].task.takeover must be a model call number');
    expect(() => parseTests({ 'goldens/a': { task: { teaches: 'x' } } })).toThrow('has an unknown key "teaches"');
  });

  it('scores the outcome checks, and lists token and cost budgets as caps', () => {
    const [entry] = parseTests({ 'goldens/a': { expect: { tools: { issue_refund: 0 }, modelCalls: '<= 12', inputTokens: '<= 60000', cost: '<= 0.05' } } });
    expect(taskChecks(entry!.spec)).toEqual([
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
    const t = await startTakeover('anthropic', resolveTarget({ model: 'my-finetune', baseUrl: `${openai.url}/v1` }), { env: {} });
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
    const t = await startTakeover('openai-chat', resolveTarget({ model: 'anthropic:claude-good' }, { SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url }), { env: { ANTHROPIC_API_KEY: 'test-key' } });
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
    const t = await startTakeover('anthropic', resolveTarget({ model: 'my-finetune', baseUrl: `http://127.0.0.1:${port}/v1` }), { env: {} });
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
    await expect(startTakeover('openai-chat', resolveTarget({ model: 'anthropic:claude-good' }, {}), { env: {} })).rejects.toThrow('ANTHROPIC_API_KEY is not set');
  });

  it('passes what isn\'t the model call to the provider as the agent sent it: embeddings, token counts, a model list', async () => {
    // The provider, as a fake that says what it was sent.
    const seen: Array<{ method: string; url: string; headers: IncomingHttpHeaders; body: string }> = [];
    const provider = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        const answer = req.url?.includes('count_tokens') ? { input_tokens: 42 } : req.url?.includes('embeddings') ? { object: 'list', data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }] } : { data: [{ id: 'gpt-5-mini' }] };
        res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'req_1' });
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    const upstream = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
    const local = resolveTarget({ model: 'my-finetune', baseUrl: `${openai.url}/v1` });
    const chat = await startTakeover('openai-chat', local, { env: {}, upstream });
    const messages = await startTakeover('anthropic', local, { env: {}, upstream });
    const nowhere = await startTakeover('openai-chat', local, { env: {} });
    const before = openai.requests.length;
    try {
      const embedded = await post(`${chat.url}/v1/embeddings`, { model: 'text-embedding-3-small', input: 'refund policy' }, { authorization: 'Bearer agent-key' });
      expect(embedded.status).toBe(200);
      expect(JSON.parse(embedded.body)).toMatchObject({ object: 'list', data: [{ embedding: [0.1, 0.2] }] });
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/embeddings', headers: { authorization: 'Bearer agent-key' } });
      expect(JSON.parse(seen[0]!.body)).toEqual({ model: 'text-embedding-3-small', input: 'refund policy' });
      const counted = await post(`${messages.url}/v1/messages/count_tokens`, ANTHROPIC_REQUEST, { 'x-api-key': 'agent-key' });
      expect(JSON.parse(counted.body)).toEqual({ input_tokens: 42 });
      expect(seen[1]).toMatchObject({ method: 'POST', url: '/v1/messages/count_tokens', headers: { 'x-api-key': 'agent-key' } });
      expect(JSON.parse(seen[1]!.body).model).toBe('claude-sonnet-5');
      const listed = await post(`${chat.url}/v1/models?limit=5`, null, {}, 'GET');
      expect(listed.status).toBe(200);
      expect(seen[2]).toMatchObject({ method: 'GET', url: '/v1/models?limit=5' });
      // None of it went to the model under test, and nothing counts as its answer.
      expect(openai.requests.length).toBe(before);
      expect(chat.answered + messages.answered).toBe(0);
      // With nowhere to pass it to, it is refused, naming the endpoint, rather than sent to the model.
      const refused = await post(`${nowhere.url}/v1/embeddings`, { model: 'text-embedding-3-small', input: 'x' });
      expect(refused.status).toBe(501);
      expect(JSON.parse(refused.body).error.message).toContain("POST /v1/embeddings isn't sent anywhere while my-finetune takes over");
      expect(openai.requests.length).toBe(before);
    } finally {
      await Promise.all([chat.close(), messages.close(), nowhere.close()]);
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  });
});

describe('a golden\'s last test', () => {
  it('is its newest finished test run, read once for every golden', () => {
    const store = Store.open(':memory:');
    const root = '/project';
    let at = 1_760_000_000_000;
    const test = (golden: string, status: 'completed' | 'failed' | 'running', meta: RunMeta = {}, divergence = false) => {
      const run = store.createRun({ mode: 'replay', command: { argv: ['shadowlap', 'test'], cwd: root }, codeVersion: null, startedAt: at++, meta: { test: { golden, session: 't' }, ...meta } });
      if (divergence) store.setDivergence(run.runId, { type: 'request_changed', callNo: 3, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2 });
      if (status !== 'running') store.endRun(run.runId, status);
      return run;
    };
    test('goldens/a', 'completed', { checks: [{ ok: false, label: 'escalate called 1 time', detail: 'called 0 times' }] });
    test('/project/goldens/a', 'running'); // newer, still running: the finished one before it counts
    test('goldens/b', 'failed');
    test('goldens/b', 'completed'); // fixed since
    test('goldens/c', 'completed', {}, true);
    test('goldens/d', 'failed');
    const last = lastTests(store, root);
    expect([...last.keys()].sort()).toEqual(['goldens/a', 'goldens/b', 'goldens/c', 'goldens/d']);
    expect(testFailed(last.get('goldens/a'), null)).toBe(true);
    expect(testFailed(last.get('goldens/b'), null)).toBe(false);
    // A divergence fails a golden unless it may fork.
    expect(testFailed(last.get('goldens/c'), null)).toBe(true);
    expect(testFailed(last.get('goldens/c'), { fork: true, repeat: 1, passes: 1, tools: [] })).toBe(false);
    expect(testFailed(last.get('goldens/d'), null)).toBe(true);
    expect(testFailed(last.get('goldens/e'), null)).toBeNull();
    expect(lastTests(null, root).size).toBe(0);
    store.close();
  });
});

describe('what a score refuses before anything runs', () => {
  const task = (name: string, provider: string): LoadedTask => {
    const call = { runId: 'r', callNo: 3, kind: 'api', name, fingerprint: 'f', occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: { provider }, at: 1, end: { runId: 'r', callNo: 3, attempt: 0, responseRef: null, outcome: 'ok', meta: { provider }, at: 2 }, attempts: [] } as unknown as CallRecord;
    return { golden: 'goldens/g', name: 'g', status: 'ready', note: null, runId: 'r', takeover: { callNo: 3, why: 'w', from: 'config' }, scope: null, scopes: [null], rewards: null, checks: [], after: { live: [], stubbed: [] }, prefix: 2, model: 'm', provider, callName: name, tokensAfter: null, spec: null, dir: '/g', pack: { path: 'goldens/g', dir: '/g', run: {} as never, lineage: [], calls: [call] } };
  };

  it('a model --model can\'t change: one named in the URL, or a request with no messages', () => {
    const same = (m: string) => resolveTarget({ model: m }, {});
    expect(cannotScore(task('POST /v1beta/models/gemini-2.5-flash:generateContent', 'gemini'), same('gemini-2.5-pro'))).toBe("goldens/g can't be scored with gemini-2.5-pro: its takeover call names its model in the URL (gemini-2.5-flash), and --model can't change that model yet");
    expect(cannotScore(task('POST /model/anthropic.claude-sonnet-5-v1%3A0/converse', 'bedrock'), same('anthropic.claude-haiku-4-5-v1:0'))).toContain('names its model in the URL (anthropic.claude-sonnet-5-v1:0)');
    expect(cannotScore(task('POST /v1/responses', 'openai'), same('gpt-5'))).toContain('uses the OpenAI Responses API');
    expect(cannotScore(task('POST /v1/messages', 'anthropic'), same('claude-haiku-4-5'))).toBeNull();
    expect(cannotScore(task('POST /v1/chat/completions', 'openai'), same('gpt-5'))).toBeNull();
    // Another provider's model is refused for these anyway: they don't translate.
    expect(cannotScore(task('POST /v1/responses', 'openai'), resolveTarget({ model: 'm', baseUrl: 'http://127.0.0.1:8000/v1' }))).toContain('only Anthropic Messages and OpenAI Chat Completions are translated');
  });
});

describe('keeping a model\'s scores', () => {
  it('replaces them with a whole re-score, and keeps them when a re-score stops short', () => {
    const store = Store.open(':memory:');
    const target = resolveTarget({ model: 'weak-model' }, {});
    const score = (n: number, value: number): TaskScore => ({ task: 'goldens/g', takeover: 5, why: 'w', prefix: 4, via: 'Anthropic API', attempts: Array.from({ length: n }, (_, i) => ({ attempt: i + 1, runId: `run-${value}-${i + 1}`, score: value, checks: [], spent: 0, exitCode: 0, ms: 1 })), mean: value, spent: 0, stopped: null, dropped: [], unknownModels: [] });
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
