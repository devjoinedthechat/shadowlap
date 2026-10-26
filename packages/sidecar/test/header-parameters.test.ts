import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprintApi, normalizersHash, storeApiRequest, Store } from '@shadowlap/engine';
import { Sidecar } from '../src/index.js';

/**
 * Bedrock's InvokeModel takes some of its parameters as headers beside its body: a guardrail and its
 * version, a trace, a latency profile and a service tier, each of which changes the answer. They are
 * part of what makes a call the same call, so a replay under another guardrail forks instead of
 * getting what the recording's guardrail let through. A recording made before calls kept them holds
 * none: it is matched without them, whatever a replay's calls say, and so are the replays it makes.
 */

const command = { argv: ['agent'], cwd: '/' };
const PATH = '/model/anthropic.claude-x/invoke';
const BODY = '{"anthropic_version":"bedrock-2023-05-31","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}';
const ANSWER = '{"id":"msg","type":"message","role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}';
/** What an agent with a guardrail sends beside its body. */
const GUARDED: Record<string, string> = { 'x-amzn-bedrock-guardrailidentifier': 'gr-1', 'x-amzn-bedrock-guardrailversion': '1', 'x-amzn-bedrock-trace': 'ENABLED' };

let upstream: Server;
let url: string;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(ANSWER);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

/** One InvokeModel call, as the AWS SDK signs it, with `headers` beside its body. */
const invoke = (sidecar: Sidecar, runId: string, headers: Record<string, string>) =>
  fetch(`${sidecar.url}/r/${runId}/bedrock${PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261026/us-east-1/bedrock/aws4_request, SignedHeaders=host;x-amz-date, Signature=abc', ...headers },
    body: BODY,
  }).then((r) => r.arrayBuffer());

/** A replay of `parentRunId` whose one call sends `headers`, offline: what it served, and its run. */
async function replay(sidecar: Sidecar, parentRunId: string, headers: Record<string, string>) {
  const run = sidecar.startRun({ mode: 'replay', parentRunId, command, offline: true });
  await invoke(sidecar, run.runId, headers);
  return { runId: run.runId, summary: sidecar.endRun(run.runId, 'completed').summary };
}

describe("Bedrock's header parameters", () => {
  it('are part of the call: a replay that changes, adds or drops one forks there, and says which', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, upstreams: { bedrock: url } });
    try {
      const rec = sidecar.startRun({ mode: 'record', command });
      await invoke(sidecar, rec.runId, GUARDED);
      sidecar.endRun(rec.runId, 'completed');
      expect(store.getRun(rec.runId)!.meta?.headerParameters).toBe(true);
      expect(store.getCalls(rec.runId)[0].meta.fingerprintHeaders).toEqual(GUARDED);

      expect((await replay(sidecar, rec.runId, GUARDED)).summary).toMatchObject({ divergence: null, byOrigin: { replayed: 1 } });
      // Another guardrail is another call, as each of the other parameters is.
      expect((await replay(sidecar, rec.runId, { ...GUARDED, 'x-amzn-bedrock-guardrailidentifier': 'gr-2' })).summary.divergence).toMatchObject({ type: 'request_changed', callNo: 1, diff: [{ path: 'headers.x-amzn-bedrock-guardrailidentifier', op: 'changed', before: 'gr-1', after: 'gr-2' }] });
      for (const [name, value] of [['x-amzn-bedrock-guardrailversion', 'DRAFT'], ['x-amzn-bedrock-trace', 'ENABLED_FULL'], ['x-amzn-bedrock-performanceconfig-latency', 'optimized'], ['x-amzn-bedrock-service-tier', 'priority']] as const) {
        expect((await replay(sidecar, rec.runId, { ...GUARDED, [name]: value })).summary.divergence, name).toMatchObject({ type: 'request_changed', callNo: 1, diff: [{ path: `headers.${name}` }] });
      }
      // No guardrail at all.
      expect((await replay(sidecar, rec.runId, { 'x-amzn-bedrock-trace': 'ENABLED' })).summary.divergence).toMatchObject({ diff: [{ path: 'headers.x-amzn-bedrock-guardrailidentifier', op: 'removed' }, { path: 'headers.x-amzn-bedrock-guardrailversion', op: 'removed' }] });

      // A recording made without one holds none, and is still told from a replay that adds one.
      const bare = sidecar.startRun({ mode: 'record', command });
      await invoke(sidecar, bare.runId, {});
      sidecar.endRun(bare.runId, 'completed');
      expect((await replay(sidecar, bare.runId, GUARDED)).summary.divergence).toMatchObject({ type: 'request_changed', diff: [{ path: 'headers.x-amzn-bedrock-guardrailidentifier', op: 'added', after: 'gr-1' }, { path: 'headers.x-amzn-bedrock-guardrailversion', op: 'added' }, { path: 'headers.x-amzn-bedrock-trace', op: 'added' }] });
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('leave a recording made before calls kept them matched whatever they say, under either clock, and so the replays it makes', async () => {
    const body = JSON.parse(BODY) as unknown;
    /** A recording without headerParameters whose one call kept `kept` among its fingerprint headers. */
    const recording = (store: Store, kept: Record<string, string>, meta: { normalizersHash?: string }) => {
      const parent = store.createRun({ mode: 'record', command, meta: { exactNumbers: true, ...meta } });
      const identity = { kind: 'api' as const, name: `POST ${PATH}`, fingerprint: fingerprintApi({ method: 'POST', path: PATH, headers: kept, body }, [], Object.keys(kept)).fingerprint, occurrence: 1 };
      store.appendCallStart({ runId: parent.runId, callNo: 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta: { provider: 'bedrock', retryCount: 0, query: '', fingerprintHeaders: kept }, at: 1 });
      store.appendCallEnd(identity, { runId: parent.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from(ANSWER)), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' } }, at: 2 });
      store.endRun(parent.runId, 'completed');
      return parent.runId;
    };
    for (const clock of ['exact', 'auto'] as const) {
      const store = Store.open(':memory:');
      const parents = {
        // As a recording made then holds the call: no header parameters, and a fingerprint made
        // without them, which the exact clock takes as it is stored.
        older: recording(store, {}, { normalizersHash: normalizersHash([], 'exact') }),
        // Another producer's, which kept them without saying so: read as it would be, without them.
        unsaid: recording(store, GUARDED, {}),
      };
      const sidecar = await Sidecar.start({ store, upstreams: { bedrock: url }, clock });
      try {
        for (const [which, parentRunId] of Object.entries(parents)) {
          for (const headers of [GUARDED, { ...GUARDED, 'x-amzn-bedrock-guardrailidentifier': 'gr-2' }, {}]) {
            const first = await replay(sidecar, parentRunId, headers);
            expect(first.summary, `${clock} ${which} ${JSON.stringify(headers)}`).toMatchObject({ divergence: null, byOrigin: { replayed: 1 } });
            // It keeps none either, so it is the recording's call, and its own replays match the same way.
            expect(store.getRun(first.runId)!.meta?.headerParameters).toBeUndefined();
            expect(store.getCalls(first.runId)[0].meta.fingerprintHeaders).toEqual({});
            expect((await replay(sidecar, first.runId, { ...GUARDED, 'x-amzn-bedrock-service-tier': 'flex' })).summary.divergence, `${clock} ${which}`).toBeNull();
          }
        }
      } finally {
        await sidecar.close();
        store.close();
      }
    }
  });
});
