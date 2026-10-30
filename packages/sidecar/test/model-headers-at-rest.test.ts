import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/index.js';

/**
 * A model call's answer can carry credentials in its headers, most often from a gateway in front of
 * the provider: a session token, an identity token, a token in a link. The agent gets them as they
 * came; the store keeps them masked, as it keeps a captured host's, so the store on disk holds none.
 */

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTTF9BVF9SRVNUX0pXVCJ9.c2lnbmF0dXJlLXNsLWF0LXJlc3Q';
const HEADERS = {
  'x-auth-token': 'SL_AT_REST_SESSION',
  'x-amzn-oidc-data': JWT,
  'x-gateway-token': 'SL_AT_REST_TOKEN',
  link: '<https://gw.example.com/v1/messages?page=2&access_token=SL_AT_REST_LINK>; rel="next"',
  'www-authenticate': 'Bearer realm="gw", error="insufficient_scope"',
  'request-id': 'req_kept_as_sent',
};

let mock: MockServer;
let store: Store;
beforeAll(async () => {
  store = Store.open(':memory:');
  mock = await startMockAnthropic({
    script: () => ({ status: 200, body: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 1 } }, headers: HEADERS }),
  });
});
afterAll(async () => {
  await mock.close();
  store.close();
});

describe('a model call’s response headers', () => {
  it('reach the agent as they came, and are kept with their credentials masked', async () => {
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      const res = await fetch(`${sidecar.envFor(run.runId).ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      await res.json();
      // The agent's answer is the provider's: its gateway session goes on working.
      expect(res.headers.get('x-auth-token')).toBe('SL_AT_REST_SESSION');
      expect(res.headers.get('x-gateway-token')).toBe('SL_AT_REST_TOKEN');
      expect(res.headers.get('x-amzn-oidc-data')).toBe(JWT);
      sidecar.endRun(run.runId, 'completed');
      const [call] = store.getCalls(run.runId).filter((c) => c.kind === 'api');
      const kept = call.end!.meta.headers!;
      expect(JSON.stringify(kept)).not.toMatch(/SL_AT_REST_|U0xfQVRfUkVTVF9KV1Q/);
      // What isn't a credential is kept as it came.
      expect(kept['request-id']).toBe('req_kept_as_sent');
      expect(kept.link).toContain('https://gw.example.com/v1/messages?page=2');
      expect(Object.keys(kept)).toEqual(expect.arrayContaining(['x-auth-token', 'x-amzn-oidc-data', 'x-gateway-token', 'link']));
    } finally {
      await sidecar.close();
    }
  });

  it('give a replay the token counts Bedrock gave the call live, which a client reads as numbers', async () => {
    const counts = { 'x-amzn-bedrock-input-token-count': '12', 'x-amzn-bedrock-output-token-count': '5', 'x-amzn-bedrock-cache-read-input-token-count': '0', 'x-amzn-bedrock-cache-write-input-token-count': '3' };
    const bedrock = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json', ...counts }).end('{"generation":"ok"}'));
    });
    await new Promise<void>((r) => bedrock.listen(0, '127.0.0.1', () => r()));
    const own = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store: own, upstreams: { bedrock: `http://127.0.0.1:${(bedrock.address() as AddressInfo).port}` } });
    // langchain-aws's ChatBedrock: int(headers.get("x-amzn-bedrock-input-token-count", 0)).
    const invoke = async (runId: string) => {
      const res = await fetch(`${sidecar.url}/r/${runId}/bedrock/model/meta.llama3-x/invoke`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE0000/20261030/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc' }, body: '{"prompt":"hi"}' });
      await res.text();
      return Object.fromEntries(Object.keys(counts).map((h) => [h, res.headers.get(h)]));
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      expect(await invoke(rec.runId)).toEqual(counts);
      sidecar.endRun(rec.runId, 'completed');
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' }, offline: true });
      expect(await invoke(rep.runId)).toEqual(counts);
      expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();
      expect(own.getCalls(rec.runId)[0].end!.meta.headers).toMatchObject(counts);
    } finally {
      await sidecar.close();
      own.close();
      bedrock.close();
    }
  });
});
