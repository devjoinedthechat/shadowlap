import Anthropic, { APIError } from '@anthropic-ai/sdk';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatSummary, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { carriesPlaceholder, PLACEHOLDER_AWS_ACCESS_KEY_ID, PLACEHOLDER_KEY, resignSigV4, Sidecar, type Interventions } from '../src/index.js';

/**
 * A placeholder key, which a replay gives an agent whose environment has no key, is never sent: a
 * live call that would carry one is answered with one line instead, whatever its upstream, a
 * provider's host or a server on this machine, and so is a declared HTTP read that passes one on.
 * The mocks stay reachable throughout, and would answer anything they got: through 127.0.0.1, and
 * through 0.0.0.0, which this machine answers too but no rule takes for it.
 */

const LINE = 'a live call needs a real key: set ANTHROPIC_API_KEY, or keep the replay offline';
const AWS_LINE = 'a live call needs a real key: set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or keep the replay offline';
const signed = (keyId: string) => `AWS4-HMAC-SHA256 Credential=${keyId}/20261021/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=${'a'.repeat(64)}`;
const command = { argv: ['agent'], cwd: '/' };
const replayOptions = { writes: 'block' as const, reads: 'live' as const, liveTools: new Set<string>() };

describe('carriesPlaceholder', () => {
  it('finds the placeholder in any header, a bearer token, an AWS signature and any query value', () => {
    expect(carriesPlaceholder({ 'x-api-key': PLACEHOLDER_KEY }, '')).toBe(true);
    // A bearer token: anthropic for Python 2.0 and later sends its key so, as OpenAI's SDKs do.
    expect(carriesPlaceholder({ authorization: `Bearer ${PLACEHOLDER_KEY}` }, '')).toBe(true);
    expect(carriesPlaceholder({ 'api-key': PLACEHOLDER_KEY }, '?api-version=2024-10-21')).toBe(true);
    expect(carriesPlaceholder({ 'x-goog-api-key': PLACEHOLDER_KEY }, '')).toBe(true);
    // A key a vector store takes with each request, to embed with the caller's account.
    expect(carriesPlaceholder({ 'x-openai-api-key': PLACEHOLDER_KEY }, '')).toBe(true);
    expect(carriesPlaceholder({ cookie: ['a=1', `key=${PLACEHOLDER_KEY}`] }, '')).toBe(true);
    expect(carriesPlaceholder({}, `?alt=sse&key=${PLACEHOLDER_KEY}`)).toBe(true);
    expect(carriesPlaceholder({ authorization: signed(PLACEHOLDER_AWS_ACCESS_KEY_ID) }, '')).toBe(true);
    expect(carriesPlaceholder({}, `?X-Amz-Credential=${PLACEHOLDER_AWS_ACCESS_KEY_ID}%2F20261021%2Fus-east-1%2Fbedrock%2Faws4_request`)).toBe(true);
  });

  it('finds none in a real key, a real signature or a request without credentials', () => {
    expect(carriesPlaceholder({ 'x-api-key': 'sk-ant-real', authorization: 'Bearer sk-real' }, '?key=AIza-real')).toBe(false);
    expect(carriesPlaceholder({ authorization: signed('AKIAIOSFODNN7EXAMPLE') }, '?X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261021')).toBe(false);
    expect(carriesPlaceholder({ 'x-other': undefined }, '')).toBe(false);
  });
});

