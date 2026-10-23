import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer as AnthropicMock } from '@shadowlap-testing/mock-anthropic';
import { startMockOpenAI, toolCall, turn, type MockServer as OpenAIMock } from '@shadowlap-testing/mock-openai';
import { PLACEHOLDER_KEY, Sidecar } from '../src/index.js';

/**
 * Hosts that serve another provider's wire format are recorded as that provider's calls: Claude on
 * Microsoft Foundry as Anthropic's (it was read as Azure OpenAI's, so its usage came out wrong and it
 * had no placeholder key), OpenAI's SDK on Bedrock as OpenAI's, and a host the config declares in
 * the format it names. Each keeps the host it went through as `via`, and replays and forks like the
 * provider whose format it speaks.
 */

const command = { argv: ['agent'], cwd: '/' };

/** A server in front of `target` that serves it under `prefix`, and names the organization in every answer, as Anthropic's API does. */
async function under(prefix: string, target: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (!path.startsWith(`${prefix}/`)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: `nothing outside ${prefix}` } }));
    }
    const upstream = request(`${target}${path.slice(prefix.length)}`, { method: req.method, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, { ...answer.headers, 'anthropic-organization-id': 'org-4f6e7a1c-shadowlap-test' });
      answer.pipe(res);
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('Claude on Microsoft Foundry', () => {
  let mock: AnthropicMock;
  let foundry: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    mock = await startMockAnthropic({ script: () => ({ message: { ...message([text('Refund approved.')], { input_tokens: 120, output_tokens: 9 }), usage: { input_tokens: 120, output_tokens: 9, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 } } }) });
    foundry = await under('/anthropic', mock.url);
  });
  afterAll(async () => {
    await foundry.close();
    await mock.close();
  });

  /** The Anthropic SDK as AnthropicFoundry drives it, its base URL Azure's route as in-process capture sends a Foundry call. */
  const client = (base: string, apiKey = 'foundry-key-1') => new Anthropic({ apiKey, baseURL: `${base}/azure/anthropic`, maxRetries: 0 });

  it('records a call as Anthropic\'s, through foundry, with Anthropic\'s usage, and replays it offline', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { foundry: foundry.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      const stream = client(`${sidecar.url}/r/${rec.runId}`).messages.stream({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Refund order A-17?' }] });
      expect((await stream.finalMessage()).content).toEqual([{ type: 'text', text: 'Refund approved.' }]);
      sidecar.endRun(rec.runId, 'completed');
      const [call] = store.getCalls(rec.runId);
      expect(call).toMatchObject({ name: 'POST /anthropic/v1/messages', meta: { provider: 'anthropic', via: 'foundry' } });
      // Read as Anthropic's stream: the input from message_start, the cache read with it.
      expect(call!.end!.meta.usage).toEqual({ inputTokens: 120, outputTokens: 9, cacheReadInputTokens: 800, cacheCreationInputTokens: 0 });
      expect(call!.end!.meta.provider).toBe('anthropic');
      expect(call!.end!.meta.stopReason).toBe('end_turn');
      // The organization the key belongs to is never kept.
      expect(JSON.stringify(store.getCalls(rec.runId))).not.toContain('org-4f6e7a1c');

      const before = mock.requests.length;
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, offline: true });
      const replayed = await client(`${sidecar.url}/r/${rep.runId}`).messages.stream({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Refund order A-17?' }] }).finalMessage();
      expect(replayed.content).toEqual([{ type: 'text', text: 'Refund approved.' }]);
      expect(sidecar.endRun(rep.runId, 'completed').summary).toMatchObject({ divergence: null, upstreamRequests: 0, tokensNotRespent: { inputTokens: 120, cacheReadInputTokens: 800 } });
      expect(mock.requests.length).toBe(before);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('sends the agent no organization id either, and refuses a live call that carries the placeholder, naming Foundry\'s key', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { foundry: foundry.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      const { response } = await client(`${sidecar.url}/r/${rec.runId}`).messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }).withResponse();
      expect(response.headers.get('anthropic-organization-id')).toBeNull();
      sidecar.endRun(rec.runId, 'completed');

      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      const err = await client(`${sidecar.url}/r/${fork.runId}`, PLACEHOLDER_KEY).messages.create({ model: 'claude-sonnet-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'something else' }] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Anthropic.AuthenticationError);
      expect((err as Error).message).toContain('ANTHROPIC_FOUNDRY_API_KEY');
      sidecar.endRun(fork.runId, 'completed');
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('OpenAI\'s SDK on Bedrock (bedrock-mantle)', () => {
  let mock: OpenAIMock;
  beforeAll(async () => {
    mock = await startMockOpenAI({ script: () => ({ turn: turn('unused') }), responses: () => ({ turn: turn('Bedrock says hello.') }), root: '/openai' });
  });
  afterAll(() => mock.close());

  it('records a Responses call as OpenAI\'s, through bedrock-mantle, and replays it offline', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { 'bedrock-mantle': mock.url } });
    const client = (runId: string) => new OpenAI({ apiKey: 'bedrock-api-key', baseURL: `${sidecar.url}/r/${runId}/bedrock/openai/v1`, maxRetries: 0 });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      expect((await client(rec.runId).responses.create({ model: 'openai.gpt-5.4', input: 'Say hello.' })).output_text).toBe('Bedrock says hello.');
      sidecar.endRun(rec.runId, 'completed');
      const [call] = store.getCalls(rec.runId);
      expect(call).toMatchObject({ name: 'POST /openai/v1/responses', meta: { provider: 'openai', via: 'bedrock-mantle' } });
      expect(call!.end!.meta.usage?.inputTokens).toBeGreaterThan(0);

      const before = mock.otherRequests.length;
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, offline: true });
      expect((await client(rep.runId).responses.create({ model: 'openai.gpt-5.4', input: 'Say hello.' })).output_text).toBe('Bedrock says hello.');
      expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();
      expect(mock.otherRequests.length).toBe(before);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('a host the config declares (an OpenRouter-style gateway)', () => {
  let mock: OpenAIMock;
  beforeAll(async () => {
    mock = await startMockOpenAI({
      script: (ctx) => ({ turn: ctx.assistantTurns === 0 ? turn(null, { tool_calls: [toolCall('lookup_order', { id: 'A-17' })] }) : turn('Order A-17 cost 180.') }),
      root: '/api',
    });
  });
  afterAll(() => mock.close());

  const formats = [{ host: 'openrouter.test', format: 'openai' as const, root: '/api/v1' }];
  const ask = async (client: OpenAI, temperature?: number) => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: 'What did order A-17 cost?' }];
    const tools: OpenAI.ChatCompletionTool[] = [{ type: 'function', function: { name: 'lookup_order', parameters: { type: 'object', properties: { id: { type: 'string' } } } } }];
    for (let i = 0; i < 3; i++) {
      const stream = await client.chat.completions.create({ model: 'anthropic/claude-sonnet-4.5', messages, tools, stream: true, stream_options: { include_usage: true }, ...(temperature !== undefined ? { temperature } : {}) });
      let content = '';
      const calls: Array<{ id: string; name: string; args: string }> = [];
      for await (const chunk of stream) {
        for (const tc of chunk.choices[0]?.delta.tool_calls ?? []) {
          calls[tc.index] ??= { id: '', name: '', args: '' };
          if (tc.id) calls[tc.index]!.id = tc.id;
          if (tc.function?.name) calls[tc.index]!.name = tc.function.name;
          calls[tc.index]!.args += tc.function?.arguments ?? '';
        }
        content += chunk.choices[0]?.delta.content ?? '';
      }
      if (!calls.length) return content;
      messages.push({ role: 'assistant', content: null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } })) });
      for (const c of calls) messages.push({ role: 'tool', tool_call_id: c.id, content: JSON.stringify({ id: 'A-17', total: 180 }) });
    }
    throw new Error('no answer');
  };

  it('records its calls as OpenAI\'s, streamed with usage, replays them offline, and forks them with an intervention', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, formats, upstreams: { openrouter_test: mock.url } });
    const client = (runId: string) => new OpenAI({ apiKey: 'sk-or-test', baseURL: `${sidecar.url}/r/${runId}/openrouter.test/api/v1`, maxRetries: 0 });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      expect(await ask(client(rec.runId))).toBe('Order A-17 cost 180.');
      // The providers a run used go into telemetry: a declared host by its format, never its name.
      expect(sidecar.endRun(rec.runId, 'completed').providers).toEqual(['openai']);
      const calls = store.getCalls(rec.runId);
      expect(calls.map((c) => c.name)).toEqual(['POST /api/v1/chat/completions', 'POST /api/v1/chat/completions']);
      expect(calls.every((c) => c.meta.provider === 'openai' && c.meta.via === 'openrouter.test')).toBe(true);
      expect(calls.every((c) => (c.end?.meta.usage?.inputTokens ?? 0) > 0)).toBe(true);
      expect(calls[0]!.end!.meta.chunks?.length).toBeGreaterThan(1);
      expect(JSON.stringify(calls)).not.toContain('sk-or-test');

      const before = mock.requests.length;
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, offline: true });
      expect(await ask(client(rep.runId))).toBe('Order A-17 cost 180.');
      expect(sidecar.endRun(rep.runId, 'completed').summary).toMatchObject({ divergence: null, upstreamRequests: 0 });
      expect(mock.requests.length).toBe(before);

      // --set on the second model call: rewritten in OpenAI's shape, forked there, sent to the gateway.
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, interventions: { set: { fromCall: 2, fields: { temperature: 0.2 } } } });
      expect(await ask(client(fork.runId))).toBe('Order A-17 cost 180.');
      const { summary } = sidecar.endRun(fork.runId, 'completed');
      expect(summary.divergence).toMatchObject({ callNo: 2 });
      expect(summary.upstreamRequests).toBe(1);
      expect(mock.requests.at(-1)!.body).toMatchObject({ temperature: 0.2 });
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('forwards a captured call only to the host it declares', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, formats });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      const res = await fetch(`${sidecar.url}/r/${rec.runId}/openrouter.test/api/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-upstream': 'https://elsewhere.test' }, body: '{}' });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('openrouter.test cannot forward to https://elsewhere.test');
      sidecar.endRun(rec.runId, 'completed');
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
