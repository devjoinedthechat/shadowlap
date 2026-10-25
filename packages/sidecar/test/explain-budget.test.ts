import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprintApi, normalizersHash, Store } from '@shadowlap/engine';
import { Sidecar } from '../src/index.js';

/**
 * A fork of a long run explains itself without holding the proxy up. At the first changed request,
 * the replay used to load and diff every recorded call of the same name that remained, on the
 * request's own path: a thousand calls whose requests carry the conversation so far, about a
 * gigabyte of JSON, stalled the event loop for seconds, and every agent call through the sidecar with
 * it. It now compares the request with a few recorded calls near its place in the run, once the call
 * has been answered.
 */

const CALLS = 1000;
/** About a kilobyte a turn: the conversation of call n is n turns, so the requests together carry about half a gigabyte. */
const TURN = 'The customer asked about order A-17 and its refund. '.repeat(20);
const ALLOW = ['anthropic-version', 'anthropic-beta'];
const HEADERS = { 'anthropic-version': '2023-06-01' };
const command = { argv: ['agent'], cwd: '/' };
const turns = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}: ${TURN}` }));
const request = (n: number) => ({ model: 'claude-haiku-4-5', max_tokens: 64, messages: turns(n) });

/** The longest the event loop went without running a 5 ms timer, from now until `stop`, less the 5 ms. */
function watchStalls(): { stop: () => number } {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 5);
    last = now;
  }, 5);
  return {
    stop: () => {
      clearInterval(timer);
      return Math.max(worst, performance.now() - last - 5);
    },
  };
}

let upstream: Server;
let upstreamUrl = '';
let store: Store;
let parent = '';

beforeAll(async () => {
  upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_live', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'live' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  // The recording, written as the sidecar writes one: each turn stored once, each request a manifest
  // naming the turns it carries. Fingerprints are exact for the first call, which the replay sends
  // unchanged, and made up for the rest, which it never reaches unchanged.
  store = Store.open(':memory:');
  const run = store.createRun({ mode: 'record', command, meta: { normalizersHash: normalizersHash([], 'exact') } });
  const hashes = turns(CALLS).map((t) => store.putJson(t));
  const response = store.putBlob(Buffer.from(JSON.stringify({ id: 'msg_rec', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'recorded' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1 } })));
  for (let n = 1; n <= CALLS; n++) {
    const manifest = store.putJson({ v: 1, kind: 'chunked', fields: { model: 'claude-haiku-4-5', max_tokens: 64 }, system: null, tools: null, messages: hashes.slice(0, n) });
    const fingerprint = n === 1 ? fingerprintApi({ method: 'POST', path: '/v1/messages', headers: HEADERS, body: request(1), query: '' }, [], ALLOW).fingerprint : `recorded-${n}`.padEnd(64, '0');
    const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint, occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: n, ...identity, origin: 'live', effect: null, requestRef: manifest, meta: { provider: 'anthropic', fingerprintHeaders: HEADERS, query: '' }, at: run.startedAt + n });
    store.appendCallEnd(identity, { runId: run.runId, callNo: n, attempt: 0, responseRef: response, outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' } }, at: run.startedAt + n });
  }
  store.endRun(run.runId, 'completed');
  parent = run.runId;
}, 120_000);

afterAll(async () => {
  store.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('a fork of a 1,000-call run', () => {
  it('answers the changed call at once and stalls the event loop for a few milliseconds, its report still exact', async () => {
    const sidecar = await Sidecar.start({ store, clock: 'exact', upstreams: { anthropic: upstreamUrl } });
    try {
      const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command });
      const send = (body: unknown) => fetch(`${sidecar.url}/r/${run.runId}/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...HEADERS }, body: JSON.stringify(body) });
      expect(((await (await send(request(1))).json()) as { id: string }).id).toBe('msg_rec');

      // The second call carries its conversation with its last turn changed: the fork.
      const changed = request(2);
      changed.messages[1].content = 'changed';
      const stall = watchStalls();
      const started = performance.now();
      const answer = (await (await send(changed)).json()) as { id: string };
      const answeredIn = performance.now() - started;
      // Whatever ran after the answer (the explanation) has run by the time a timer fires.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const worst = stall.stop();
      expect(answer.id).toBe('msg_live');

      // Measured on a laptop: 3 ms answered, 15 ms the longest stall (it was 2.6 s and 3.4 s); the
      // budgets leave room for a loaded machine.
      expect(answeredIn, `answered in ${answeredIn.toFixed(0)} ms`).toBeLessThan(500);
      expect(worst, `longest stall ${worst.toFixed(0)} ms`).toBeLessThan(400);

      const { summary } = sidecar.endRun(run.runId, 'completed');
      expect(summary.divergence).toMatchObject({ type: 'request_changed', callNo: 2, counterpart: { callNo: 2 }, diff: [{ path: '$.messages[1].content', op: 'changed', after: 'changed' }] });
    } finally {
      await sidecar.close();
    }
  }, 120_000);
});
