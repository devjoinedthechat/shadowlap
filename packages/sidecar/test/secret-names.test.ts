import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER, fingerprintTool, normalizersHash, Store, withoutStoredCredentials, withSecretNames, type RunMeta, type RunRecord } from '@shadowlap/engine';
import { Sidecar } from '../src/index.js';

/**
 * A captured call's member whose name names or describes a secret (`secret_name`) is stored and
 * matched as sent, so lookups of two secrets stay two calls, and the secret beside it is masked. A
 * recording made before such names were kept masked them, and is matched, and replayed, as it was
 * then. Every value is invented.
 */

const command = { argv: ['agent'], cwd: '.' };
const C = CREDENTIAL_PLACEHOLDER;

let service: { at: string; host: string; asked: string[]; close: () => Promise<void> };
let store: Store;
const sidecars: Sidecar[] = [];

/** A secrets service that answers with the name it was asked about. */
beforeEach(async () => {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      const name = (JSON.parse(body) as { secret_name: string }).secret_name;
      asked.push(name);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  service = { at: `http://${host}`, host, asked, close: () => new Promise<void>((r) => server.close(() => r())) };
  store = Store.open(':memory:');
});

afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.close();
  store.close();
  await service.close();
});

async function sidecar(): Promise<Sidecar> {
  const started = await Sidecar.start({ store, http: [{ host: service.host, effect: 'read' }], clock: 'exact' });
  sidecars.push(started);
  return started;
}

