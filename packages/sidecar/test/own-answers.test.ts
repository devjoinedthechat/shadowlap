import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectHttp2, constants as http2, createServer as createHttp2Server, type Http2Server } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Anthropic from '@anthropic-ai/sdk';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { providerUnavailable, Store } from '@shadowlap/engine';
import { message, text } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/server.js';

/**
 * Answers the sidecar gives an agent itself, and connections that break on the way. Each answer of
 * its own (a refused key, an offline replay, no upstream, a failure a flag injects, a blocked
 * write) is recorded with its bytes and headers, so a replay sends the agent the very same answer;
 * a provider or host that can't be reached, or that breaks off its answer, breaks the agent's
 * connection as it would have without Shadowlap, and a replay breaks it again. A path it reads a
 * model from that does not decode costs a call nothing.
 */

const command = { argv: ['agent'], cwd: '/' };
const params = { model: 'claude-opus-5' as const, max_tokens: 64, messages: [{ role: 'user' as const, content: 'where is order A-1042?' }] };
const REPLY = message([text('it ships tomorrow')]);

const servers: Array<Server | Http2Server> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    (s as Server).closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-own-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A provider that answers every model call with REPLY, and the requests it got. */
async function provider(): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const url = await serve((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(REPLY));
    });
  });
  return { url, seen };
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

interface Answer {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: string;
  /** Set when the connection broke: before an answer, or part way through one. */
  error?: string;
}

