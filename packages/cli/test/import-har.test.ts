import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fingerprintApi, packRun, Session, Store, unpackRun } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { NO_COMMAND } from '../src/import-capture.js';
import { importHar } from '../src/import-har.js';

const body = { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };
const response = JSON.stringify({
  id: 'msg_1',
  model: 'claude-haiku-4-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'hello' }],
  usage: { input_tokens: 12, output_tokens: 3 },
});

const entry = (over: Record<string, unknown> = {}) => ({
  startedDateTime: '2026-09-18T10:00:00.000Z',
  time: 420,
  request: {
    method: 'POST',
    url: 'https://api.anthropic.com/v1/messages',
    headers: [
      { name: 'content-type', value: 'application/json' },
      { name: 'anthropic-version', value: '2023-06-01' },
      { name: 'x-api-key', value: 'sk-ant-secret' },
      { name: 'authorization', value: 'Bearer secret' },
    ],
    postData: { mimeType: 'application/json', text: JSON.stringify(body) },
  },
  response: {
    status: 200,
    headers: [{ name: 'content-type', value: 'application/json' }],
    content: { mimeType: 'application/json', text: response },
  },
  ...over,
});

const har = (...entries: unknown[]) => ({ log: { version: '1.2', entries } });
const open = () => Store.open(':memory:');

