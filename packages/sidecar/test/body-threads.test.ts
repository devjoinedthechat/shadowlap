import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { BODY_THREADS, BodyThreads } from '../src/body-threads.js';
import { storedRequestBody, storedResponse, unreadBody, unreadResult } from '../src/http.js';
import { Sidecar } from '../src/index.js';

/**
 * A captured call's long body is masked and stored on a thread of its own, so the sidecar's thread,
 * which every agent's model streams and calls go through, isn't held while it is. Every value is
 * invented.
 */

const KEY = 'sk-test-EXAMPLE0000000000';
const apartBytes = BODY_THREADS.apartBytes;
afterEach(() => {
  BODY_THREADS.apartBytes = apartBytes;
});

/** Text shaped to be slow to mask: an object opened over and over, never closed. */
const slow = (bytes: number) => Buffer.from('{"a":'.repeat(Math.ceil(bytes / 5)));

/** How many times a timer of a millisecond fires on this thread before `promise` settles. */
async function turnsWhile(promise: Promise<unknown>): Promise<number> {
  let settled = false;
  void promise.finally(() => (settled = true));
  let turns = 0;
  while (!settled) {
    await new Promise((r) => setTimeout(r, 1));
    turns++;
  }
  return turns;
}

describe('a body stored on a thread of its own', () => {
  const bodies: Array<[string, string | undefined, Buffer]> = [
    ['json', 'application/json', Buffer.from(JSON.stringify({ api_key: KEY, query: 'refund', note: 'x'.repeat(2000) }))],
    ['text', 'text/plain', Buffer.from(`DATABASE_URL=postgres://app:${KEY}@db.example.com/app\nnote=${'y'.repeat(2000)}\n`)],
    ['form', 'application/x-www-form-urlencoded', Buffer.from(`grant_type=client_credentials&client_secret=${KEY}&scope=read`)],
    ['multipart', 'multipart/form-data; boundary=EXAMPLE', Buffer.from(`--EXAMPLE\r\nContent-Disposition: form-data; name="api_key"\r\n\r\n${KEY}\r\n--EXAMPLE--\r\n`)],
    ['event stream', 'text/event-stream', Buffer.from(`data: ${JSON.stringify({ access_token: KEY })}\n\n`)],
    ['bytes', 'application/octet-stream', Buffer.from([0, 159, 146, 150, ...Buffer.from(`token=${KEY}`)])],
    ['slow text', 'text/plain', slow(20_000)],
    ['nothing', undefined, Buffer.alloc(0)],
  ];

  it('is stored as the sidecar’s own thread stores it, a request’s and an answer’s', async () => {
    BODY_THREADS.apartBytes = 0;
    const threads = new BodyThreads();
    try {
      for (const [name, contentType, bytes] of bodies) {
        expect(await threads.request(bytes, contentType), name).toEqual(storedRequestBody(bytes, contentType));
        const head = { status: 201, headers: { 'content-type': contentType ?? 'text/plain', 'x-request-id': 'req_1' }, contentType };
        expect((await threads.response(head, bytes)).toString('utf8'), name).toBe(storedResponse(head, bytes).toString('utf8'));
      }
      expect(JSON.stringify(await threads.request(bodies[0][2], 'application/json'))).not.toContain(KEY);
    } finally {
      await threads.close();
    }
  });

  it('leaves the sidecar’s thread free meanwhile, where a body shaped to be slow held it until it was stored', async () => {
    const threads = new BodyThreads();
    try {
      const body = slow(512 * 1024);
      const head = { status: 200, headers: { 'content-type': 'text/plain' }, contentType: 'text/plain' };
      const response = threads.response(head, body);
      expect(await turnsWhile(response)).toBeGreaterThan(20);
      expect((await response).equals(storedResponse(head, body))).toBe(true);
      const request = threads.request(body, 'text/plain');
      expect(await turnsWhile(request)).toBeGreaterThan(20);
      expect(await request).toEqual(storedRequestBody(body, 'text/plain'));
    } finally {
      await threads.close();
    }
  });

  it('is stored as a placeholder when the threads end before it is, and a short body still where it was', async () => {
    const threads = new BodyThreads();
    const body = slow(4 * 1024 * 1024);
    const head = { status: 200, headers: {}, contentType: 'text/plain' };
    const response = threads.response(head, body);
    const request = threads.request(body, 'text/plain');
    await threads.close();
    expect((await response).equals(unreadResult(200))).toBe(true);
    expect(await request).toEqual(unreadBody());
    const short = Buffer.from(JSON.stringify({ api_key: KEY }));
    expect(await threads.request(short, 'application/json')).toEqual(storedRequestBody(short, 'application/json'));
  });
});

