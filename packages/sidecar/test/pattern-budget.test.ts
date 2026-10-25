import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { setPatternBudget, Store } from '@shadowlap/engine';
import { Sidecar } from '../src/index.js';

/**
 * A redacted pack carries the rules that redacted it, and a replay of it runs them on every request
 * it matches, the agent's own included: a rule someone else wrote. One the pattern check takes can
 * still read a long text from every place it could start (`.*x`), in time that grows with the
 * square of the text. A replay of such a pack never stalls on it: the rule is stopped at the time
 * budget, the call answered with why, and the replay goes on to its end.
 */

let upstream: Server;
let host: string;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"results":[]}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => upstream.close());
afterEach(() => setPatternBudget(null));

describe('a replay of a pack whose rule reads a long text from every place', () => {
  it('stops the rule at the time budget and answers the call, rather than stall the replay', async () => {
    setPatternBudget(300);
    const store = Store.open(':memory:');
    const search = (base: string, runId: string, q: string) =>
      fetch(`${base}/r/${runId}/http/search`, { method: 'POST', headers: { 'x-shadowlap-upstream': `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ q }) });
    const sidecars: Sidecar[] = [];
    try {
      const recording = await Sidecar.start({ store, http: [{ host, effect: 'read' }] });
      sidecars.push(recording);
      const run = recording.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      expect((await search(recording.url, run.runId, 'refund')).status).toBe(200);
      recording.endRun(run.runId, 'completed');
      // As a redacted copy keeps the rules that redacted it: one the check takes, `.*x`.
      store.updateRunMeta(run.runId, { redactions: [{ pattern: '/.*x/', replace: '<X>' }] });

      const replaying = await Sidecar.start({ store, http: [{ host, effect: 'read' }] });
      sidecars.push(replaying);
      const replay = replaying.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['x'], cwd: '.' } });
      // Unbudgeted, this one request would take `.*x` minutes on its 400,000 characters.
      const started = Date.now();
      const res = await search(replaying.url, replay.runId, 'a'.repeat(400_000));
      const body = await res.text();
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(body).toMatch(/ran longer than 0\.3 s on one document and was stopped/);
      // The replay goes on: a request the rule ends on at once is answered from the recording.
      expect((await search(replaying.url, replay.runId, 'refund')).status).toBe(200);
      replaying.endRun(replay.runId, 'completed');
    } finally {
      for (const s of sidecars) await s.close();
      store.close();
    }
  }, 30_000);
});
