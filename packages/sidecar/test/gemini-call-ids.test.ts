import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '../src/index.js';

/**
 * A client that pairs Gemini's function calls with their results by id makes the ids up, a new one
 * each run (the AI SDK, and Mastra on it), and matching counts them by the order they first appear.
 * A fork's report is read as the call was matched: it names what changed, not the ids.
 */

describe('a Gemini conversation’s made-up call ids', () => {
  it('stay out of a fork’s report, which names the change matching counted', async () => {
    const gemini = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"candidates":[{"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]}'));
    });
    await new Promise<void>((r) => gemini.listen(0, '127.0.0.1', () => r()));
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { gemini: `http://127.0.0.1:${(gemini.address() as AddressInfo).port}` } });
    const body = (id: string, city: string) => JSON.stringify({ contents: [{ role: 'user', parts: [{ text: `weather in ${city}` }] }, { role: 'model', parts: [{ functionCall: { id, name: 'weather', args: {} } }] }, { role: 'user', parts: [{ functionResponse: { id, name: 'weather', response: { c: 18 } } }] }] });
    const send = async (runId: string, sent: string) => (await fetch(`${sidecar.envFor(runId).GOOGLE_GEMINI_BASE_URL}/v1beta/models/gemini-2.5-flash:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': 'EXAMPLE-key' }, body: sent })).text();
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      await send(rec.runId, body(randomUUID(), 'Oslo'));
      sidecar.endRun(rec.runId, 'completed');
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '.' }, offline: true });
      await send(rep.runId, body(randomUUID(), 'Bergen'));
      const { divergence } = sidecar.endRun(rep.runId, 'completed').summary;
      expect(divergence).toMatchObject({ type: 'request_changed', callNo: 1 });
      expect(divergence!.diff!.map((e) => e.path)).toEqual(['$.contents[0].parts[0].text']);
      await sidecar.settled(rep.runId);
      expect(store.getRun(rep.runId)!.divergence!.diff).toEqual(divergence!.diff);
    } finally {
      await sidecar.close();
      store.close();
      await new Promise<void>((r) => gemini.close(() => r()));
    }
  });
});
