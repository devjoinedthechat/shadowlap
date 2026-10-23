import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectHttp2, createServer as createHttp2Server, type Http2Server, type IncomingHttpHeaders as Http2Headers } from 'node:http2';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store, type CallRecord } from '@shadowlap/engine';
import { message, sseEvents, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { Sidecar } from '../src/server.js';
import { resignSigV4 } from '../src/sigv4.js';

/**
 * What the proxy records when something fails on the way: the upstream cut part way through an
 * answer, identical requests retried at once, the agent leaving before its answer came, the store
 * locked by another process, a signed request, a WebSocket, and telemetry. In every case the
 * recording holds what the agent saw, and the agent sees what it would have seen without
 * Shadowlap. Real SDKs where one makes the request.
 */

const command = { argv: ['agent'], cwd: '/' };
const params = { model: 'claude-opus-5' as const, max_tokens: 64, messages: [{ role: 'user' as const, content: 'best of n' }] };

const servers: Array<Server | Http2Server> = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    (s as Server).closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !ready(); await sleep(10)) if (Date.now() > end) throw new Error('timed out waiting');
}

const textOf = (m: { content: ReadonlyArray<{ type: string; text?: string }> }) => m.content.map((b) => (b.type === 'text' ? (b.text ?? '') : '')).join('');
/** The text a recorded Anthropic answer holds, JSON or streamed. */
function recordedText(store: Store, call: CallRecord): string {
  const bytes = call.end?.responseRef ? store.getBlob(call.end.responseRef)?.toString('utf8') ?? '' : '';
  if (bytes.startsWith('{')) return textOf(JSON.parse(bytes) as { content: Array<{ type: string; text?: string }> });
  return [...bytes.matchAll(/"text":"([^"]*)"/g)].map((m) => m[1]).join('');
}

const anthropic = (sidecar: Sidecar, runId: string, opts: { maxRetries?: number; timeout?: number } = {}) => new Anthropic({ apiKey: 'k', baseURL: sidecar.envFor(runId).ANTHROPIC_BASE_URL, maxRetries: opts.maxRetries ?? 0, ...(opts.timeout ? { timeout: opts.timeout } : {}) });

