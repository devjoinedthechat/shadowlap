import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadApiRequest, storeApiRequest, Store } from '@shadowlap/engine';
import { Sidecar } from '../src/server.js';

/**
 * A model request's numbers as the agent sent them: an id past 2^53 in a tool's result, and a Python
 * float written `20.0`, as a Gemini functionResponse carries them. JSON.parse reads the first rounded
 * and the second as `20`, so the request was stored changed and two ids that round alike matched as
 * one request. A recording made before requests kept their numbers still matches as it was stored.
 */

const command = { argv: ['agent'], cwd: '/' };
const PATH = '/v1beta/models/gemini-2.5-flash:generateContent';
const ANSWER = JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'It ships tomorrow.' }] }, finishReason: 'STOP' }] });
/** A request whose function response holds `id` and a total of 20.0, as an agent's JSON writes them. */
const request = (id: string, extra = '') => `{"contents":[{"role":"user","parts":[{"text":"look up order"}]},{"role":"function","parts":[{"functionResponse":{"name":"lookup","response":{"order_id":${id},"total":20.0}}}]}]${extra}}`;

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** Gemini, answering every call, and the bodies it got as they arrived. */
async function gemini(answer: (path: string) => string = () => ANSWER): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(answer((req.url ?? '').split('?')[0]));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const ask = (sidecar: Sidecar, runId: string, raw: string, path = PATH) => fetch(`${sidecar.envFor(runId).GOOGLE_GEMINI_BASE_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'k' }, body: raw }).then((r) => r.arrayBuffer());

describe("a model request's numbers", () => {
  it('are stored as the agent sent them, and two ids that round alike are two requests', async () => {
    const up = await gemini();
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { gemini: up.url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await ask(sidecar, rec.runId, request('12345678901234567891'));
      sidecar.endRun(rec.runId, 'completed');
      const [call] = store.getCalls(rec.runId);
      expect(JSON.stringify(loadApiRequest(store, call.requestRef!, { exact: true }))).toContain('"response":{"order_id":12345678901234567891,"total":20.0}');
      expect(store.getRun(rec.runId)!.meta?.exactNumbers).toBe(true);

      // The very same request replays.
      const same = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      await ask(sidecar, same.runId, request('12345678901234567891'));
      expect(sidecar.endRun(same.runId, 'completed').summary).toMatchObject({ divergence: null, byOrigin: { replayed: 1 } });

      // One whose id differs past 2^53, where a double holds it no more, is another request: it forks there.
      const other = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command });
      await ask(sidecar, other.runId, request('12345678901234567892'));
      const { summary } = sidecar.endRun(other.runId, 'completed');
      expect(summary.divergence).toMatchObject({ type: 'request_changed', callNo: 1, diff: [{ path: '$.contents[1].parts[0].functionResponse.response.order_id', op: 'changed', before: '12345678901234567891', after: '12345678901234567892' }] });
      // It went upstream as the agent sent it.
      expect(up.seen.at(-1)).toBe(request('12345678901234567892'));
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('match a recording made before requests kept them as it was stored, rounded', async () => {
    const up = await gemini();
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { gemini: up.url } });
    try {
      // As a recording made then holds the call: its request read by JSON.parse, and no exactNumbers.
      const parent = store.createRun({ mode: 'record', command });
      const identity = { kind: 'api' as const, name: `POST ${PATH}`, fingerprint: '0'.repeat(64), occurrence: 1 };
      store.appendCallStart({ runId: parent.runId, callNo: 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, JSON.parse(request('12345678901234567891'))), meta: { provider: 'gemini', query: '', fingerprintHeaders: {} }, at: 1 });
      store.appendCallEnd(identity, { runId: parent.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from(ANSWER)), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' } }, at: 2 });
      store.endRun(parent.runId, 'completed');

      const replay = sidecar.startRun({ mode: 'replay', parentRunId: parent.runId, command });
      await ask(sidecar, replay.runId, request('12345678901234567891'));
      expect(sidecar.endRun(replay.runId, 'completed').summary).toMatchObject({ divergence: null, byOrigin: { replayed: 1 } });
      expect(up.seen).toEqual([]);
      // The replay itself keeps the request as sent, so its own replays tell the ids apart.
      expect(store.getRun(replay.runId)!.meta?.exactNumbers).toBe(true);
      const [kept] = store.getCalls(replay.runId);
      expect(JSON.stringify(loadApiRequest(store, kept.requestRef!, { exact: true }))).toContain('"order_id":12345678901234567891');
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('go upstream as the agent sent them when the request is sent with what the recording left on the provider\'s side', async () => {
    const up = await gemini((path) => (path.endsWith('/cachedContents') ? JSON.stringify({ name: 'cachedContents/orders' }) : ANSWER));
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { gemini: up.url } });
    const agent = async (runId: string) => {
      await ask(sidecar, runId, JSON.stringify({ model: 'models/gemini-2.5-flash', contents: [{ role: 'user', parts: [{ text: 'POLICY' }] }] }), '/v1beta/cachedContents');
      await ask(sidecar, runId, request('12345678901234567891', ',"cachedContent":"cachedContents/orders"'));
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await agent(rec.runId);
      sidecar.endRun(rec.runId, 'completed');
      const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command, replay: { divergeAt: 2 } });
      await agent(fork.runId);
      sidecar.endRun(fork.runId, 'completed');
      // Rebuilt with the cache's contents in place of it, each of the agent's numbers as it wrote it.
      expect(up.seen.at(-1)).toContain('"response":{"order_id":12345678901234567891,"total":20.0}');
      expect(up.seen.at(-1)).not.toContain('cachedContent');
    } finally {
      await sidecar.close();
      store.close();
    }
  });
});
