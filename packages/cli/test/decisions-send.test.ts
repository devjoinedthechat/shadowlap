import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { refusalRemedy, withoutFields } from '../src/decisions.js';
import { errorText, missingCredentials, ModelSender, providerById, upstreamOf } from '../src/decisions-send.js';

/**
 * How `shadowlap decisions` sends a recorded request again: to the upstream the sidecar would use,
 * with this machine's credentials in the headers and only there, signed where the provider signs,
 * retried as the official SDKs retry, and read with the provider's own module. A local server stands
 * in for every provider: nothing leaves the machine.
 */

let server: Server;
let base = '';
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];
let answers: Array<{ status: number; body: unknown; headers?: Record<string, string>; gzip?: boolean }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const a = answers.shift() ?? { status: 200, body: { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } } };
      const bytes = Buffer.from(JSON.stringify(a.body));
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.gzip ? { 'content-encoding': 'gzip' } : {}), ...(a.headers ?? {}) });
      res.end(a.gzip ? gzipSync(bytes) : bytes);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const noWait = { wait: () => 0 };

describe('where a request goes', () => {
  it('to the upstream the sidecar would use, else the provider host the call names', () => {
    const p = (id: string) => providerById(id)!;
    expect(upstreamOf(p('anthropic'), '/v1/messages', { upstreams: { anthropic: 'http://127.0.0.1:9/' }, env: {} })).toEqual({ base: 'http://127.0.0.1:9', official: false });
    expect(upstreamOf(p('anthropic'), '/v1/messages', { upstreams: {}, env: {} })).toEqual({ base: 'https://api.anthropic.com', official: true });
    expect(upstreamOf(p('bedrock'), '/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse', { upstreams: {}, env: { AWS_REGION: 'eu-west-1' } })).toEqual({ base: 'https://bedrock-runtime.eu-west-1.amazonaws.com', official: true });
    // A model ARN names its Region, whatever the environment says.
    expect(upstreamOf(p('bedrock'), `/model/${encodeURIComponent('arn:aws:bedrock:us-east-2:1:inference-profile/us.anthropic.x')}/invoke`, { upstreams: {}, env: { AWS_REGION: 'eu-west-1' } })).toMatchObject({ base: 'https://bedrock-runtime.us-east-2.amazonaws.com' });
    expect(upstreamOf(p('bedrock'), '/model/x/converse', { upstreams: {}, env: { HOME: '/nonexistent' } })).toEqual({ error: 'no AWS Region to send the Bedrock call to: set AWS_REGION' });
    expect(upstreamOf(p('vertex'), '/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude:rawPredict', { upstreams: {}, env: {} })).toEqual({ base: 'https://us-east5-aiplatform.googleapis.com', official: true });
    expect(upstreamOf(p('vertex'), '/v1/projects/p/locations/global/publishers/google/models/gemini:generateContent', { upstreams: {}, env: {} })).toMatchObject({ base: 'https://aiplatform.googleapis.com' });
    expect(upstreamOf(p('azure'), '/openai/deployments/d/chat/completions', { upstreams: {}, env: { AZURE_OPENAI_ENDPOINT: 'https://acme.openai.azure.com/' } })).toEqual({ base: 'https://acme.openai.azure.com', official: true });
  });

  it('needs credentials only for the provider\'s own host, and names the variable', () => {
    const p = (id: string) => providerById(id)!;
    expect(missingCredentials(p('anthropic'), true, {})).toBe('no Anthropic key: set ANTHROPIC_API_KEY');
    expect(missingCredentials(p('anthropic'), false, {})).toBeNull();
    expect(missingCredentials(p('openai'), true, { OPENAI_API_KEY: 'k' })).toBeNull();
    expect(missingCredentials(p('gemini'), true, { GOOGLE_API_KEY: 'k' })).toBeNull();
    expect(missingCredentials(p('azure'), true, {})).toBe('no Azure OpenAI key: set AZURE_OPENAI_API_KEY');
  });
});