describe('a live call that would carry a placeholder', () => {
  let mock: MockServer;
  /** The mock under the address this machine answers, which no rule takes for this machine. */
  let away: string;
  beforeAll(async () => {
    mock = await startMockAnthropic({ script: ({ request: r }) => ({ message: message([text(`echo: ${JSON.stringify(r.messages.at(-1)?.content)}`)]) }) });
    away = mock.url.replace('127.0.0.1', '0.0.0.0');
  });
  afterAll(() => mock.close());

  const ask = (client: Anthropic, prompt: string) => client.messages.create({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: prompt }] });
  /** A client with the key as an API key, or as a bearer token (an auth token, a profile, anthropic for Python 2.0). */
  const client = (key: string, baseURL: string, bearer = false) => new Anthropic({ ...(bearer ? { apiKey: null, authToken: key } : { apiKey: key, authToken: null }), baseURL, maxRetries: 2 });

  async function recorded(store: Store): Promise<string> {
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    const run = sidecar.startRun({ mode: 'record', command });
    await ask(client('sk-recording', sidecar.envFor(run.runId).ANTHROPIC_BASE_URL), 'hello');
    sidecar.endRun(run.runId, 'completed');
    await sidecar.close();
    return run.runId;
  }

  async function replayed(store: Store, parentRunId: string, key: string, prompts: string[], o: { offline?: boolean; upstream?: string; bearer?: boolean } = {}) {
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: o.upstream ?? mock.url } });
    const run = sidecar.startRun({ mode: 'replay', parentRunId, command, replay: replayOptions, offline: o.offline === true });
    const c = client(key, sidecar.envFor(run.runId).ANTHROPIC_BASE_URL, o.bearer);
    const answers: string[] = [];
    let error: unknown;
    try {
      for (const prompt of prompts) answers.push(((await ask(c, prompt)).content[0] as { text: string }).text);
    } catch (err) {
      error = err;
    }
    const { summary } = sidecar.endRun(run.runId, 'completed');
    await sidecar.close();
    return { answers, error, summary, calls: store.getCalls(run.runId) };
  }

  it('replays what the recording holds: the key is never part of what a call is matched by', async () => {
    const store = Store.open(':memory:');
    const parent = await recorded(store);
    const before = mock.requests.length;
    for (const bearer of [false, true]) {
      const r = await replayed(store, parent, PLACEHOLDER_KEY, ['hello'], { bearer });
      expect(r.error).toBeUndefined();
      expect(r.answers).toEqual(['echo: "hello"']);
      expect(r.summary.divergence).toBeNull();
    }
    expect(mock.requests.length).toBe(before);
    store.close();
  });

  it('is answered with the line, once and not retried, whatever the upstream, and nothing reaches it', async () => {
    const store = Store.open(':memory:');
    const parent = await recorded(store);
    const before = mock.requests.length;
    for (const [upstream, bearer] of [[mock.url, false], [mock.url, true], [away, false], [away, true]] as const) {
      const r = await replayed(store, parent, PLACEHOLDER_KEY, ['goodbye'], { upstream, bearer });
      expect(r.error, `${upstream} ${bearer ? 'bearer' : 'x-api-key'}`).toBeInstanceOf(APIError);
      expect((r.error as APIError).status).toBe(401);
      expect(String((r.error as APIError).message)).toContain(LINE);
      // One attempt: a refused key is no failure the SDK retries.
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0].attempts).toHaveLength(0);
      expect(r.calls[0].end?.meta).toMatchObject({ status: 401, refused: true, retryable: false, error: { name: 'ShadowlapPlaceholderKey', message: LINE } });
      // Counted as refused, not as an upstream request, and the line printed under the fork.
      expect(r.summary).toMatchObject({ upstreamRequests: 0, refused: 1 });
      expect(r.summary.warnings).toEqual([LINE]);
      const printed = formatSummary(r.summary).split('\n');
      expect(printed[0]).toMatch(/^⑂ Forked at call 1: 0 calls replayed, then 0 live, 1 refused; 0 upstream requests$/);
      expect(printed).toContain(`  ! ${LINE}`);
    }
    expect(mock.requests.length).toBe(before);
    store.close();
  });

  it('is answered the same in a recording, where every call is live', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: away } });
    const run = sidecar.startRun({ mode: 'record', command });
    const before = mock.requests.length;
    await expect(ask(client(PLACEHOLDER_KEY, sidecar.envFor(run.runId).ANTHROPIC_BASE_URL), 'hello')).rejects.toMatchObject({ status: 401 });
    const { summary } = sidecar.endRun(run.runId, 'completed');
    await sidecar.close();
    expect(summary).toMatchObject({ upstreamRequests: 0, refused: 1, warnings: [LINE] });
    expect(mock.requests.length).toBe(before);
    store.close();
  });

  it('goes live with a real key, in either header, as any fork does', async () => {
    const store = Store.open(':memory:');
    const parent = await recorded(store);
    for (const bearer of [false, true]) {
      const before = mock.requests.length;
      const r = await replayed(store, parent, 'sk-real', ['goodbye'], { bearer });
      expect(r.error).toBeUndefined();
      expect(r.answers).toEqual(['echo: "goodbye"']);
      expect(mock.requests.length).toBe(before + 1);
      const sent = mock.requests.at(-1)!.headers;
      expect(bearer ? sent.authorization : sent['x-api-key']).toBe(bearer ? 'Bearer sk-real' : 'sk-real');
      expect(r.summary).toMatchObject({ upstreamRequests: 1, refused: 0, warnings: [] });
    }
    store.close();
  });

  it('is answered as offline on an offline replay, where no call goes live whatever its key', async () => {
    const store = Store.open(':memory:');
    const parent = await recorded(store);
    const before = mock.requests.length;
    const r = await replayed(store, parent, PLACEHOLDER_KEY, ['goodbye'], { offline: true });
    expect((r.error as APIError).status).toBe(503);
    expect(String((r.error as APIError).message)).toContain('shadowlap is offline');
    expect(mock.requests.length).toBe(before);
    store.close();
  });
});

