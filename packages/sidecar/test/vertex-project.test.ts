import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '../src/index.js';
import { vertex } from '../src/providers.js';

/**
 * A Vertex AI call names the GCP project and region it is made in, which come from the environment
 * and differ per developer and in CI. A recording replays in another project, and a real change made
 * there is still compared with the recorded call.
 */
let upstream: Server;
let upstreamUrl: string;
let hits = 0;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    hits++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'refund order A-1042' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 4 } }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

const path = (project: string, region: string) => `/v1/projects/${project}/locations/${region}/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict`;

describe('a Vertex AI recording', () => {
  it('replays in another project and region, and a real change there is compared with the recorded call', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { vertex: upstreamUrl } });
    const ask = (runId: string, project: string, region: string, content = 'refund order A-1042') =>
      fetch(`${sidecar.url}/r/${runId}/vertex${path(project, region)}`, { method: 'POST', headers: { authorization: 'Bearer ya29.test', 'content-type': 'application/json' }, body: JSON.stringify({ anthropic_version: 'vertex-2023-10-16', max_tokens: 64, messages: [{ role: 'user', content }] }) });
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['a'], cwd: '.' } });
      expect((await ask(rec.runId, 'dev-alice-123', 'us-east5')).status).toBe(200);
      sidecar.endRun(rec.runId, 'completed');
      // The call keeps the path it was sent to.
      expect(store.getCalls(rec.runId)[0].name).toBe(`POST ${path('dev-alice-123', 'us-east5')}`);
      const recorded = hits;

      for (const [project, region] of [['dev-alice-123', 'us-east5'], ['ci-shared-456', 'us-east5'], ['ci-shared-456', 'europe-west1']] as const) {
        const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['a'], cwd: '.' } });
        expect((await ask(rep.runId, project, region)).status).toBe(200);
        const { summary } = sidecar.endRun(rep.runId, 'completed');
        expect(summary.divergence, `${project} ${region}`).toBeNull();
        expect(store.getCalls(rep.runId)[0].name).toBe(`POST ${path(project, region)}`);
      }
      expect(hits).toBe(recorded);

      const changed = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['a'], cwd: '.' } });
      await ask(changed.runId, 'ci-shared-456', 'us-east5', 'refund order A-2077');
      const { divergence } = sidecar.endRun(changed.runId, 'completed').summary;
      expect(divergence).toMatchObject({ type: 'request_changed', callNo: 1, counterpart: { runId: rec.runId, callNo: 1 } });
      expect(divergence!.diff).toEqual([{ path: '$.messages[0].content', op: 'changed', before: 'refund order A-1042', after: 'refund order A-2077' }]);
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('is matched without the path\'s project and location, keeping the publisher, model and method', () => {
    expect(vertex.matchPath!(path('dev-alice-123', 'us-east5'))).toBe('/v1/publishers/anthropic/models/claude-sonnet-4-5@20250929:rawPredict');
    expect(vertex.matchPath!('/v1beta1/projects/p/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent')).toBe('/v1beta1/publishers/google/models/gemini-2.5-flash:streamGenerateContent');
    // Express mode names no project.
    expect(vertex.matchPath!('/v1/publishers/google/models/gemini-2.5-flash:generateContent')).toBe('/v1/publishers/google/models/gemini-2.5-flash:generateContent');
  });
});