/** The agent's lookup of a secret by its name, the value it keeps beside it masked: the name it got back, or the status when it got none. */
async function lookup(s: Sidecar, runId: string, name: string): Promise<string | number> {
  const res = await fetch(`${s.url}/r/${runId}/http/v1/secrets/describe`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-upstream': service.at }, body: JSON.stringify({ secret_name: name, secret_value: 'EXAMPLE-value-0123' }) });
  const text = await res.text();
  return res.ok ? (JSON.parse(text) as { name: string }).name : res.status;
}

/** A recording of lookups of `names`, in that order. */
async function record(s: Sidecar, names: readonly string[]): Promise<RunRecord> {
  const run = s.startRun({ mode: 'record', command });
  for (const name of names) expect(await lookup(s, run.runId, name)).toBe(name);
  s.endRun(run.runId, 'completed');
  return store.getRun(run.runId)!;
}

/** A replay of `parentRunId` that looks `names` up in that order: what each got, and how the replay ended. */
async function replay(s: Sidecar, parentRunId: string, names: readonly string[]) {
  const run = s.startRun({ mode: 'replay', parentRunId, command, offline: true });
  const got: Array<string | number> = [];
  for (const name of names) got.push(await lookup(s, run.runId, name));
  const { summary } = s.endRun(run.runId, 'completed');
  return { runId: run.runId, got, divergence: summary.divergence };
}

/** The arguments a run's calls are stored with. */
const argsOf = (runId: string) => store.getCalls(runId).map((c) => store.getJson<{ args: unknown }>(c.requestRef!)!.args);

/**
 * A copy of `run`, as a recording made before a secret's name was kept holds it: no
 * RunMeta.secretNames, each call's arguments as that version stored them (`args`, or masked as it
 * masked them), and fingerprinted so. `meta` marks it as an earlier version that kept some marked it.
 */
function earlier(run: RunRecord, args = (stored: unknown, _callNo: number): unknown => withSecretNames(false, () => withoutStoredCredentials(stored)), meta: Partial<RunMeta> = {}): RunRecord {
  const old = store.createRun({ mode: 'record', command, meta: { normalizersHash: normalizersHash([], 'exact', false), exactNumbers: true, ...meta } });
  for (const call of store.getCalls(run.runId)) {
    const kept = args(store.getJson<{ args: unknown }>(call.requestRef!)!.args, call.callNo);
    const fingerprint = fingerprintTool(call.name, kept, []).fingerprint;
    store.appendCallStart({ ...call, runId: old.runId, fingerprint, requestRef: store.putJson({ args: kept }) });
    store.appendCallEnd({ kind: call.kind, name: call.name, fingerprint, occurrence: call.occurrence }, { ...call.end!, runId: old.runId });
  }
  store.endRun(old.runId, 'completed');
  return store.getRun(old.runId)!;
}

describe('a captured call’s secret name', () => {
  it('is stored as sent, the secret beside it masked, and the recording says it keeps them', async () => {
    const s = await sidecar();
    const run = await record(s, ['prod/db']);
    expect(run.meta?.secretNames).toBe(true);
    expect(argsOf(run.runId)).toEqual([{ method: 'POST', url: `${service.at}/v1/secrets/describe`, body: { secret_name: 'prod/db', secret_value: C }, encoding: 'json' }]);
    expect(JSON.stringify(argsOf(run.runId))).not.toContain('EXAMPLE-value');
  });

  it('tells two lookups apart: replayed in the other order, each gets the answer for the secret it names', async () => {
    const s = await sidecar();
    const run = await record(s, ['prod/db', 'prod/cache']);
    const swapped = await replay(s, run.runId, ['prod/cache', 'prod/db']);
    expect(swapped.got).toEqual(['prod/cache', 'prod/db']);
    expect(swapped.divergence).toBeNull();
    expect(store.getCalls(swapped.runId).map((c) => [c.origin, c.end?.meta.replayedFrom])).toEqual([
      ['replayed', 2],
      ['replayed', 1],
    ]);
    // Only the recording reached the service.
    expect(service.asked).toEqual(['prod/db', 'prod/cache']);
  });

  it('forks at a secret the recording never looked up, never answered with another secret’s answer', async () => {
    const s = await sidecar();
    const run = await record(s, ['prod/db']);
    const unrecorded = await replay(s, run.runId, ['prod/payments']);
    // Offline, the call the recording can't answer is refused rather than sent.
    expect(unrecorded.got).toEqual([503]);
    expect(unrecorded.divergence).toMatchObject({ type: 'request_changed', callNo: 1, diff: [{ path: '$.args.body.secret_name', op: 'changed', before: 'prod/db', after: 'prod/payments' }] });
    expect(service.asked).toEqual(['prod/db']);
  });

  it('is masked to match a recording made before such names were kept, as it was then, and in that recording’s replays too', async () => {
    const s = await sidecar();
    const old = earlier(await record(s, ['prod/db', 'prod/cache']));
    expect(argsOf(old.runId).map((a) => (a as { body: unknown }).body)).toEqual([
      { secret_name: C, secret_value: C },
      { secret_name: C, secret_value: C },
    ]);
    // Matched as that version matched it: the lookups by their order, each replayed.
    const first = await replay(s, old.runId, ['prod/db', 'prod/cache']);
    expect(first.got).toEqual(['prod/db', 'prod/cache']);
    expect(first.divergence).toBeNull();
    // Its replay keeps them masked as its recording did, so a replay of it matches the same way.
    expect(store.getRun(first.runId)!.meta?.secretNames).toBeUndefined();
    expect(argsOf(first.runId).map((a) => (a as { body: unknown }).body)).toEqual([
      { secret_name: C, secret_value: C },
      { secret_name: C, secret_value: C },
    ]);
    const second = await replay(s, first.runId, ['prod/db', 'prod/cache']);
    expect(second.got).toEqual(['prod/db', 'prod/cache']);
    expect(second.divergence).toBeNull();
    expect(service.asked).toEqual(['prod/db', 'prod/cache']);
  });

  it('is masked on both sides where a recording made before the value was read kept a key under it, and the recording still replays', async () => {
    const s = await sidecar();
    const key = 'ghp_EXAMPLE16C7e42F292c6912E7710c838347A';
    const sent = ['prod/db', key];
    const run = await record(s, sent);
    const names = (runId: string) => argsOf(runId).map((a) => (a as { body: { secret_name: string } }).body.secret_name);
    // A key under a secret's name is stored masked.
    expect(names(run.runId)).toEqual(['prod/db', C]);
    // As the version before stored it: each name as sent, the key too, in a run marked as keeping secret names.
    const made = earlier(run, (stored, callNo) => ({ ...(stored as Record<string, unknown>), body: { secret_name: sent[callNo - 1], secret_value: C } }), { secretNames: true });
    expect(names(made.runId)).toEqual(sent);
    const replayed = await replay(s, made.runId, sent);
    expect(replayed.got).toEqual(sent);
    expect(replayed.divergence).toBeNull();
    // Its replay keeps the mark, and the key masked.
    expect(store.getRun(replayed.runId)!.meta?.secretNames).toBe(true);
    expect(names(replayed.runId)).toEqual(['prod/db', C]);
  });

  it('is fingerprinted under each run’s own rule, never from the cache entry the other rule left for the same stored request', async () => {
    const s = await sidecar();
    // A recording made before credentials were masked kept its body as sent: the same stored request
    // as one made now holds, when it sends no secret beside the name.
    const body = (name: string) => JSON.stringify({ secret_name: name });
    const ask = async (runId: string, name: string) => (await fetch(`${s.url}/r/${runId}/http/v1/secrets/describe`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-shadowlap-upstream': service.at }, body: body(name) })).status;
    const now = s.startRun({ mode: 'record', command });
    expect(await ask(now.runId, 'prod/db')).toBe(200);
    s.endRun(now.runId, 'completed');
    const asSent = earlier(store.getRun(now.runId)!, (stored) => stored);
    expect(store.getCalls(asSent.runId)[0].requestRef).toBe(store.getCalls(now.runId)[0].requestRef);
    for (const [parent, name, matched] of [
      [asSent, 'prod/cache', true],
      [now, 'prod/cache', false],
      [now, 'prod/db', true],
      [asSent, 'prod/db', true],
    ] as const) {
      const run = s.startRun({ mode: 'replay', parentRunId: parent.runId, command, offline: true });
      expect(await ask(run.runId, name), `${name} against ${parent === now ? 'the recording made now' : 'the one made before'}`).toBe(matched ? 200 : 503);
      expect(s.endRun(run.runId, 'completed').summary.divergence === null).toBe(matched);
    }
  });
});
