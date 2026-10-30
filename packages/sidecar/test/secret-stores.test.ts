import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER, fingerprintTool, normalizersHash, Store, type RunRecord } from '@shadowlap/engine';
import { BODY_THREADS } from '../src/body-threads.js';
import { Sidecar } from '../src/index.js';

/**
 * A secret store's answer reaches the agent as it came and is stored with the secret masked by its
 * shape, what names the secret kept; a Secret's manifest a call sends is stored and matched with its
 * secret masked, against a recording made before as well. Every value is invented.
 */

const C = CREDENTIAL_PLACEHOLDER;
const command = { argv: ['agent'], cwd: '.' };
const b64 = (text: string) => Buffer.from(text).toString('base64');

/** What a read of Vault's KV engine (version 1, at its default mount) and of a Kubernetes Secret answer. */
const ANSWERS: Record<string, unknown> = {
  '/v1/secret/prod/db': { request_id: 'b0e1c2d3-0000-4000-8000-000000000001', lease_id: '', renewable: false, lease_duration: 2764800, data: { db: 'EXAMPLE-vault-0123', user: 'app' }, wrap_info: null },
  '/api/v1/namespaces/prod/secrets/db': { apiVersion: 'v1', data: { url: b64('EXAMPLE-k8s-0123') }, kind: 'Secret', metadata: { name: 'db', namespace: 'prod' }, type: 'Opaque' },
};
const SECRETS = ['EXAMPLE-vault-0123', b64('EXAMPLE-k8s-0123'), 'EXAMPLE-manifest'];

/** A Secret's manifest, to create one holding `note`. */
const manifest = (note: string) => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'api', namespace: 'prod' }, stringData: { note } });

let service: { at: string; host: string; close: () => Promise<void> };
let store: Store;
const sidecars: Sidecar[] = [];
const apartBytes = BODY_THREADS.apartBytes;

/** Vault and a Kubernetes API server in one: a read answered as each writes its answer; a created Secret answered with its name. */
beforeEach(async () => {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const answer = req.method === 'POST' ? { kind: 'Secret', metadata: { name: 'api', namespace: 'prod' } } : ANSWERS[req.url ?? ''];
      res.writeHead(answer ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(answer ?? {}));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  service = { at: `http://${host}`, host, close: () => new Promise<void>((r) => server.close(() => r())) };
  store = Store.open(':memory:');
});

afterEach(async () => {
  BODY_THREADS.apartBytes = apartBytes;
  for (const s of sidecars.splice(0)) await s.close();
  store.close();
  await service.close();
});

async function sidecar(): Promise<Sidecar> {
  const started = await Sidecar.start({ store, http: [{ host: service.host, effect: 'read' }], clock: 'exact' });
  sidecars.push(started);
  return started;
}

/** The agent's call to `path`, a manifest sent with a POST: the answer's body as it got it. */
async function call(s: Sidecar, runId: string, path: string, sent?: unknown): Promise<{ status: number; text: string }> {
  const init = sent === undefined ? {} : { method: 'POST', body: JSON.stringify(sent) };
  const res = await fetch(`${s.url}/r/${runId}/http${path}`, { ...init, headers: { 'content-type': 'application/json', 'x-shadowlap-upstream': service.at } });
  return { status: res.status, text: await res.text() };
}

/** Everything a run stored of its calls: their arguments and their answers. */
function storedOf(runId: string): string {
  return store
    .getCalls(runId)
    .flatMap((c) => [c.requestRef, c.end?.responseRef])
    .filter((ref): ref is string => !!ref)
    .map((ref) => store.getBlob(ref)!.toString('utf8'))
    .join('\n');
}