describe('a captured call with a long body', () => {
  it('reaches the service and the agent as sent, and is stored masked as a short one is', async () => {
    const service = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (d: Buffer) => chunks.push(d));
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(Buffer.concat(chunks)));
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', () => r()));
    const at = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host: new URL(at).host, effect: 'read' }] });
    try {
      const body = JSON.stringify({ api_key: KEY, query: 'refund', notes: Array.from({ length: 4000 }, (_, i) => `invented note ${i} about an order`) });
      expect(body.length).toBeGreaterThan(BODY_THREADS.apartBytes);
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      const res = await fetch(`${sidecar.url}/r/${run.runId}/http/echo`, { method: 'POST', headers: { 'x-shadowlap-upstream': at, 'content-type': 'application/json' }, body });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(body);
      sidecar.endRun(run.runId, 'completed');
      const [call] = store.getCalls(run.runId);
      expect(call.end).toMatchObject({ outcome: 'ok' });
      const sent = Buffer.from(body);
      expect(store.getJson<{ args: { body: unknown } }>(call.requestRef!)!.args.body).toEqual(storedRequestBody(sent, 'application/json').body);
      // The answer as the sidecar's own thread would have stored it, with the headers the service sent.
      const stored = store.getBlob(call.end!.responseRef!)!;
      const { headers } = (JSON.parse(stored.toString('utf8')) as { result: { headers: Record<string, string> } }).result;
      expect(stored.equals(storedResponse({ status: 200, headers, contentType: 'application/json' }, sent))).toBe(true);
      expect(JSON.stringify(store.getJson(call.requestRef!)) + stored.toString('utf8')).not.toContain(KEY);
    } finally {
      await sidecar.close();
      store.close();
      await new Promise<void>((r) => service.close(() => r()));
    }
  });

  it('holds the sidecar’s thread a fraction of what storing a body shaped to be slow in place held it', { timeout: 120_000 }, async () => {
    const service = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (d: Buffer) => chunks.push(d));
      req.on('end', () => res.writeHead(200, { 'content-type': 'text/plain' }).end(Buffer.concat(chunks)));
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', () => r()));
    const at = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host: new URL(at).host, effect: 'read' }] });
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      const post = (body: Buffer) => fetch(`${sidecar.url}/r/${run.runId}/http/echo`, { method: 'POST', headers: { 'x-shadowlap-upstream': at, 'content-type': 'text/plain' }, body }).then((r) => r.arrayBuffer());
      // A first long body starts a thread to store bodies on.
      await post(Buffer.alloc(BODY_THREADS.apartBytes, 'x'));
      // The sidecar, this test and its agent's fetch share this thread: the longest it went without a turn
      // while the call's request and its answer were each stored, on a thread of their own and then, as
      // before, in place. Both are timed alike, so a busy machine slows both.
      const body = slow(2 * 1024 * 1024);
      const apart = await longestStall(post(body));
      BODY_THREADS.apartBytes = Infinity;
      const inPlace = await longestStall(post(body));
      for (const echoed of [apart.value, inPlace.value]) expect(Buffer.from(echoed).equals(body)).toBe(true);
      expect(apart.stall, `the thread went ${apart.stall.toFixed(0)} ms without a turn, and ${inPlace.stall.toFixed(0)} ms with the bodies stored in place`).toBeLessThan(inPlace.stall / 4);
    } finally {
      await sidecar.close();
      store.close();
      await new Promise<void>((r) => service.close(() => r()));
    }
  });
});

/** What `promise` settles with, and the longest this thread went without a turn of its event loop meanwhile, in milliseconds. */
async function longestStall<T>(promise: Promise<T>): Promise<{ value: T; stall: number }> {
  let settled = false;
  void promise.finally(() => (settled = true));
  let stall = 0;
  let last = performance.now();
  while (!settled) {
    await new Promise((r) => setTimeout(r, 1));
    const now = performance.now();
    stall = Math.max(stall, now - last);
    last = now;
  }
  return { value: await promise, stall };
}
