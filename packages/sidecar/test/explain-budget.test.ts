import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fingerprintApi, loadApiRequest, normalizersHash, Store } from '@shadowlap/engine';
import { EXPLAIN_CANDIDATES } from '../../engine/src/session.js';
import { cpuOnceAsync, times, timesOf } from '../../engine/test/timing.js';
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

let upstream: Server;
/** Called as the upstream gets a request: the model call went live. */
let reachedUpstream = () => {};
let upstreamUrl = '';
let store: Store;
let parent = '';

beforeAll(async () => {
  upstream = createServer((req, res) => {
    reachedUpstream();
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
  it('sends the changed call on before it reads a recorded request to explain it, then compares it with a few near it, its report still exact', async () => {
    const sidecar = await Sidecar.start({ store, clock: 'exact', upstreams: { anthropic: upstreamUrl } });
    try {
      const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command });
      const send = (body: unknown) => fetch(`${sidecar.url}/r/${run.runId}/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', ...HEADERS }, body: JSON.stringify(body) });
      expect(((await (await send(request(1))).json()) as { id: string }).id).toBe('msg_rec');

      // Counted, not timed: each recorded request the replay reads is its manifest, read once
      // (loadApiRequest). Before, it read every one that remained, on the call's path: a 2.6 s answer
      // and a 3.4 s stall of the event loop.
      const manifests = store.getCalls(parent).map((c) => c.requestRef!);
      const recorded = new Set(manifests);
      const getJson = vi.spyOn(store, 'getJson');
      const requestsRead = () => getJson.mock.calls.filter(([ref]) => recorded.has(ref)).length;
      let readBeforeUpstream = -1;
      reachedUpstream = () => (readBeforeUpstream = requestsRead());
      // The second call carries its conversation with its last turn changed: the fork.
      const changed = request(2);
      changed.messages[1].content = 'changed';
      const fork = await cpuOnceAsync(async () => {
        const answer = (await (await send(changed)).json()) as { id: string };
        // Whatever ran after the answer (the explanation) has run by the time a timer fires.
        await new Promise((resolve) => setTimeout(resolve, 50));
        return answer;
      });
      reachedUpstream = () => {};
      const read = requestsRead();
      getJson.mockRestore();
      expect(fork.out.id).toBe('msg_live');
      expect(readBeforeUpstream, 'recorded requests read before the call went on').toBe(0);
      expect(read, 'recorded requests read to explain the fork').toBeGreaterThan(0);
      expect(read, 'recorded requests read to explain the fork').toBeLessThanOrEqual(EXPLAIN_CANDIDATES);
      // And the CPU of it all, held against reading the run's longest request once, not a number of
      // milliseconds: a few times as much, where reading every one that remained was hundreds.
      const once = timesOf({ longest: () => loadApiRequest(store, manifests.at(-1)!) }).longest;
      expect(fork.ms, `the fork took ${times(fork.ms, once)} reading the longest request`).toBeLessThan(50 * once);

      const { summary } = sidecar.endRun(run.runId, 'completed');
      expect(summary.divergence).toMatchObject({ type: 'request_changed', callNo: 2, counterpart: { callNo: 2 }, diff: [{ path: '$.messages[1].content', op: 'changed', after: 'changed' }] });
    } finally {
      await sidecar.close();
    }
  }, 120_000);
});
