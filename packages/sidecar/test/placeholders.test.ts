import Anthropic from '@anthropic-ai/sdk';
import { APIError } from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { anthropic, carriesPlaceholder, onThisMachine, PLACEHOLDER_AWS_ACCESS_KEY_ID, PLACEHOLDER_KEY, Sidecar } from '../src/index.js';

/**
 * The placeholder key an offline replay gives an agent with no key of its own (`shadowlap replay`,
 * `test`, `calibrate`). It lets the SDK send a request the recording answers; it must never leave
 * this machine. The provider's API here is a host under .invalid, which no name server answers: a
 * placeholder that got through would end as a connection error, never as the refusal.
 */
let local: MockServer;
beforeAll(async () => {
  local = await startMockAnthropic({ script: () => ({ message: message([text('answered live')]) }) });
});
afterAll(() => local.close());

const params = { model: 'claude-opus-5' as const, max_tokens: 16, messages: [{ role: 'user' as const, content: 'hello' }] };

/** One call that goes live, in a recording run, with `apiKey`, to the provider's API at `api`, or to `configured` set as its upstream. */
async function liveCall(apiKey: string, o: { api: string; configured?: string }) {
  const store = Store.open(':memory:');
  const sidecar = await Sidecar.start({ store, providers: [{ ...anthropic, upstream: o.api }], ...(o.configured ? { upstreams: { anthropic: o.configured } } : {}) });
  const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
  const client = new Anthropic({ apiKey, baseURL: sidecar.envFor(run.runId).ANTHROPIC_BASE_URL, maxRetries: 2 });
  const before = local.requests.length;
  let error: unknown = null;
  try {
    await client.messages.create(params);
  } catch (err) {
    error = err;
  }
  sidecar.endRun(run.runId, 'completed');
  await sidecar.close();
  const calls = store.getCalls(run.runId);
  store.close();
  return { error, sent: local.requests.length - before, calls };
}

describe('a placeholder key', () => {
  it('never leaves this machine: the call is answered with why, once, and recorded as an error', async () => {
    const { error, calls } = await liveCall(PLACEHOLDER_KEY, { api: 'https://api.placeholder.invalid' });
    expect(error).toBeInstanceOf(APIError);
    // 401: the SDK doesn't try again, and says what Shadowlap said.
    expect((error as APIError).status).toBe(401);
    expect((error as APIError).message).toContain('would go live to api.placeholder.invalid, but the agent has no key of its own: the replay gave it a placeholder, which never leaves this machine');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.end).toMatchObject({ outcome: 'error', meta: { status: 401, error: { name: 'ShadowlapNoKey' } } });
    // Set as the provider's upstream, a host elsewhere is refused the same way.
    expect(await liveCall(PLACEHOLDER_KEY, { api: local.url, configured: 'https://models.placeholder.invalid' })).toMatchObject({ sent: 0, error: { status: 401 } });
  });

  it('goes to a server on this machine, a mock or a local model server, which asks no key of the provider’s', async () => {
    expect(await liveCall(PLACEHOLDER_KEY, { api: 'https://api.placeholder.invalid', configured: local.url })).toMatchObject({ error: null, sent: 1 });
    expect(await liveCall(PLACEHOLDER_KEY, { api: local.url })).toMatchObject({ error: null, sent: 1 });
    expect(await liveCall('sk-ant-a-real-key', { api: local.url })).toMatchObject({ error: null, sent: 1 });
  });

  it('is found in any credential header, an AWS signature or the query', () => {
    expect(carriesPlaceholder({ 'x-api-key': PLACEHOLDER_KEY }, ['x-api-key'], '')).toBe(true);
    expect(carriesPlaceholder({ authorization: `Bearer ${PLACEHOLDER_KEY}` }, ['authorization'], '')).toBe(true);
    expect(carriesPlaceholder({ authorization: `AWS4-HMAC-SHA256 Credential=${PLACEHOLDER_AWS_ACCESS_KEY_ID}/20261021/us-east-1/bedrock/aws4_request, SignedHeaders=host, Signature=0` }, ['authorization'], '')).toBe(true);
    expect(carriesPlaceholder({}, ['x-goog-api-key'], `?alt=sse&key=${PLACEHOLDER_KEY}`)).toBe(true);
    expect(carriesPlaceholder({ 'x-api-key': 'sk-ant-real', 'x-other': PLACEHOLDER_KEY }, ['x-api-key'], '')).toBe(false);
  });

  it('knows a host on this machine from one elsewhere', () => {
    for (const here of ['http://127.0.0.1:11434', 'http://localhost:8080/v1', 'http://[::1]:9000', 'http://127.0.1.1']) expect(onThisMachine(here), here).toBe(true);
    for (const away of ['https://api.anthropic.com', 'http://192.168.1.5:11434', 'http://localhost.example.com', 'offline']) expect(onThisMachine(away), away).toBe(false);
  });
});