/** A raw HTTP request, as a client sends it, and what came back. */
function ask(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Answer> {
  return new Promise((resolve) => {
    const req = httpRequest(url, { method: opts.method ?? 'POST', agent: false, headers: { 'content-type': 'application/json', ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', (e) => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), error: e.message }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end(opts.body);
  });
}

const anthropicHeaders = { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'x-stainless-retry-count': '0' };
const messages = (sidecar: Sidecar, runId: string, body: unknown = params, headers: Record<string, string> = anthropicHeaders) => ask(`${sidecar.envFor(runId).ANTHROPIC_BASE_URL}/v1/messages`, { headers, body: JSON.stringify(body) });

/** What a replay must send again of an answer: its status, its body and the headers that say what it is. */
const sent = (a: Answer) => ({ status: a.status, body: a.body, type: a.headers?.['content-type'], errorType: a.headers?.['x-amzn-errortype'] });

describe('a provider that cannot be reached', () => {
  it("breaks the agent's connection as the provider's did, records it cut short with why, and a replay breaks it again", async () => {
    const dead = await closedPort();
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: `http://127.0.0.1:${dead}` } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      // The SDK sees a connection error, as it would without Shadowlap, and retries it once.
      const seen = await new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(rec.runId).ANTHROPIC_BASE_URL, maxRetries: 1 }).messages.create(params).catch((e: unknown) => e);
      expect(seen).toBeInstanceOf(Anthropic.APIConnectionError);
      const recorded = sidecar.endRun(rec.runId, 'failed');
      const [call] = store.getCalls(rec.runId);
      // The first attempt and the SDK's retry are one call, each cut short with no answer, and why.
      expect(call.attempts).toHaveLength(1);
      for (const end of [...call.attempts, call.end!]) {
        expect(end).toMatchObject({ outcome: 'error', responseRef: null, meta: { retryable: true, error: { name: 'UpstreamConnectionError', message: expect.stringMatching(/ECONNREFUSED/) as unknown } } });
        expect(end.meta.status).toBeUndefined();
      }
      expect(recorded.summary.warnings.join('\n')).toContain(`could not reach http://127.0.0.1:${dead}`);
      // The provider was unavailable, which says nothing about the agent.
      expect(providerUnavailable(store.getCalls(rec.runId))).toMatchObject({ error: 'UpstreamConnectionError', reason: expect.stringMatching(/^a connection that failed/) as unknown });

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, offline: true });
      const again = await new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(rep.runId).ANTHROPIC_BASE_URL, maxRetries: 1 }).messages.create(params).catch((e: unknown) => e);
      expect(again).toBeInstanceOf(Anthropic.APIConnectionError);
      const replayed = sidecar.endRun(rep.runId, 'failed');
      expect(replayed.summary.divergence).toBeNull();
      const [served] = store.getCalls(rep.runId);
      expect(served.origin).toBe('replayed');
      expect([...served.attempts, served.end!].map((e) => e.meta.error?.name)).toEqual(['UpstreamConnectionError', 'UpstreamConnectionError']);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('an answer the sidecar gives itself', () => {
  it('is recorded with its bytes and headers, and a replay sends the very same answer', async () => {
    const up = await provider();
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: up.url, bedrock: up.url } });
    /** A run in which the agent asks `body` once and gets what `asked` returns, then a replay of that run asking it again. */
    const twice = async (start: () => { runId: string }, asked: (runId: string) => Promise<Answer>) => {
      const run = start();
      const first = await asked(run.runId);
      sidecar.endRun(run.runId, 'completed');
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command, offline: true });
      const second = await asked(replay.runId);
      const ended = sidecar.endRun(replay.runId, 'completed');
      return { first, second, ended, run: run.runId, replay: replay.runId };
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      expect((await messages(sidecar, rec.runId)).status).toBe(200);
      sidecar.endRun(rec.runId, 'completed');
      const changed = { ...params, messages: [{ role: 'user', content: 'where is order A-2001?' }] };

      // Offline, a changed request is refused: 503, in the provider's error shape.
      const offline = await twice(() => sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, offline: true }), (runId) => messages(sidecar, runId, changed));
      expect(offline.first).toMatchObject({ status: 503, headers: { 'content-type': 'application/json', 'x-shadowlap-origin': 'offline' } });
      expect(JSON.parse(offline.first.body!)).toMatchObject({ type: 'error', error: { type: 'shadowlap_offline' } });
      expect(sent(offline.second)).toEqual(sent(offline.first));
      expect(offline.second.headers!['x-shadowlap-origin']).toBe('replayed');
      expect(offline.ended.summary.divergence).toBeNull();

      // A failure --fail-at plays in: 529, as the provider sends an overload.
      const injected = await twice(() => sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { failAt: new Map([[1, 529]]) } }), (runId) => messages(sidecar, runId));
      expect(injected.first).toMatchObject({ status: 529, headers: { 'content-type': 'application/json', 'x-shadowlap-origin': 'injected' } });
      expect(sent(injected.second)).toEqual(sent(injected.first));

      // A live Bedrock call that carries the placeholder key: 401, with the error type AWS clients read.
      const placeholder = { 'content-type': 'application/json', authorization: 'AWS4-HMAC-SHA256 Credential=SHADOWLAPREPLAY/20261025/us-east-1/bedrock/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=' + '0'.repeat(64), 'x-amz-date': '20261025T100000Z' };
      const bedrockBody = JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });
      const refused = await twice(() => sidecar.startRun({ mode: 'record', command }), (runId) => ask(`${sidecar.url}/r/${runId}/bedrock/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/invoke`, { headers: placeholder, body: bedrockBody }));
      expect(refused.first).toMatchObject({ status: 401, headers: { 'content-type': 'application/json', 'x-amzn-errortype': 'UnrecognizedClientException' } });
      expect(sent(refused.second)).toEqual(sent(refused.first));

      // A provider with no upstream for the call (Vertex AI without in-process capture): 400.
      const vertexPath = '/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-5:rawPredict';
      const nowhere = await twice(() => sidecar.startRun({ mode: 'record', command }), (runId) => ask(`${sidecar.url}/r/${runId}/vertex${vertexPath}`, { headers: { authorization: 'Bearer t' }, body: JSON.stringify({ anthropic_version: 'vertex-2023-10-16', max_tokens: 16, messages: [] }) }));
      expect(nowhere.first).toMatchObject({ status: 400, headers: { 'content-type': 'application/json' } });
      expect(JSON.parse(nowhere.first.body!)).toMatchObject({ error: { type: 'shadowlap_no_upstream' } });
      expect(sent(nowhere.second)).toEqual(sent(nowhere.first));

      // The recorded ends hold what was sent: the bytes and the headers that say what they are.
      for (const run of [offline.run, injected.run, refused.run, nowhere.run]) {
        const [call] = store.getCalls(run);
        expect(call.end!.responseRef, run).not.toBeNull();
        expect(call.end!.meta.headers?.['content-type'], run).toBe('application/json');
      }
      expect(up.seen).toEqual(['POST /v1/messages']);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('is served as an earlier version sent it, when that version recorded it without its bytes or headers', async () => {
    const up = await provider();
    const path = join(dir, 'earlier.db');
    const store = Store.open(path);
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: up.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      const asks = ['A-1', 'A-2', 'A-3'].map((id) => ({ ...params, messages: [{ role: 'user', content: `where is ${id}?` }] }));
      for (const body of asks) expect((await messages(sidecar, rec.runId, body)).status).toBe(200);
      sidecar.endRun(rec.runId, 'completed');
      // As an earlier version left them: a 502 for an upstream it could not reach and a 503 offline,
      // with no bytes; a failure it injected, its bytes kept but not its headers.
      const db = new DatabaseSync(path);
      const injectedBytes = '{"type":"error","error":{"type":"shadowlap_injected","message":"injected failure: HTTP 529 (shadowlap --fail-at 3=529)"}}';
      const blob = store.putBlob(Buffer.from(injectedBytes));
      const set = db.prepare(`UPDATE call_events SET outcome = 'error', response_ref = ?, meta = ? WHERE run_id = ? AND call_no = ? AND phase = 'end'`);
      set.run(null, JSON.stringify({ status: 502, latencyMs: 3, retryable: true, error: { name: 'UpstreamConnectionError', message: 'connect ECONNREFUSED 127.0.0.1:9' } }), rec.runId, 1);
      set.run(null, JSON.stringify({ status: 503, latencyMs: 0, retryable: false, offline: true, error: { name: 'ShadowlapOffline', message: 'shadowlap is offline: call #2 (POST /v1/messages) was not served from the recording and would need the network' } }), rec.runId, 2);
      set.run(blob, JSON.stringify({ status: 529, injected: true, retryable: true, error: { name: 'ShadowlapInjectedFailure', message: 'injected failure: HTTP 529 (shadowlap --fail-at 3=529)' }, provider: 'anthropic', bytes: injectedBytes.length, latencyMs: 0 }), rec.runId, 3);
      db.close();

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, offline: true });
      const got = [];
      for (const body of asks) got.push(await messages(sidecar, rep.runId, body));
      sidecar.endRun(rep.runId, 'completed');
      expect(got.map(sent)).toEqual([
        { status: 502, body: '{"type":"error","error":{"type":"shadowlap_upstream_error","message":"connect ECONNREFUSED 127.0.0.1:9"}}', type: 'application/json', errorType: undefined },
        { status: 503, body: '{"type":"error","error":{"type":"shadowlap_offline","message":"shadowlap is offline: call #2 (POST /v1/messages) was not served from the recording and would need the network"}}', type: 'application/json', errorType: undefined },
        { status: 529, body: injectedBytes, type: 'application/json', errorType: undefined },
      ]);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('a call to a declared HTTP host', () => {
  /** The sidecar's route for a captured call to `host`, as in-process capture sends it. */
  const captured = (sidecar: Sidecar, runId: string, host: string, path: string, body: string) => ask(`${sidecar.url}/r/${runId}/http${path}`, { headers: { 'x-shadowlap-upstream': host }, body });

  it('that the host breaks off part way, or that cannot reach it, breaks the agent\'s connection, and a replay breaks it again', async () => {
    let asked = 0;
    const host = await serve((req, res) => {
      asked++;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"results":[{"id":1,');
        setTimeout(() => res.socket?.destroy(), 20);
      });
    });
    const dead = `http://127.0.0.1:${await closedPort()}`;
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host: new URL(host).host, effect: 'read' }, { host: new URL(dead).host, effect: 'read' }] });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      const broken = await captured(sidecar, rec.runId, host, '/search', '{"q":"refund"}');
      const unreachable = await captured(sidecar, rec.runId, dead, '/search', '{"q":"refund"}');
      // No answer reached the agent either time: its connection closed, as the host's did.
      expect(broken).toEqual({ error: expect.stringMatching(/socket hang up|ECONNRESET/) as unknown });
      expect(unreachable).toEqual({ error: expect.stringMatching(/socket hang up|ECONNRESET/) as unknown });
      const recorded = sidecar.endRun(rec.runId, 'completed');
      const [one, two] = store.getCalls(rec.runId);
      expect(one.end).toMatchObject({ outcome: 'error', meta: { error: { name: 'UpstreamStreamError' } } });
      expect(two.end).toMatchObject({ outcome: 'error', meta: { error: { name: 'UpstreamConnectionError', message: expect.stringMatching(/ECONNREFUSED/) as unknown } } });
      expect(one.end!.meta.status).toBeUndefined();
      expect(recorded.summary.warnings.join('\n')).toMatch(/lost its connection to 127\.0\.0\.1:\d+ part way through the answer/);
      expect(recorded.summary.warnings.join('\n')).toMatch(/could not reach 127\.0\.0\.1:\d+/);

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      expect(await captured(sidecar, rep.runId, host, '/search', '{"q":"refund"}')).toEqual({ error: expect.stringMatching(/socket hang up|ECONNRESET/) as unknown });
      expect(await captured(sidecar, rep.runId, dead, '/search', '{"q":"refund"}')).toEqual({ error: expect.stringMatching(/socket hang up|ECONNRESET/) as unknown });
      expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();
      expect(asked).toBe(1);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('blocked after a fork is recorded as sent, and a replay of the fork sends the same answer', async () => {
    const host = await serve((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"sent":true}');
      });
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host: new URL(host).host, effect: 'write' }] });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      expect((await captured(sidecar, rec.runId, host, '/notify', '{"to":"ops"}')).status).toBe(200);
      sidecar.endRun(rec.runId, 'completed');
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { divergeAt: 1 } });
      const blocked = await captured(sidecar, fork.runId, host, '/notify', '{"to":"ops"}');
      sidecar.endRun(fork.runId, 'completed');
      expect(blocked).toMatchObject({ status: 409, headers: { 'content-type': 'application/json', 'x-shadowlap-origin': 'blocked' } });
      expect(JSON.parse(blocked.body!)).toMatchObject({ type: 'error', error: { type: 'shadowlap_write_blocked' } });

      const again = sidecar.startRun({ mode: 'replay', parentRunId: fork.runId, command });
      const replayed = await captured(sidecar, again.runId, host, '/notify', '{"to":"ops"}');
      expect(sidecar.endRun(again.runId, 'completed').summary.divergence).toBeNull();
      expect(sent(replayed)).toEqual(sent(blocked));
      expect(replayed.headers!['x-shadowlap-origin']).toBe('replayed');
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('an upstream over HTTP/2 that resets its stream part way through an answer', () => {
  it("resets the agent's stream where it was reset, records what arrived, and a replay resets it there too", async () => {
    const partial = Buffer.from('\u0000\u0000\u0000\u001fevent-stream bytes that never end');
    const upstream = createHttp2Server();
    servers.push(upstream);
    upstream.on('stream', (stream) => {
      stream.on('error', () => {});
      stream.resume();
      stream.on('end', () => {
        stream.respond({ ':status': 200, 'content-type': 'application/vnd.amazon.eventstream' });
        stream.write(partial);
        // A reset with an error, as an upstream that fails sends one (close() would end the stream first).
        setTimeout(() => stream.destroy(new Error('the upstream failed')), 30);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` } });
    const session = connectHttp2(new URL(sidecar.http2Url).origin);
    session.on('error', () => {});
    /** A streamed Bedrock call over HTTP/2, as the AWS SDK sends one: what arrived, and how its stream ended. */
    const stream = (runId: string) =>
      new Promise<{ status: number; body: Buffer; reset: boolean }>((resolve) => {
        const req = session.request({ ':method': 'POST', ':path': `${new URL(sidecar.http2Url).pathname}/r/${runId}/bedrock/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/invoke-with-response-stream`, ':authority': 'bedrock-runtime.us-east-1.amazonaws.com', 'content-type': 'application/json' });
        const chunks: Buffer[] = [];
        let status = 0;
        req.on('response', (h) => (status = Number(h[':status'])));
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('error', () => {});
        req.on('close', () => resolve({ status, body: Buffer.concat(chunks), reset: req.rstCode !== http2.NGHTTP2_NO_ERROR }));
        req.end(JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
      });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      const seen = await stream(rec.runId);
      expect(seen).toEqual({ status: 200, body: partial, reset: true });
      sidecar.endRun(rec.runId, 'failed');
      const [call] = store.getCalls(rec.runId);
      expect(call.end).toMatchObject({ outcome: 'error', meta: { status: 200, retryable: true, error: { name: 'UpstreamStreamError' } } });
      expect(store.getBlob(call.end!.responseRef!)).toEqual(partial);

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, offline: true });
      expect(await stream(rep.runId)).toEqual(seen);
      expect(sidecar.endRun(rep.runId, 'failed').summary.divergence).toBeNull();
    } finally {
      session.close();
      await sidecar.close();
      store.close();
    }
  });
});

describe('a Bedrock path that does not decode', () => {
  it("still records the call's end with the answer the agent got", async () => {
    const up = await serve((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end('{"message":"malformed model identifier"}');
      });
    });
    const store = Store.open(':memory:');
    const logs: string[] = [];
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: up }, log: (l) => logs.push(l) });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      const seen = await ask(`${sidecar.url}/r/${rec.runId}/bedrock/model/anthropic.claude%ZZ/invoke`, { body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 8, messages: [] }) });
      expect(seen).toMatchObject({ status: 400, body: '{"message":"malformed model identifier"}' });
      sidecar.endRun(rec.runId, 'completed');
      const [call] = store.getCalls(rec.runId);
      expect(call.end).toMatchObject({ outcome: 'error', meta: { status: 400, model: 'anthropic.claude%ZZ' } });
      expect(logs.filter((l) => /^error:/.test(l))).toEqual([]);
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