/** An SSE event as the Messages API writes it. */
const sse = ([event, data]: [string, unknown]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('an upstream that fails part way through a streamed answer', () => {
  it("cuts the agent's stream where the upstream cut it, records what arrived, and a replay cuts it there too", async () => {
    const events = sseEvents(message([text('an answer the upstream never finishes')]));
    const sent = events.slice(0, 4).map(sse).join('');
    const url = await serve((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(sent);
        setTimeout(() => res.socket?.destroy(), 30);
      });
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url } });
    try {
      const streamOnce = async (runId: string) => {
        const types: string[] = [];
        try {
          const stream = await anthropic(sidecar, runId).messages.create({ ...params, stream: true });
          for await (const event of stream) types.push(event.type);
          return { types, error: undefined as unknown };
        } catch (error) {
          return { types, error };
        }
      };
      const run = sidecar.startRun({ mode: 'record', command });
      const seen = await streamOnce(run.runId);
      // The SDK passes no ping on.
      expect(seen.types).toEqual(['message_start', 'content_block_start', 'content_block_delta']);
      // Without Shadowlap the SDK would have raised a network error here, not ended the stream quietly.
      expect(seen.error).toBeInstanceOf(Error);
      sidecar.endRun(run.runId, 'failed');
      const [call] = store.getCalls(run.runId);
      expect(call!.end).toMatchObject({ outcome: 'error', meta: { status: 200, retryable: true, error: { name: 'UpstreamStreamError' } } });
      expect(store.getBlob(call!.end!.responseRef!)!.toString('utf8')).toBe(sent);

      const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command, offline: true });
      const again = await streamOnce(replay.runId);
      expect(again.types).toEqual(seen.types);
      expect(again.error).toBeInstanceOf(Error);
      expect(sidecar.endRun(replay.runId, 'failed').summary.divergence).toBeNull();
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe.each([2, 3])('best-of-%i sampling where every request is rate limited once and retried', (n) => {
  let mock: MockServer;
  let served = 0;
  beforeAll(async () => {
    // Each request's first attempt is a 429; its retry is answered, slowly enough that every retry
    // is in flight at once.
    mock = await startMockAnthropic({
      script: (ctx) =>
        ctx.headers['x-stainless-retry-count'] === '0'
          ? { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, headers: { 'retry-after-ms': '10' } }
          : { message: message([text(`sample ${++served}`)]), delayMs: 80 },
    });
  });
  afterAll(() => mock.close());

  it('keeps every answer the agent got, each on its own call after its 429, and replays them all', async () => {
    const store = Store.open(':memory:');
    const logs: string[] = [];
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, log: (l) => logs.push(l) });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const client = anthropic(sidecar, run.runId, { maxRetries: 2 });
      const got = (await Promise.all(Array.from({ length: n }, () => client.messages.create(params)))).map(textOf).sort();
      expect(new Set(got).size).toBe(n);
      sidecar.endRun(run.runId, 'completed');
      const calls = store.getCalls(run.runId);
      expect(calls).toHaveLength(n);
      for (const c of calls) {
        expect(c.attempts.map((a) => [a.attempt, a.outcome, a.meta.status])).toEqual([[0, 'error', 429]]);
        expect(c.end).toMatchObject({ attempt: 1, outcome: 'ok', meta: { status: 200 } });
      }
      expect(calls.map((c) => recordedText(store, c)).sort()).toEqual(got);
      expect(logs.filter((l) => /^error:|UNIQUE/.test(l))).toEqual([]);

      const asked = mock.requests.length;
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command });
      const again = (await Promise.all(Array.from({ length: n }, () => anthropic(sidecar, replay.runId, { maxRetries: 2 }).messages.create(params)))).map(textOf).sort();
      expect(again).toEqual(got);
      expect(mock.requests.length).toBe(asked);
      const ended = sidecar.endRun(replay.runId, 'completed');
      expect(ended.summary.divergence).toBeNull();
      expect(store.getCalls(replay.runId).map((c) => c.origin)).toEqual(Array(n).fill('replayed'));
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('an agent that leaves before its answer came', () => {
  it("cuts the upstream request when the SDK times out before the headers, and the SDK's retry is the same call", async () => {
    // The first attempt is slow (1.5 s); its retry is answered at once.
    const cut: number[] = [];
    let attempts = 0;
    const url = await serve((req, res) => {
      const arrived = Date.now();
      const retry = req.headers['x-stainless-retry-count'] !== '0';
      attempts++;
      req.resume();
      req.on('end', () => {
        const answer = (t: string) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(message([text(t)])));
        };
        if (retry) return answer('second try');
        const later = setTimeout(() => answer('first try, which the agent never saw'), 1_500);
        res.on('close', () => {
          if (res.writableFinished) return;
          clearTimeout(later);
          cut.push(Date.now() - arrived);
        });
      });
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const reply = await anthropic(sidecar, run.runId, { maxRetries: 1, timeout: 300 }).messages.create(params);
      expect(textOf(reply)).toBe('second try');
      // Cut when the agent left, not left running (and billed) until it answered.
      await until(() => cut.length === 1);
      expect(cut[0]).toBeLessThan(1_000);
      sidecar.endRun(run.runId, 'completed');
      const calls = store.getCalls(run.runId);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.attempts).toHaveLength(1);
      expect(calls[0]!.attempts[0]).toMatchObject({ attempt: 0, outcome: 'error', meta: { retryable: true, error: { name: 'ClientDisconnected' } } });
      expect(calls[0]!.attempts[0]!.meta.status).toBeUndefined();
      expect(calls[0]!.end).toMatchObject({ attempt: 1, outcome: 'ok', meta: { status: 200 } });
      expect(recordedText(store, calls[0]!)).toBe('second try');

      // The replay serves the answer the agent got, and nothing else.
      const before = attempts;
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command });
      expect(textOf(await anthropic(sidecar, replay.runId, { maxRetries: 1, timeout: 300 }).messages.create(params))).toBe('second try');
      expect(sidecar.endRun(replay.runId, 'completed').summary.divergence).toBeNull();
      expect(attempts).toBe(before);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('cuts the upstream request when the agent leaves part way through a stream, and its retry is the same call', async () => {
    const cut: number[] = [];
    const url = await serve((req, res) => {
      const retry = req.headers['x-stainless-retry-count'] !== '0';
      req.resume();
      req.on('end', () => {
        const events = sseEvents(message([text(retry ? 'the whole answer' : 'an answer the agent stops reading')])).map(sse);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (retry) return res.end(events.join(''));
        res.write(events[0]);
        // The rest comes much later: a model thinking between two events.
        const later = setTimeout(() => res.end(events.slice(1).join('')), 3_000);
        res.on('close', () => {
          if (res.writableFinished) return;
          clearTimeout(later);
          cut.push(Date.now());
        });
      });
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const client = anthropic(sidecar, run.runId);
      // The agent reads the first event and stops.
      const stream = client.messages.stream(params);
      await new Promise<void>((resolve) => stream.on('streamEvent', () => resolve()));
      const left = Date.now();
      stream.abort();
      await stream.done().catch(() => {});
      await until(() => cut.length === 1);
      expect(cut[0]! - left).toBeLessThan(1_000);
      // It asks again, as its client's retry.
      const again = await client.messages.create({ ...params, stream: true }, { headers: { 'x-stainless-retry-count': '1' } });
      let streamed = '';
      for await (const event of again) if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') streamed += event.delta.text;
      expect(streamed).toBe('the whole answer');
      sidecar.endRun(run.runId, 'completed');
      const calls = store.getCalls(run.runId);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.attempts[0]).toMatchObject({ attempt: 0, outcome: 'error', meta: { status: 200, retryable: true, error: { name: 'ClientDisconnected' } } });
      expect(calls[0]!.end).toMatchObject({ attempt: 1, outcome: 'ok' });
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

describe('a store another process holds locked', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sl-locked-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('answers the agent at once, and writes its calls in order once the lock is free', async () => {
    const path = join(dir, 'locked.db');
    const store = Store.open(path);
    const mock = await startMockAnthropic({ script: (ctx) => ({ message: message([text(`answer ${ctx.requestNo}`)]) }) });
    const logs: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, log: (l) => logs.push(l), storeWrites: { waitMs: 20, deadlineMs: 10_000 } });
    const other = new DatabaseSync(path);
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      other.exec('BEGIN IMMEDIATE');
      const started = Date.now();
      const client = anthropic(sidecar, run.runId);
      const answers: string[] = [];
      for (const q of ['one', 'two', 'three']) answers.push(textOf(await client.messages.create({ ...params, messages: [{ role: 'user', content: q }] })));
      expect(answers).toEqual(['answer 1', 'answer 2', 'answer 3']);
      expect(Date.now() - started).toBeLessThan(3_000);
      // Nothing waits on the lock: the sidecar answers anything else at once.
      const asked = Date.now();
      expect((await fetch(`${sidecar.url}/v1/health`)).status).toBe(200);
      expect(Date.now() - asked).toBeLessThan(500);
      other.exec('COMMIT');
      await until(() => store.getCalls(run.runId).filter((c) => c.end).length === 3);
      const rows = other.prepare('SELECT call_no AS n, phase FROM call_events WHERE run_id = ? ORDER BY rowid').all(run.runId).map((r) => `${String(r.n)} ${String(r.phase)}`);
      expect(rows).toEqual(['1 start', '1 end', '2 start', '2 end', '3 start', '3 end']);
      expect(store.getCalls(run.runId).map((c) => recordedText(store, c))).toEqual(answers);
      expect(sidecar.endRun(run.runId, 'completed').summary.warnings.filter((w) => /store/i.test(w))).toEqual([]);
      expect(logs.filter((l) => l.startsWith('error:'))).toEqual([]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      if (other.isTransaction) other.exec('ROLLBACK');
      other.close();
      await sidecar.close();
      await mock.close();
      store.close();
    }
  });

  it('records an error end in place of an answer it could not write, says so, and never fails the agent', async () => {
    const store = Store.open(':memory:');
    const mock = await startMockAnthropic({ script: () => ({ message: message([text('an answer the disk will not take')]) }) });
    const put = store.putBlob.bind(store);
    store.putBlob = (bytes: Uint8Array) => {
      if (Buffer.from(bytes).includes('the disk will not take')) throw Object.assign(new Error('disk I/O error'), { errcode: 10 });
      return put(bytes);
    };
    const logs: string[] = [];
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url }, log: (l) => logs.push(l), storeWrites: { waitMs: 20, deadlineMs: 1_000 } });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      expect(textOf(await anthropic(sidecar, run.runId).messages.create(params))).toBe('an answer the disk will not take');
      const ended = sidecar.endRun(run.runId, 'completed');
      const [call] = store.getCalls(run.runId);
      expect(call!.end).toMatchObject({ outcome: 'error', responseRef: null, meta: { status: 200, error: { name: 'ShadowlapStoreError' } } });
      expect(call!.end!.meta.error!.message).toMatch(/disk I\/O error/);
      expect(ended.summary.warnings.join('\n')).toMatch(/could not be written to the store/);
      expect(logs.filter((l) => l.startsWith('error:'))).toEqual([]);
    } finally {
      await sidecar.close();
      await mock.close();
      store.close();
    }
  });
});

