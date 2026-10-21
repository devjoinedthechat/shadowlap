import Anthropic from '@anthropic-ai/sdk';
import { APIError } from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { anthropic, carriesPlaceholder, REPLAY_AWS_KEY_ID, REPLAY_KEY, Sidecar } from '../src/index.js';

/**
 * The placeholder key an offline replay gives an agent with no key of its own (`shadowlap replay`,
 * `test`, `calibrate`). It lets the SDK send a request the recording answers; it must never reach a
 * provider's API. Here the provider's own API is the mock, so a placeholder that got through would
 * show up among its requests.
 */
let api: MockServer;
beforeAll(async () => {
  api = await startMockAnthropic({ script: () => ({ message: message([text('answered live')]) }) });
});
afterAll(() => api.close());

const params = { model: 'claude-opus-5' as const, max_tokens: 16, messages: [{ role: 'user' as const, content: 'hello' }] };

/** One call that goes live, in a recording run, with `apiKey`; the provider's own API is the mock unless `configured` names it as the upstream. */
async function liveCall(apiKey: string, configured = false) {
  const store = Store.open(':memory:');
  const sidecar = await Sidecar.start({ store, providers: [{ ...anthropic, upstream: api.url }], ...(configured ? { upstreams: { anthropic: api.url } } : {}) });
  const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
  const client = new Anthropic({ apiKey, baseURL: sidecar.envFor(run.runId).ANTHROPIC_BASE_URL, maxRetries: 2 });
  const before = api.requests.length;
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
  return { error, sent: api.requests.length - before, calls };
}

describe('a placeholder key', () => {
  it('never reaches the provider: the call is answered with why, once, and recorded as an error', async () => {
    const { error, sent, calls } = await liveCall(REPLAY_KEY);
    expect(sent).toBe(0);
    expect(error).toBeInstanceOf(APIError);
    // 401: the SDK doesn't try again, and says what Shadowlap said.
    expect((error as APIError).status).toBe(401);
    expect((error as APIError).message).toContain('the agent has no key of its own: the replay gave it a placeholder, which is never sent');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.end).toMatchObject({ outcome: 'error', meta: { status: 401, error: { name: 'ShadowlapNoKey' } } });
  });

  it('goes to an upstream configured for the provider, which asks no key of the provider’s, as any key does', async () => {
    expect(await liveCall(REPLAY_KEY, true)).toMatchObject({ error: null, sent: 1 });
    expect(await liveCall('sk-ant-a-real-key')).toMatchObject({ error: null, sent: 1 });
  });

  it('is found in any credential header, an AWS signature or the query', () => {
    expect(carriesPlaceholder({ 'x-api-key': REPLAY_KEY }, ['x-api-key'], '')).toBe(true);
    expect(carriesPlaceholder({ authorization: `Bearer ${REPLAY_KEY}` }, ['authorization'], '')).toBe(true);
    expect(carriesPlaceholder({ authorization: `AWS4-HMAC-SHA256 Credential=${REPLAY_AWS_KEY_ID}/20261021/us-east-1/bedrock/aws4_request, SignedHeaders=host, Signature=0` }, ['authorization'], '')).toBe(true);
    expect(carriesPlaceholder({}, ['x-goog-api-key'], `?alt=sse&key=${REPLAY_KEY}`)).toBe(true);
    expect(carriesPlaceholder({ 'x-api-key': 'sk-ant-real', 'x-other': REPLAY_KEY }, ['x-api-key'], '')).toBe(false);
  });
});