describe('a Bedrock call signed with placeholder credentials', () => {
  let cloud: { url: string; stats: { requests: number }; close(): Promise<void> };
  let AWS: { accessKeyId: string; secretAccessKey: string; region: string };
  let SIGNED_HOST: string;
  beforeAll(async () => {
    const mod = (await import(new URL('../../../testing/frameworks/cloud-mock.mjs', import.meta.url).href)) as { startCloudMock: () => Promise<typeof cloud>; AWS: typeof AWS; SIGNED_HOST: string };
    cloud = await mod.startCloudMock();
    AWS = mod.AWS;
    SIGNED_HOST = mod.SIGNED_HOST;
  });
  afterAll(() => cloud.close());

  /** A Converse request signed as the AWS SDK signs it, with `keyId` (the test's own key, or the placeholder), sent as in-process capture sends it. */
  async function converse(sidecar: Sidecar, runId: string, keyId: string) {
    const path = '/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/converse';
    const body = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: [{ text: 'hello' }] }], inferenceConfig: { maxTokens: 64 } }));
    const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const headers = { 'content-type': 'application/json', 'x-amz-date': now, authorization: signed(keyId).replace('20261021', now.slice(0, 8)) };
    const signedHeaders = keyId === AWS.accessKeyId ? resignSigV4({ method: 'POST', path, query: '', headers, body, host: SIGNED_HOST }, () => AWS) : { headers };
    if ('error' in signedHeaders) throw new Error(signedHeaders.error);
    const res = await fetch(`${sidecar.url}/r/${runId}/bedrock${path}`, { method: 'POST', headers: { ...signedHeaders.headers, 'x-shadowlap-upstream': `https://${SIGNED_HOST}` }, body });
    return { status: res.status, errorType: res.headers.get('x-amzn-errortype'), body: (await res.json()) as { message?: string } };
  }

  it("is answered in AWS's shape, in a recording and after a change an intervention made, never signed again", async () => {
    const store = Store.open(':memory:');
    // Credentials for the test's own key only, as the environment would have none for the placeholder's.
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: cloud.url }, awsCredentials: (id) => (id === AWS.accessKeyId ? AWS : null) });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      expect((await converse(sidecar, rec.runId, AWS.accessKeyId)).status).toBe(200);
      sidecar.endRun(rec.runId, 'completed');
      const before = cloud.stats.requests;

      const live = sidecar.startRun({ mode: 'record', command });
      expect(await converse(sidecar, live.runId, PLACEHOLDER_AWS_ACCESS_KEY_ID)).toEqual({ status: 401, errorType: 'UnrecognizedClientException', body: { message: AWS_LINE } });
      expect(sidecar.endRun(live.runId, 'completed').summary).toMatchObject({ upstreamRequests: 0, refused: 1, warnings: [AWS_LINE] });

      // A --set that changes the request: one signed with placeholder credentials is refused for its key, not for a signature no one could make.
      const interventions: Interventions = { set: { fromCall: 1, fields: { temperature: 0 } } };
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: replayOptions, interventions });
      expect(await converse(sidecar, fork.runId, PLACEHOLDER_AWS_ACCESS_KEY_ID)).toEqual({ status: 401, errorType: 'UnrecognizedClientException', body: { message: AWS_LINE } });
      const { summary } = sidecar.endRun(fork.runId, 'completed');
      expect(summary).toMatchObject({ upstreamRequests: 0, refused: 1, warnings: [AWS_LINE] });
      expect(cloud.stats.requests).toBe(before);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('a declared HTTP read that passes a placeholder on', () => {
  let vectors: Server;
  let host = '';
  const received: Array<string | undefined> = [];
  beforeAll(async () => {
    vectors = createServer((req, res) => {
      received.push(req.headers['x-openai-api-key'] as string | undefined);
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"data":{"orders":["A-1042"]}}');
    });
    await new Promise<void>((resolve) => vectors.listen(0, '127.0.0.1', resolve));
    host = `0.0.0.0:${(vectors.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => vectors.close(() => resolve())));

  const query = (sidecar: Sidecar, runId: string, key: string) =>
    fetch(`${sidecar.url}/r/${runId}/http/v1/graphql`, { method: 'POST', headers: { 'x-shadowlap-upstream': `http://${host}`, 'content-type': 'application/json', 'x-openai-api-key': key }, body: JSON.stringify({ query: 'orders like A-1042' }) });

  it('is answered with the line when it runs live, as --live-tool runs it, and the host gets nothing', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host, effect: 'read' }] });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      // Windows answers no connection to 0.0.0.0: there the recording is all there is to check.
      const recordedStatus = (await query(sidecar, rec.runId, 'sk-real')).status;
      sidecar.endRun(rec.runId, 'completed');
      if (process.platform !== 'win32') {
        expect(recordedStatus).toBe(200);
        expect(received).toEqual(['sk-real']);
      }
      const name = `POST ${host}/v1/graphql`;
      const line = `${name}: a live call needs a real key: set the key it sends, or keep the replay offline`;
      // Replayed from the recording, it carries nothing anywhere.
      const clean = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: replayOptions });
      expect((await query(sidecar, clean.runId, PLACEHOLDER_KEY)).status).toBe(recordedStatus);
      expect(sidecar.endRun(clean.runId, 'completed').summary).toMatchObject({ divergence: null, refused: 0 });

      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { ...replayOptions, liveTools: new Set([name]) } });
      const before = received.length;
      const res = await query(sidecar, fork.runId, PLACEHOLDER_KEY);
      expect([res.status, res.headers.get('x-shadowlap-origin')]).toEqual([401, 'refused']);
      expect(await res.json()).toEqual({ type: 'error', error: { type: 'shadowlap_placeholder_key', message: line } });
      const { summary } = sidecar.endRun(fork.runId, 'completed');
      expect(summary).toMatchObject({ refused: 1, warnings: [line] });
      expect(store.getCalls(fork.runId)[0].end?.meta).toMatchObject({ status: 401, refused: true, error: { name: 'ShadowlapPlaceholderKey', message: line } });
      expect(received.length).toBe(before);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