// ---- signed requests (AWS Signature Version 4) ----

const AWS = { accessKeyId: 'AKIDSHADOWLAPTEST', secretAccessKey: 'shadowlap-test-secret', region: 'us-east-1' };
const SIGNED_HOST = `bedrock-runtime.${AWS.region}.amazonaws.com`;
const MODEL_PATH = '/model/anthropic.claude-3-5-haiku-20241022-v1%3A0/invoke';
const BEDROCK_REPLY = message([text('signed and sealed')], { input_tokens: 9, output_tokens: 5 });

/** Headers for a Bedrock request signed with accept-encoding among its signed headers, as botocore signs one httpx sends. */
function signedHeaders(body: Buffer): Record<string, string> {
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const headers = {
    'accept-encoding': 'gzip, deflate',
    'content-type': 'application/json',
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${AWS.accessKeyId}/${amzDate.slice(0, 8)}/${AWS.region}/bedrock/aws4_request, SignedHeaders=accept-encoding;content-type;host;x-amz-date, Signature=${'0'.repeat(64)}`,
  };
  const signed = resignSigV4({ method: 'POST', path: MODEL_PATH, query: '', headers, body, host: SIGNED_HOST }, () => AWS);
  if ('error' in signed) throw new Error(signed.error);
  return signed.headers;
}

/** The upstream's own check of a signature, written apart from the sidecar's signer: what AWS does. */
function verifySignature(method: string, path: string, headers: Record<string, string | string[] | undefined>, body: Buffer): string | null {
  const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, ?SignedHeaders=([^,]+), ?Signature=([0-9a-f]{64})$/.exec(String(headers.authorization ?? ''));
  if (!m) return 'no signature';
  const [, , date, region, service, names, signature] = m as unknown as string[];
  const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalHeaders = names!
    .split(';')
    .map((name) => `${name}:${(name === 'host' ? SIGNED_HOST : String(headers[name] ?? '')).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const canonical = [method, path.split('/').map(enc).join('/'), '', canonicalHeaders, names, sha256(body)].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', String(headers['x-amz-date']), scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${AWS.secretAccessKey}`, date!), region!), service!), 'aws4_request');
  return hmac(key, toSign).toString('hex') === signature ? null : `signature mismatch: accept-encoding arrived as ${String(headers['accept-encoding'])}`;
}

describe('a signed request (AWS SigV4 with accept-encoding signed, as AnthropicBedrock in Python sends one)', () => {
  it('reaches the provider with the accept-encoding it was signed with, and its compressed answer is recorded decoded (HTTP/1.1)', async () => {
    const problems: Array<string | null> = [];
    const url = await serve((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const problem = verifySignature(req.method!, req.url!, req.headers, Buffer.concat(chunks));
        problems.push(problem);
        if (problem) {
          res.writeHead(403, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ message: problem }));
        }
        const body = Buffer.from(JSON.stringify(BEDROCK_REPLY));
        const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding']));
        res.writeHead(200, { 'content-type': 'application/json', ...(gzip ? { 'content-encoding': 'gzip' } : {}) });
        res.end(gzip ? gzipSync(body) : body);
      });
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const body = Buffer.from(JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
      const answer = await new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const req = httpRequest(`${sidecar.url}/r/${run.runId}/bedrock${MODEL_PATH}`, { method: 'POST', headers: signedHeaders(body) }, (res) => {
          let text = '';
          res.on('data', (d) => (text += d));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
        });
        req.on('error', reject);
        req.end(body);
      });
      expect(problems).toEqual([null]);
      expect(answer.status).toBe(200);
      expect(answer.headers['content-encoding']).toBeUndefined();
      expect(JSON.parse(answer.body)).toEqual(BEDROCK_REPLY);
      sidecar.endRun(run.runId, 'completed');
      const [call] = store.getCalls(run.runId);
      expect(call!.end!.meta.usage).toMatchObject({ inputTokens: 9, outputTokens: 5 });
      expect(JSON.parse(store.getBlob(call!.end!.responseRef!)!.toString('utf8'))).toEqual(BEDROCK_REPLY);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('does the same over HTTP/2, where the compressed answer is decoded as it is over HTTP/1.1', async () => {
    const problems: Array<string | null> = [];
    const upstream = createHttp2Server();
    servers.push(upstream);
    upstream.on('stream', (stream, headers: Http2Headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const problem = verifySignature(String(headers[':method']), String(headers[':path']), headers, Buffer.concat(chunks));
        problems.push(problem);
        if (problem) {
          stream.respond({ ':status': 403, 'content-type': 'application/json' });
          return stream.end(JSON.stringify({ message: problem }));
        }
        // Compressed whatever the request said: the sidecar decodes what it records either way.
        stream.respond({ ':status': 200, 'content-type': 'application/json', 'content-encoding': 'gzip' });
        stream.end(gzipSync(JSON.stringify(BEDROCK_REPLY)));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}` } });
    const session = connectHttp2(new URL(sidecar.http2Url).origin);
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const body = Buffer.from(JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }));
      const answer = await new Promise<{ status: number; encoding: unknown; body: string }>((resolve, reject) => {
        const stream = session.request({ ':method': 'POST', ':path': `${new URL(sidecar.http2Url).pathname}/r/${run.runId}/bedrock${MODEL_PATH}`, ':authority': SIGNED_HOST, ...signedHeaders(body) });
        let status = 0;
        let encoding: unknown;
        let text = '';
        stream.on('response', (h) => {
          status = Number(h[':status']);
          encoding = h['content-encoding'];
        });
        stream.on('data', (d: Buffer) => (text += d.toString('utf8')));
        stream.on('end', () => resolve({ status, encoding, body: text }));
        stream.on('error', reject);
        stream.end(body);
      });
      expect(problems).toEqual([null]);
      expect(answer.status).toBe(200);
      expect(answer.encoding).toBeUndefined();
      expect(JSON.parse(answer.body)).toEqual(BEDROCK_REPLY);
      sidecar.endRun(run.runId, 'completed');
      const [call] = store.getCalls(run.runId);
      expect(call!.end!.meta.usage).toMatchObject({ inputTokens: 9, outputTokens: 5 });
      expect(JSON.parse(store.getBlob(call!.end!.responseRef!)!.toString('utf8'))).toEqual(BEDROCK_REPLY);
    } finally {
      session.close();
      await sidecar.close();
      store.close();
    }
  });
});

// ---- WebSockets (OpenAI Realtime) ----

const acceptKey = (key: string) => createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');

/** One short text frame: masked as a client sends it, plain as a server does (RFC 6455). */
function frame(payload: string, masked: boolean): Buffer {
  const bytes = Buffer.from(payload, 'utf8');
  const head = Buffer.from([0x81, (masked ? 0x80 : 0) | bytes.length]);
  if (!masked) return Buffer.concat([head, bytes]);
  const mask = randomBytes(4);
  return Buffer.concat([head, mask, Buffer.from(bytes.map((b, i) => b ^ mask[i % 4]!))]);
}

/** The short text frames in `buf`, and what is left of a frame not whole yet. */
function frames(buf: Buffer): { texts: string[]; rest: Buffer } {
  const texts: string[] = [];
  let at = 0;
  while (buf.length - at >= 2) {
    const masked = (buf[at + 1]! & 0x80) !== 0;
    const len = buf[at + 1]! & 0x7f;
    const start = at + 2 + (masked ? 4 : 0);
    if (buf.length < start + len) break;
    const payload = Buffer.from(buf.subarray(start, start + len));
    if (masked) for (let i = 0; i < len; i++) payload[i]! ^= buf[at + 2 + (i % 4)]!;
    texts.push(payload.toString('utf8'));
    at = start + len;
  }
  return { texts, rest: buf.subarray(at) };
}

/** A WebSocket server that echoes each text frame, and what each handshake asked for. */
async function echoUpstream(): Promise<{ url: string; seen: Array<{ url: string; headers: IncomingHttpHeaders }> }> {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
  const server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('WebSocket only');
  });
  servers.push(server);
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    socket.on('error', () => {});
    // As a WebSocket server does: a peer that ends, ends the connection.
    socket.on('end', () => socket.end());
    seen.push({ url: req.url ?? '', headers: req.headers });
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(String(req.headers['sec-websocket-key']))}\r\n\r\n`);
    let pending = Buffer.from(head);
    socket.on('data', (d: Buffer) => {
      const { texts, rest } = frames(Buffer.concat([pending, d]));
      pending = Buffer.from(rest);
      for (const t of texts) socket.write(frame(`echo: ${t}`, false));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

type Opened = { status: 101; socket: Socket; accepted: boolean; received: () => Buffer } | { status: number; body: string };

/** A raw WebSocket handshake to `url`; once upgraded, what arrives on the socket is kept from the first byte. */
function openWebSocket(url: string, headers: Record<string, string> = {}): Promise<Opened> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const req = httpRequest(url, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key, ...headers } });
    req.on('upgrade', (res, socket, head) => {
      // The socket flows already: read from the start, or bytes are lost.
      let got = Buffer.from(head);
      socket.on('data', (d: Buffer) => (got = Buffer.concat([got, d])));
      socket.on('error', () => {});
      resolve({ status: 101, socket, accepted: res.headers['sec-websocket-accept'] === acceptKey(key), received: () => got });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function exchange(opened: Extract<Opened, { status: 101 }>, say: string): Promise<string> {
  opened.socket.write(frame(say, true));
  for (const end = Date.now() + 3_000; Date.now() < end; await sleep(10)) {
    const { texts } = frames(opened.received());
    if (texts.length) return texts[0]!;
  }
  throw new Error('no answer through the tunnel');
}

describe('a WebSocket under a provider (OpenAI Realtime)', () => {
  it('is tunnelled to the provider as it was sent, records nothing, and is named in the run summary', async () => {
    const upstream = await echoUpstream();
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { openai: upstream.url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const opened = await openWebSocket(`${sidecar.envFor(run.runId).OPENAI_BASE_URL}/realtime?model=gpt-realtime`, { authorization: 'Bearer sk-test-key' });
      expect(opened.status).toBe(101);
      if (!('socket' in opened)) throw new Error(`not upgraded: ${opened.status} ${opened.body}`);
      expect(opened.accepted).toBe(true);
      expect(await exchange(opened, 'hello')).toBe('echo: hello');
      opened.socket.destroy();
      expect(upstream.seen).toHaveLength(1);
      expect(upstream.seen[0]!.url).toBe('/v1/realtime?model=gpt-realtime');
      expect(upstream.seen[0]!.headers.authorization).toBe('Bearer sk-test-key');
      expect(upstream.seen[0]!.headers.host).toBe(new URL(upstream.url).host);
      expect(Object.keys(upstream.seen[0]!.headers).filter((h) => h.startsWith('x-shadowlap'))).toEqual([]);
      await sleep(50);
      const ended = sidecar.endRun(run.runId, 'completed');
      expect(store.getCalls(run.runId)).toEqual([]);
      expect(ended.summary.warnings.join('\n')).toMatch(/WebSocket[^\n]*openai \/v1\/realtime/);
      expect(ended.websockets).toEqual([{ target: 'openai /v1/realtime', count: 1, action: 'tunnelled' }]);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('is refused in an offline replay with a one-line reason, and never reaches the provider', async () => {
    const upstream = await echoUpstream();
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { openai: upstream.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      sidecar.endRun(rec.runId, 'completed');
      const run = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, offline: true });
      const opened = await openWebSocket(`${sidecar.envFor(run.runId).OPENAI_BASE_URL}/realtime?model=gpt-realtime`, { authorization: 'Bearer sk-test-key' });
      expect(opened.status).toBe(503);
      if (!('body' in opened)) throw new Error('upgraded');
      expect(opened.body.trim().split('\n')).toHaveLength(1);
      expect(opened.body).toMatch(/offline[^\n]*WebSocket|WebSocket[^\n]*offline/);
      expect(upstream.seen).toEqual([]);
      const ended = sidecar.endRun(run.runId, 'completed');
      expect(ended.websockets).toEqual([{ target: 'openai /v1/realtime', count: 1, action: 'refused' }]);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('goes only to a host its provider vouches for', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const opened = await openWebSocket(`${sidecar.envFor(run.runId).OPENAI_BASE_URL}/realtime`, { 'x-shadowlap-upstream': 'wss://evil.example.com' });
      expect(opened.status).toBe(403);
      sidecar.endRun(run.runId, 'completed');
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

// ---- telemetry ----

const completion = (content: string) => ({ id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'gpt-5', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } });

describe("an SDK's own telemetry (the OpenAI Agents SDK's traces, /v1/traces/ingest)", () => {
  it('is passed on while recording and never recorded, and a replay answers it with 204 itself', async () => {
    const seen: string[] = [];
    const url = await serve((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
        if (req.url === '/v1/traces/ingest') {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completion('hello')));
      });
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { openai: url } });
    const trace = (runId: string) =>
      fetch(`${sidecar.envFor(runId).OPENAI_BASE_URL}/traces/ingest`, {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'openai-beta': 'traces=v1', 'content-type': 'application/json' },
        // Every export names new random ids and times: nothing a replay could match.
        body: JSON.stringify({ data: [{ object: 'trace', id: `trace_${randomUUID().replace(/-/g, '')}`, workflow_name: 'Agent workflow' }] }),
      });
    const ask = (runId: string) => new OpenAI({ apiKey: 'sk-test', baseURL: sidecar.envFor(runId).OPENAI_BASE_URL, maxRetries: 0 }).chat.completions.create({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      expect((await trace(rec.runId)).status).toBe(204);
      expect((await ask(rec.runId)).choices[0]!.message.content).toBe('hello');
      expect((await trace(rec.runId)).status).toBe(204);
      expect(seen).toEqual(['POST /v1/traces/ingest Bearer sk-test', 'POST /v1/chat/completions Bearer sk-test', 'POST /v1/traces/ingest Bearer sk-test']);
      const recorded = sidecar.endRun(rec.runId, 'completed');
      expect(store.getCalls(rec.runId).map((c) => c.name)).toEqual(['POST /v1/chat/completions']);
      expect(recorded.summary.total).toBe(1);
      expect(recorded.summary.upstreamRequests).toBe(1);

      for (const offline of [false, true]) {
        const before = seen.length;
        const replay = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, offline });
        expect((await trace(replay.runId)).status).toBe(204);
        expect((await ask(replay.runId)).choices[0]!.message.content).toBe('hello');
        expect((await trace(replay.runId)).status).toBe(204);
        expect(seen.length).toBe(before);
        const ended = sidecar.endRun(replay.runId, 'completed');
        expect(ended.summary.divergence).toBeNull();
        expect(store.getCalls(replay.runId).map((c) => `${c.name} ${c.origin}`)).toEqual(['POST /v1/chat/completions replayed']);
      }
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});

// ---- the query string a call keeps ----

describe("a model call's query string", () => {
  it('is kept without a credential any parameter name carries (Azure API Management subscription-key)', async () => {
    const url = await serve((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(completion('hello')));
      });
    });
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { openai: url } });
    try {
      const run = sidecar.startRun({ mode: 'record', command });
      const res = await fetch(`${sidecar.envFor(run.runId).OPENAI_BASE_URL}/chat/completions?api-version=2024-10-21&subscription-key=0123456789abcdef0123456789abcdef`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
        body: JSON.stringify({ model: 'gpt-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      expect(res.status).toBe(200);
      sidecar.endRun(run.runId, 'completed');
      expect(store.getCalls(run.runId)[0]!.meta.query).toBe('api-version=2024-10-21');
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
