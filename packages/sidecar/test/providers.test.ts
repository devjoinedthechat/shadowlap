import { describe, expect, it } from 'vitest';
import { activeProviders, anthropic, azure, bedrock, bedrockMantle, declareFormatHosts, formatHostProblem, formatHostProvider, foundry, gemini, hostedProviders, openai, providers, sseDataObjects, vertex } from '../src/providers.js';

const sse = (events: Array<[string | null, unknown]>) => Buffer.from(events.map(([e, d]) => (e ? `event: ${e}\n` : '') + `data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`).join(''));
const SSE = 'text/event-stream; charset=utf-8';
const JSON_CT = 'application/json';

describe('sseDataObjects', () => {
  it('parses data payloads, skips [DONE] and tolerates truncation', () => {
    const text = 'data: {"a":1}\n\nevent: x\ndata: {"b":2}\n\ndata: [DONE]\n\ndata: {"trunc';
    expect([...sseDataObjects(text)]).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('anthropic usage', () => {
  it('reads JSON and streamed usage', () => {
    expect(anthropic.extractUsage(Buffer.from(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } })), JSON_CT)).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3 });
    const body = sse([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } }],
      ['message_delta', { type: 'message_delta', usage: { output_tokens: 42 } }],
    ]);
    expect(anthropic.extractUsage(body, SSE)).toEqual({ inputTokens: 100, outputTokens: 42 });
  });

  it('names a path sent under a base URL that held the /v1 as the API does', () => {
    // The Vercel AI SDK's Anthropic provider sends `${ANTHROPIC_BASE_URL}/messages`; the official SDKs `/v1/messages`.
    expect(anthropic.apiPath?.('/messages')).toBe('/v1/messages');
    expect(anthropic.apiPath?.('/messages/batches/msgbatch_1')).toBe('/v1/messages/batches/msgbatch_1');
    for (const path of ['/v1/messages', '/v1/messages/count_tokens', '/v1/models', '/v1']) expect(anthropic.apiPath?.(path)).toBe(path);
  });

  it('matches a call without the betas that only say how it signed in, and keeps every other beta', () => {
    const version = { 'anthropic-version': '2023-06-01' };
    expect(anthropic.matchHeaders?.({ ...version, 'anthropic-beta': 'oauth-2025-04-20' })).toEqual(version);
    expect(anthropic.matchHeaders?.({ ...version, 'anthropic-beta': 'files-api-2025-04-14, oauth-2025-04-20' })).toEqual({ ...version, 'anthropic-beta': 'files-api-2025-04-14' });
    // Nothing to leave out: the headers as they came, whatever their spacing.
    expect(anthropic.matchHeaders?.({ ...version, 'anthropic-beta': 'files-api-2025-04-14, context-1m-2025-08-07' })).toEqual({ ...version, 'anthropic-beta': 'files-api-2025-04-14, context-1m-2025-08-07' });
    expect(anthropic.matchHeaders?.(version)).toEqual(version);
    // Only Anthropic's own API signs in so; the clouds' clients sign in their own way.
    for (const p of providers.filter((x) => x !== anthropic)) expect(p.matchHeaders, p.id).toBeUndefined();
  });
});