describe('ModelSender', () => {
  it('sends the key in its header, reads usage and the stop reason with the provider module, and decodes a compressed answer', async () => {
    answers = [{ status: 200, gzip: true, body: { content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 120, output_tokens: 7, cache_read_input_tokens: 100 } } }];
    const sender = new ModelSender({ upstreams: { anthropic: base }, env: { ANTHROPIC_API_KEY: 'sk-test' }, ...noWait });
    const a = await sender.send({ provider: 'anthropic', method: 'POST', path: '/v1/messages', headers: { 'anthropic-version': '2023-06-01' }, body: { model: 'claude-x', max_tokens: 10, messages: [] } });
    expect(a).toMatchObject({ status: 200, error: null, stopReason: 'tool_use', model: 'claude-x', usage: { inputTokens: 120, outputTokens: 7, cacheReadInputTokens: 100 }, attempts: 1 });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: 'POST', url: '/v1/messages' });
    expect(last.headers).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' });
    expect(JSON.parse(last.body)).toEqual({ model: 'claude-x', max_tokens: 10, messages: [] });
  });

  it('retries what the provider says to retry, honouring retry-after, and keeps a refusal\'s words', async () => {
    answers = [{ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, headers: { 'retry-after': '0' } }, { status: 200, body: { content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }];
    const sender = new ModelSender({ upstreams: { anthropic: base }, env: {}, ...noWait });
    const ok = await sender.send({ provider: 'anthropic', method: 'POST', path: '/v1/messages', headers: {}, body: {} });
    expect(ok).toMatchObject({ status: 200, attempts: 2, error: null });
    answers = [{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-x' } } }];
    const refusal = await sender.send({ provider: 'anthropic', method: 'POST', path: '/v1/messages', headers: {}, body: {} });
    expect(refusal).toMatchObject({ status: 400, attempts: 1, error: 'HTTP 400: max_tokens: 64000 > 32000, which is the maximum allowed number of output tokens for claude-x', stopReason: null });
    expect(refusalRemedy(refusal.error!)).toEqual({ field: 'max_tokens', value: 32000 });
  });

  it('signs a Bedrock request for its Region with the AWS credentials it finds, and only in the headers', async () => {
    answers = [{ status: 200, body: { output: { message: { content: [{ text: 'hi' }] } }, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } } }];
    const sender = new ModelSender({ upstreams: { bedrock: base }, env: { AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret', AWS_SESSION_TOKEN: 'token', AWS_REGION: 'us-west-2', HOME: '/nonexistent' }, ...noWait });
    const a = await sender.send({ provider: 'bedrock', method: 'POST', path: '/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse', headers: {}, body: { messages: [] } });
    expect(a).toMatchObject({ status: 200, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } });
    const h = seen.at(-1)!.headers;
    expect(h.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    expect(h['x-amz-security-token']).toBe('token');
    expect(JSON.stringify(seen.at(-1)!.body)).not.toContain('secret');
  });

  it("strips the SDK's /v1 under a base URL that has none, as the sidecar does, and puts Gemini's alt=sse back", async () => {
    answers = [{ status: 200, body: { choices: [{ message: { content: 'x' }, finish_reason: 'stop' }] } }];
    const sender = new ModelSender({ upstreams: { openai: `${base}/inference` }, env: { OPENAI_BASE_URL: `${base}/inference`, OPENAI_API_KEY: 'k' }, ...noWait });
    await sender.send({ provider: 'openai', method: 'POST', path: '/v1/chat/completions', headers: {}, body: { model: 'm', messages: [] } });
    expect(seen.at(-1)!.url).toBe('/inference/chat/completions');
    expect(seen.at(-1)!.headers.authorization).toBe('Bearer k');
    answers = [{ status: 200, body: { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] } }];
    const gemini = new ModelSender({ upstreams: { gemini: base }, env: { GEMINI_API_KEY: 'g' }, ...noWait });
    await gemini.send({ provider: 'gemini', method: 'POST', path: '/v1beta/models/gemini-2.5-flash:streamGenerateContent', query: 'alt=sse', headers: {}, body: { contents: [] } });
    expect(seen.at(-1)).toMatchObject({ url: '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse' });
    expect(seen.at(-1)!.headers['x-goog-api-key']).toBe('g');
  });

  it('refuses to send without credentials for the provider host, before anything leaves', async () => {
    const before = seen.length;
    const sender = new ModelSender({ upstreams: {}, env: {}, ...noWait });
    expect(sender.problem('anthropic', '/v1/messages')).toBe('no Anthropic key: set ANTHROPIC_API_KEY');
    expect(await sender.send({ provider: 'anthropic', method: 'POST', path: '/v1/messages', headers: {}, body: {} })).toMatchObject({ status: 0, attempts: 0, error: 'no Anthropic key: set ANTHROPIC_API_KEY' });
    expect(seen.length).toBe(before);
  });
});

describe('what a refusal says to change', () => {
  it('reads the fields the providers name, and nothing else', () => {
    expect(refusalRemedy('HTTP 400: max_tokens is too large: 20000. This model supports at most 16384 completion tokens, whereas you provided 20000.')).toEqual({ field: 'max_tokens', value: 16384 });
    expect(refusalRemedy("HTTP 400: Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.")).toEqual({ field: 'temperature', value: 1 });
    expect(refusalRemedy('HTTP 400: messages: roles must alternate')).toBeNull();
    expect(errorText(400, Buffer.from('{"message":"ValidationException: bad"}'))).toBe('HTTP 400: ValidationException: bad');
    expect(errorText(500, Buffer.from('upstream died\nstack'))).toBe('HTTP 500: upstream died');
  });

  it('leaves a field out wherever the request shape keeps it', () => {
    expect(withoutFields('anthropic', '/v1/messages', { model: 'm', messages: [], top_p: 0.9, temperature: 0.2 }, ['top_p'])).toEqual({ model: 'm', messages: [], temperature: 0.2 });
    expect(withoutFields('gemini', '/v1beta/models/g:generateContent', { contents: [], generationConfig: { topP: 0.9, temperature: 0 } }, ['top_p'])).toEqual({ contents: [], generationConfig: { temperature: 0 } });
    expect(withoutFields('bedrock', '/model/m/converse', { messages: [], inferenceConfig: { topP: 0.9 } }, ['top_p'])).toEqual({ messages: [], inferenceConfig: {} });
  });
});