describe('a secret store’s answer', () => {
  it('reaches the agent as it came and is stored with the secret masked, what names it kept, on the sidecar’s thread and on one of its own; a replay answers with it masked', async () => {
    for (const apart of [apartBytes, 0]) {
      BODY_THREADS.apartBytes = apart;
      const s = await sidecar();
      const run = s.startRun({ mode: 'record', command });
      const live = [await call(s, run.runId, '/v1/secret/prod/db'), await call(s, run.runId, '/api/v1/namespaces/prod/secrets/db'), await call(s, run.runId, '/api/v1/namespaces/prod/secrets', manifest('EXAMPLE-manifest'))];
      s.endRun(run.runId, 'completed');
      expect(live.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(live[0].text).toContain('EXAMPLE-vault-0123');
      expect(live[1].text).toContain(b64('EXAMPLE-k8s-0123'));
      const kept = storedOf(run.runId);
      for (const secret of SECRETS) expect(kept, `${secret}, ${apart ? 'in place' : 'apart'}`).not.toContain(secret);
      for (const name of ['b0e1c2d3-0000-4000-8000-000000000001', '"namespace":"prod"', '"name":"api"']) expect(kept, name).toContain(name);

      const replay = s.startRun({ mode: 'replay', parentRunId: run.runId, command, offline: true });
      const replayed = [await call(s, replay.runId, '/v1/secret/prod/db'), await call(s, replay.runId, '/api/v1/namespaces/prod/secrets/db'), await call(s, replay.runId, '/api/v1/namespaces/prod/secrets', manifest('EXAMPLE-manifest'))];
      expect(s.endRun(replay.runId, 'completed').summary.divergence).toBeNull();
      expect(JSON.parse(replayed[0].text)).toEqual({ ...(ANSWERS['/v1/secret/prod/db'] as object), data: { db: C, user: C } });
      expect(JSON.parse(replayed[1].text)).toEqual({ ...(ANSWERS['/api/v1/namespaces/prod/secrets/db'] as object), data: { url: C } });
      await s.close();
      sidecars.splice(0);
    }
  });
});

/**
 * A copy of `run` as a version that read no secret store's shape stored it: a Secret's manifest as
 * sent, fingerprinted so, in a run marked as one that kept a secret's names (RunMeta.secretNames 2).
 */
function earlier(run: RunRecord, note: string): RunRecord {
  const old = store.createRun({ mode: 'record', command, meta: { normalizersHash: normalizersHash([], 'exact', false), exactNumbers: true, secretNames: 2 } });
  for (const c of store.getCalls(run.runId)) {
    const args = { ...store.getJson<{ args: Record<string, unknown> }>(c.requestRef!)!.args, body: manifest(note) };
    const fingerprint = fingerprintTool(c.name, args, []).fingerprint;
    store.appendCallStart({ ...c, runId: old.runId, fingerprint, requestRef: store.putJson({ args }) });
    store.appendCallEnd({ kind: c.kind, name: c.name, fingerprint, occurrence: c.occurrence }, { ...c.end!, runId: old.runId });
  }
  store.endRun(old.runId, 'completed');
  return store.getRun(old.runId)!;
}

describe('a Secret’s manifest a call sends', () => {
  it('matches a recording made before, which stored it as sent, with the same secret or a rotated one, and is stored masked in the replay', async () => {
    const s = await sidecar();
    const now = s.startRun({ mode: 'record', command });
    expect((await call(s, now.runId, '/api/v1/namespaces/prod/secrets', manifest('EXAMPLE-manifest'))).status).toBe(200);
    s.endRun(now.runId, 'completed');
    const made = earlier(store.getRun(now.runId)!, 'EXAMPLE-manifest');
    expect(storedOf(made.runId)).toContain('EXAMPLE-manifest');
    for (const note of ['EXAMPLE-manifest', 'EXAMPLE-rotated']) {
      const run = s.startRun({ mode: 'replay', parentRunId: made.runId, command, offline: true });
      expect((await call(s, run.runId, '/api/v1/namespaces/prod/secrets', manifest(note))).status).toBe(200);
      expect(s.endRun(run.runId, 'completed').summary.divergence, note).toBeNull();
      expect(store.getRun(run.runId)!.meta?.secretNames).toBe(2);
      const [replayed] = store.getCalls(run.runId);
      expect(replayed.origin).toBe('replayed');
      expect(store.getJson<{ args: { body: unknown } }>(replayed.requestRef!)!.args.body).toEqual(manifest(C));
    }
  });
});