describe('openai usage', () => {
  it('reads Chat Completions JSON, streamed usage chunks, and the Responses API', () => {
    // OpenAI's prompt_tokens includes cached tokens; inputTokens is the uncached part.
    expect(openai.extractUsage(Buffer.from(JSON.stringify({ usage: { prompt_tokens: 20, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 4 } } })), JSON_CT)).toEqual({ inputTokens: 16, outputTokens: 7, cacheReadInputTokens: 4 });
    const chat = sse([
      [null, { object: 'chat.completion.chunk', choices: [{ delta: { content: 'hi' } }], usage: null }],
      [null, { object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 30, completion_tokens: 9 } }],
      [null, '[DONE]'],
    ]);
    expect(openai.extractUsage(chat, SSE)).toEqual({ inputTokens: 30, outputTokens: 9 });
    const responses = sse([
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'x' }],
      ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 11, input_tokens_details: { cached_tokens: 10 } } } }],
    ]);
    expect(openai.extractUsage(responses, SSE)).toEqual({ inputTokens: 40, outputTokens: 11, cacheReadInputTokens: 10 });
    expect(openai.extractUsage(Buffer.from('not json'), JSON_CT)).toBeNull();
  });

  it('reads stop reasons', () => {
    expect(openai.extractStopReason(Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] })), JSON_CT)).toBe('tool_calls');
    const chat = sse([[null, { choices: [{ delta: {}, finish_reason: null }] }], [null, { choices: [{ delta: {}, finish_reason: 'stop' }] }], [null, '[DONE]']]);
    expect(openai.extractStopReason(chat, SSE)).toBe('stop');
    expect(anthropic.extractStopReason(Buffer.from(JSON.stringify({ stop_reason: 'end_turn' })), JSON_CT)).toBe('end_turn');
    expect(anthropic.extractStopReason(sse([['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }]]), SSE)).toBe('tool_use');
    expect(gemini.extractStopReason(Buffer.from(JSON.stringify({ candidates: [{ finishReason: 'STOP' }] })), JSON_CT)).toBe('STOP');
  });

  it('points the official SDK at the sidecar with the /v1 root', () => {
    expect(openai.env('http://127.0.0.1:1/t/x/openai')).toEqual({ OPENAI_BASE_URL: 'http://127.0.0.1:1/t/x/openai/v1' });
  });
});

describe('gemini usage', () => {
  it('reads usageMetadata from JSON and from the last streamed chunk', () => {
    expect(gemini.extractUsage(Buffer.from(JSON.stringify({ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 2, cachedContentTokenCount: 5 } })), JSON_CT)).toEqual({ inputTokens: 7, outputTokens: 5, cacheReadInputTokens: 5 });
    const body = sse([
      [null, { candidates: [{ content: { parts: [{ text: 'a' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1 } }],
      [null, { candidates: [{ content: { parts: [{ text: 'b' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 4 } }],
    ]);
    expect(gemini.extractUsage(body, SSE)).toEqual({ inputTokens: 12, outputTokens: 4 });
  });

  it('reads the OpenAI-compatible endpoint\'s answers in OpenAI\'s format', () => {
    const body = sse([
      [null, { choices: [{ index: 0, delta: { content: 'a' } }] }],
      [null, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4 } }],
      [null, '[DONE]'],
    ]);
    expect(gemini.extractUsage(body, SSE)).toEqual({ inputTokens: 12, outputTokens: 4 });
    expect(gemini.extractStopReason(body, SSE)).toBe('stop');
    expect(gemini.extractUsage(Buffer.from(JSON.stringify({ choices: [{ finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })), JSON_CT)).toEqual({ inputTokens: 3, outputTokens: 2 });
  });
});

describe('cloud providers', () => {
  it('read Azure deployments, Vertex paths and Bedrock model ids as the model', () => {
    expect(azure.extractModel('/openai/deployments/gpt-4o-prod/chat/completions', { messages: [] })).toBe('gpt-4o-prod');
    expect(azure.extractModel('/openai/deployments/prod/chat/completions', { model: 'gpt-4o' })).toBe('gpt-4o');
    expect(vertex.extractModel('/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict', {})).toBe('claude-sonnet-4@20250514');
    expect(bedrock.extractModel('/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse-stream', {})).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    // A path that doesn't decode names its model as it was sent: reading it never throws.
    expect(bedrock.extractModel('/model/anthropic.claude%ZZ/invoke', {})).toBe('anthropic.claude%ZZ');
    expect(azure.extractModel('/openai/deployments/gpt%E0%A4%A/chat/completions', { messages: [] })).toBe('gpt%E0%A4%A');
  });

  it('read Bedrock usage and stop reasons from Converse and InvokeModel JSON', () => {
    const converse = Buffer.from(JSON.stringify({ stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 5, cacheReadInputTokens: 3 } }));
    expect(bedrock.extractUsage(converse, 'application/json')).toEqual({ inputTokens: 12, outputTokens: 5, cacheReadInputTokens: 3 });
    expect(bedrock.extractStopReason(converse, 'application/json')).toBe('end_turn');
    const invoke = Buffer.from(JSON.stringify({ stop_reason: 'max_tokens', usage: { input_tokens: 7, output_tokens: 2 } }));
    expect(bedrock.extractUsage(invoke, 'application/json')).toMatchObject({ inputTokens: 7, outputTokens: 2 });
    expect(bedrock.extractStopReason(invoke, 'application/json')).toBe('max_tokens');
  });

  it('forward only to hosts of their own', () => {
    const owns = (id: string, host: string) => providers.find((p) => p.id === id)!.hosts.test(host);
    expect(owns('bedrock', 'bedrock-runtime.eu-west-1.amazonaws.com')).toBe(true);
    expect(owns('bedrock', 'bedrock-runtime-fips.us-gov-west-1.amazonaws.com')).toBe(true);
    expect(owns('bedrock', 'bedrock-runtime.us-east-1.amazonaws.com.evil.test')).toBe(false);
    expect(owns('bedrock', 's3.amazonaws.com')).toBe(false);
    expect(owns('vertex', 'us-east5-aiplatform.googleapis.com')).toBe(true);
    expect(owns('vertex', 'aiplatform.googleapis.com')).toBe(true);
    expect(owns('vertex', 'aiplatform.eu.rep.googleapis.com')).toBe(true);
    expect(owns('vertex', 'oauth2.googleapis.com')).toBe(false);
    expect(owns('azure', 'my-resource.openai.azure.com')).toBe(true);
    expect(owns('azure', 'openai.azure.com.evil.test')).toBe(false);
    expect(owns('openai', 'api.openai.com')).toBe(true);
    expect(owns('anthropic', 'api.anthropic.com.evil.test')).toBe(false);
  });

  it('set no base URL for providers a base URL cannot redirect', () => {
    expect(azure.env('http://sidecar/azure')).toEqual({});
    expect(vertex.env('http://sidecar/vertex')).toEqual({});
    expect(bedrock.env('http://sidecar/bedrock')).toEqual({});
  });
});

describe('hosts of another provider\'s wire format', () => {
  it('read Claude on Microsoft Foundry as Anthropic\'s, under Azure\'s hosts, with its own key', () => {
    expect(azure.forPath?.('/anthropic/v1/messages')).toBe(foundry);
    expect(azure.forPath?.('/openai/deployments/gpt-4o/chat/completions')).toBeUndefined();
    expect(foundry.format).toBe('anthropic');
    // Matched as Anthropic's API names the call; its name keeps the path it was sent to.
    expect(foundry.matchPath?.('/anthropic/v1/messages')).toBe('/v1/messages');
    expect(foundry.hosts.test('my-resource.services.ai.azure.com')).toBe(true);
    expect(foundry.hosts.test('my-resource.services.ai.azure.com.evil.test')).toBe(false);
    // Usage as Anthropic reports it, cache reads included: it was read as OpenAI's, which has none of these fields.
    expect(foundry.extractUsage(Buffer.from(JSON.stringify({ type: 'message', usage: { input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 1200, cache_creation_input_tokens: 30 } })), JSON_CT)).toEqual({ inputTokens: 40, outputTokens: 9, cacheReadInputTokens: 1200, cacheCreationInputTokens: 30 });
    const streamed = sse([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 800 } } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 17 } }],
    ]);
    expect(foundry.extractUsage(streamed, SSE)).toEqual({ inputTokens: 120, outputTokens: 17, cacheReadInputTokens: 800 });
    expect(azure.extractUsage(streamed, SSE)).not.toEqual(foundry.extractUsage(streamed, SSE));
    expect(foundry.extractStopReason(streamed, SSE)).toBe('end_turn');
    expect(foundry.keys).toMatchObject({ placeholders: { ANTHROPIC_FOUNDRY_API_KEY: 'shadowlap-offline-replay-placeholder' }, set: 'ANTHROPIC_FOUNDRY_API_KEY', onlyWhereRecorded: true });
    expect(foundry.env('http://sidecar/foundry')).toEqual({});
  });

  it('capture OpenAI\'s SDK on Bedrock (bedrock-mantle) under Bedrock\'s hosts, and read it as OpenAI\'s', () => {
    expect(bedrock.hosts.test('bedrock-mantle.us-west-2.api.aws')).toBe(true);
    expect(bedrock.forPath?.('/openai/v1/responses')).toBe(bedrockMantle);
    expect(bedrock.forPath?.('/model/us.anthropic.claude-sonnet-4-5-20250929-v1:0/converse')).toBeUndefined();
    expect(bedrockMantle.hosts.test('bedrock-mantle.us-west-2.api.aws')).toBe(true);
    expect(bedrockMantle.hosts.test('bedrock-mantle.us-west-2.api.aws.evil.test')).toBe(false);
    expect(bedrockMantle.hosts.test('bedrock-runtime.us-west-2.amazonaws.com')).toBe(false);
    expect(bedrockMantle.format).toBe('openai');
    expect(bedrockMantle.matchPath?.('/openai/v1/responses')).toBe('/v1/responses');
    expect(bedrockMantle.extractUsage(Buffer.from(JSON.stringify({ object: 'response', usage: { input_tokens: 50, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } } })), JSON_CT)).toEqual({ inputTokens: 30, outputTokens: 5, cacheReadInputTokens: 20 });
    expect(bedrockMantle.retryCountHeader).toBe('x-stainless-retry-count');
    // Reached through Bedrock's route and Azure's: no route of their own.
    expect(hostedProviders.map((p) => p.id)).toEqual(['foundry', 'bedrock-mantle']);
    expect(providers.map((p) => p.id)).not.toContain('bedrock-mantle');
  });

  it('never keep the organization a key belongs to', () => {
    expect(anthropic.credentialHeaders).toContain('anthropic-organization-id');
    expect(foundry.credentialHeaders).toContain('anthropic-organization-id');
  });

  it('take a host the config declares, its format, and its root', () => {
    const router = formatHostProvider({ host: 'openrouter.ai', format: 'openai', root: '/api/v1' });
    expect(router).toMatchObject({ id: 'openrouter.ai', format: 'openai', upstream: '' });
    expect(router.matchPath?.('/api/v1/chat/completions')).toBe('/v1/chat/completions');
    expect(router.matchPath?.('/other/thing')).toBe('/other/thing');
    expect(router.accepts?.(new URL('https://openrouter.ai'))).toBe(true);
    expect(router.accepts?.(new URL('http://openrouter.ai'))).toBe(false);
    expect(router.accepts?.(new URL('https://openrouter.ai.evil.test'))).toBe(false);
    const any = formatHostProvider({ host: '*.gateway.example.com', format: 'anthropic' });
    expect(any.accepts?.(new URL('https://eu.gateway.example.com'))).toBe(true);
    expect(any.accepts?.(new URL('https://gateway.example.com'))).toBe(false);
    expect(any.matchPath).toBeUndefined();
    // With a port: that server, over http too, as a gateway on this machine is reached.
    const local = formatHostProvider({ host: 'localhost:4000', format: 'gemini', root: '/gemini' });
    expect(local.accepts?.(new URL('http://localhost:4000'))).toBe(true);
    expect(local.accepts?.(new URL('http://localhost:4001'))).toBe(false);
    expect(local.matchPath?.('/gemini/v1beta/models/gemini-2.5-flash:generateContent')).toBe('/v1beta/models/gemini-2.5-flash:generateContent');
    expect(local.extractModel('/gemini/v1beta/models/gemini-2.5-flash:generateContent', {})).toBe('gemini-2.5-flash');
  });

  it('refuse a declared host that is no host, no format, or a name Shadowlap uses', () => {
    expect(formatHostProblem({ host: 'openrouter.ai', format: 'openai', root: '/api/v1' }, 'p')).toBeNull();
    expect(formatHostProblem({ host: 'https://openrouter.ai', format: 'openai' }, 'p')).toMatch(/p\.host must be a host/);
    expect(formatHostProblem({ host: 'openrouter.ai', format: 'bedrock' }, 'p')).toMatch(/p\.format must be openai, anthropic or gemini/);
    expect(formatHostProblem({ host: 'openrouter.ai', format: 'openai', root: 'api/v1' }, 'p')).toMatch(/p\.root must be a path/);
    for (const taken of ['openai', 'foundry', 'v1', 'http', 'r', 's']) expect(formatHostProblem({ host: taken, format: 'openai' }, 'p'), taken).toMatch(/a name Shadowlap uses itself/);
    expect(formatHostProblem({ host: '*.example.com:8443', format: 'openai' }, 'p')).toMatch(/takes no \*\./);
    expect(formatHostProblem({ host: 'example.com', format: 'openai', key: 'sk-x' }, 'p')).toMatch(/"key", which a provider doesn't take/);
  });

  it('are served by every sidecar once the config declares them, and by none after', () => {
    declareFormatHosts([{ host: 'openrouter.ai', format: 'openai', root: '/api/v1' }]);
    expect(activeProviders().map((p) => p.id)).toContain('openrouter.ai');
    declareFormatHosts([]);
    expect(activeProviders()).toEqual(providers);
  });
});

