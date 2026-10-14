import { describe, expect, it } from 'vitest';
import { anthropic, azure, bedrock, gemini, openai, providers, sseDataObjects, vertex } from '../src/providers.js';

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
});

describe('cloud providers', () => {
  it('read Azure deployments, Vertex paths and Bedrock model ids as the model', () => {
    expect(azure.extractModel('/openai/deployments/gpt-4o-prod/chat/completions', { messages: [] })).toBe('gpt-4o-prod');
    expect(azure.extractModel('/openai/deployments/prod/chat/completions', { model: 'gpt-4o' })).toBe('gpt-4o');
    expect(vertex.extractModel('/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict', {})).toBe('claude-sonnet-4@20250514');
    expect(bedrock.extractModel('/model/us.anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse-stream', {})).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
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