describe('import har', () => {
  it('imports a model call with its usage, model and stop reason', () => {
    const store = open();
    const { run, imported, skipped } = importHar(store, har(entry()), { source: 'test.har' });
    expect(imported).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    expect(imported[0]).toMatchObject({ callNo: 1, name: 'POST /v1/messages', provider: 'anthropic', model: 'claude-haiku-4-5' });

    const [call] = store.getCalls(run.runId);
    expect(call.kind).toBe('api');
    expect(call.occurrence).toBe(1); // 1-based, as Session.nextOccurrence allocates
    expect(call.end?.outcome).toBe('ok');
    expect(call.end?.meta.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
    expect(call.end?.meta.stopReason).toBe('end_turn');
    expect(call.end?.meta.status).toBe(200);
    expect(call.end?.meta.latencyMs).toBe(420);
    store.close();
  });

  it('declares itself a partial recording covering only api calls', () => {
    const store = open();
    const { run } = importHar(store, har(entry()), { source: 'test.har' });
    expect(run.meta?.covers).toEqual(['api']);
    expect(run.meta?.imported?.from).toBe('test.har');
    expect(run.command.argv).toEqual([NO_COMMAND]); // a HAR says what was sent, not what sent it
    store.close();
  });

  it('never stores credentials from the capture', () => {
    const store = open();
    const { run } = importHar(store, har(entry()), { source: 'test.har' });
    const [call] = store.getCalls(run.runId);
    const headers = JSON.stringify(call.meta.fingerprintHeaders ?? {}) + JSON.stringify(call.end?.meta.headers ?? {});
    expect(headers).not.toContain('secret');
    expect(call.meta.fingerprintHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
    store.close();
  });

  it('skips entries that are not a model call or have no response body', () => {
    const store = open();
    const { imported, skipped } = importHar(
      store,
      har(
        entry(),
        { request: { method: 'GET', url: 'https://example.com/favicon.ico' }, response: { status: 200, content: { text: 'x' } } },
        entry({ response: { status: 200, headers: [], content: {} } }),
        { request: { method: 'GET', url: 'not a url' } },
      ),
      { source: 'test.har' },
    );
    expect(imported).toHaveLength(1);
    // The most basic fault is reported first: a bad URL is not "no response body".
    expect(skipped.map((s) => s.reason)).toEqual(['not a model API host', 'no response body was captured', 'not a URL']);
    store.close();
  });

  it('counts repeats of an identical request as separate occurrences', () => {
    const store = open();
    const { run } = importHar(store, har(entry(), entry()), { source: 'test.har' });
    const calls = store.getCalls(run.runId);
    expect(calls.map((c) => c.occurrence)).toEqual([1, 2]);
    expect(new Set(calls.map((c) => c.fingerprint)).size).toBe(1);
    store.close();
  });

  it('produces a fingerprint the same request matches on replay', () => {
    const store = open();
    const { run } = importHar(store, har(entry()), { source: 'test.har' });
    const parentCalls = store.getCalls(run.runId);

    // What the sidecar computes when the agent sends that request again.
    const { fingerprint } = fingerprintApi(
      { method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body },
      [],
      ['anthropic-version', 'anthropic-beta'],
    );
    expect(fingerprint).toBe(parentCalls[0].fingerprint);

    const session = new Session({ mode: 'replay', parentRunId: run.runId, parentCalls, replay: { kinds: new Set(['api']) } });
    expect(session.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint }).origin).toBe('replayed');
    store.close();
  });

  it('keeps a call\'s query without its key, and replays it by the query it was sent with', async () => {
    const path = '/v1beta/models/gemini-2.5-flash:streamGenerateContent';
    const geminiBody = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
    const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"hello"}],"role":"model"},"finishReason":"STOP"}]}\r\n\r\n';
    const streamed = entry({
      request: { method: 'POST', url: `https://generativelanguage.googleapis.com${path}?alt=sse&key=AIzaSyA-captured-key-1234567890`, headers: [{ name: 'content-type', value: 'application/json' }], postData: { mimeType: 'application/json', text: JSON.stringify(geminiBody) } },
      response: { status: 200, headers: [{ name: 'content-type', value: 'text/event-stream' }], content: { mimeType: 'text/event-stream', text: sse } },
    });
    const store = open();
    const { run } = importHar(store, har(streamed), { source: 'gemini.har' });
    const [call] = store.getCalls(run.runId);
    expect(call.meta.query).toBe('alt=sse');
    expect(JSON.stringify(store.getCalls(run.runId))).not.toContain('AIzaSyA');
    // Nothing listens there: a call that missed the recording would fail, not reach a server.
    const sidecar = await Sidecar.start({ store, clock: 'exact', upstreams: { gemini: 'http://127.0.0.1:9' } });
    try {
      for (const [query, clean] of [['alt=sse&key=AIzaSyB-another-key-0987654321', true], ['', false]] as const) {
        const rep = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['agent'], cwd: '.' }, offline: true });
        await (await fetch(`${sidecar.url}/r/${rep.runId}/gemini${path}${query ? `?${query}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(geminiBody) })).arrayBuffer();
        const divergence = sidecar.endRun(rep.runId, 'completed').summary.divergence;
        if (clean) expect(divergence, query).toBeNull();
        else expect(divergence, 'without alt=sse').toMatchObject({ type: 'request_changed', diff: [{ path: 'query.alt', op: 'removed', before: 'sse' }] });
      }
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('replays an imported Vertex AI call under either clock, as the sidecar names it without its project and region', async () => {
    const vertexPath = '/v1/projects/dev-alice-123/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict';
    const vertexBody = { anthropic_version: 'vertex-2023-10-16', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };
    const vertexEntry = entry({
      request: {
        method: 'POST',
        url: `https://us-east5-aiplatform.googleapis.com${vertexPath}`,
        headers: [{ name: 'content-type', value: 'application/json' }, { name: 'authorization', value: 'Bearer ya29.secret' }],
        postData: { mimeType: 'application/json', text: JSON.stringify(vertexBody) },
      },
    });
    for (const clock of ['exact', 'auto'] as const) {
      const store = open();
      const { run, imported } = importHar(store, har(vertexEntry), { source: 'vertex.har' });
      expect(imported[0]).toMatchObject({ provider: 'vertex' });
      // Nothing listens there: a call that missed the recording would fail, not reach a server.
      const sidecar = await Sidecar.start({ store, clock, upstreams: { vertex: 'http://127.0.0.1:9' } });
      try {
        const rep = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['agent'], cwd: '.' }, offline: true });
        const res = await fetch(`${sidecar.url}/r/${rep.runId}/vertex${vertexPath}`, { method: 'POST', headers: { authorization: 'Bearer ya29.test', 'content-type': 'application/json' }, body: JSON.stringify(vertexBody) });
        expect(res.status, clock).toBe(200);
        expect(await res.text()).toBe(response);
        expect(sidecar.endRun(rep.runId, 'completed').summary.divergence, clock).toBeNull();
      } finally {
        await sidecar.close();
        store.close();
      }
    }
  });

  it('keeps none of the parameters Bedrock takes as headers, and its replay matches whatever guardrail it names', async () => {
    // nock and VCR keep only the headers they were told to: an import can't tell a guardrail it lost from none.
    const bedrockPath = '/model/anthropic.claude-x/invoke';
    const bedrockBody = { anthropic_version: 'bedrock-2023-05-31', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };
    const bedrockEntry = entry({
      request: {
        method: 'POST',
        url: `https://bedrock-runtime.us-east-1.amazonaws.com${bedrockPath}`,
        headers: [{ name: 'content-type', value: 'application/json' }, { name: 'x-amzn-bedrock-guardrailidentifier', value: 'gr-1' }, { name: 'x-amzn-bedrock-guardrailversion', value: '1' }],
        postData: { mimeType: 'application/json', text: JSON.stringify(bedrockBody) },
      },
    });
    for (const clock of ['exact', 'auto'] as const) {
      const store = open();
      const { run } = importHar(store, har(bedrockEntry), { source: 'bedrock.har' });
      const [call] = store.getCalls(run.runId);
      expect(call.meta.fingerprintHeaders).toEqual({});
      expect(call.fingerprint).toBe(fingerprintApi({ method: 'POST', path: bedrockPath, headers: {}, body: bedrockBody }, [], []).fingerprint);
      const sidecar = await Sidecar.start({ store, clock, upstreams: { bedrock: 'http://127.0.0.1:9' } });
      try {
        const rep = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['agent'], cwd: '.' }, offline: true });
        const res = await fetch(`${sidecar.url}/r/${rep.runId}/bedrock${bedrockPath}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261026/us-east-1/bedrock/aws4_request, SignedHeaders=host, Signature=abc', 'x-amzn-bedrock-guardrailidentifier': 'gr-2', 'x-amzn-bedrock-guardrailversion': '1' }, body: JSON.stringify(bedrockBody) });
        expect(res.status, clock).toBe(200);
        expect(sidecar.endRun(rep.runId, 'completed').summary.divergence, clock).toBeNull();
      } finally {
        await sidecar.close();
        store.close();
      }
    }
  });

  it('runs kinds the recording never saw live, without ending the replay', () => {
    const store = open();
    const { run } = importHar(store, har(entry()), { source: 'test.har' });
    const parentCalls = store.getCalls(run.runId);
    const session = new Session({ mode: 'replay', parentRunId: run.runId, parentCalls, replay: { kinds: new Set(['api']) } });

    // A clock read, which no HAR can contain, comes before the model call in most agents.
    expect(session.resolve({ callNo: 1, kind: 'clock', name: 'now', fingerprint: 'clock-fp' }).origin).toBe('live');
    expect(session.state).toBe('replaying');
    expect(session.divergence).toBeNull();

    const { fingerprint } = fingerprintApi(
      { method: 'POST', path: '/v1/messages', headers: { 'anthropic-version': '2023-06-01' }, body },
      [],
      ['anthropic-version', 'anthropic-beta'],
    );
    expect(session.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint }).origin).toBe('replayed');
    store.close();
  });

  it('still fences a write tool that the partial recording never saw', () => {
    const store = open();
    const { run } = importHar(store, har(entry()), { source: 'test.har' });
    const session = new Session({
      mode: 'replay',
      parentRunId: run.runId,
      parentCalls: store.getCalls(run.runId),
      replay: { kinds: new Set(['api']), writes: 'block' },
    });
    expect(session.resolve({ callNo: 1, kind: 'tool', name: 'send_email', fingerprint: 'tool-fp', effect: 'write' }).origin).toBe('blocked');
    expect(session.resolve({ callNo: 2, kind: 'tool', name: 'search', fingerprint: 'tool-fp2', effect: 'read' }).origin).toBe('live');
    store.close();
  });

  it('rejects something that is not a HAR', () => {
    const store = open();
    expect(() => importHar(store, { entries: [] }, { source: 'x' })).toThrow(/not a HAR/);
    store.close();
  });
});

describe('a partial recording survives the trip to CI', () => {
  it('keeps its covers through pack and unpack', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-partial-'));
    try {
      const source = Store.open(':memory:');
      const { run } = importHar(source, har(entry()), { source: 'test.har' });
      packRun(source, run.runId, dir);
      source.close();

      const target = Store.open(':memory:');
      const { imported } = unpackRun(target, dir);
      expect(imported).toHaveLength(1);
      // Without this, `shadowlap test` on an imported golden diverges at the first clock read.
      expect(target.getRun(imported[0])?.meta?.covers).toEqual(['api']);
      target.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
