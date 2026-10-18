import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactRun, Store } from '@shadowlap/engine';
import { matchHttpRule, rawJsonMember, validHttpHost } from '../src/http.js';
import { Sidecar } from '../src/index.js';

let server: Server;
let origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'set-cookie': 'session=secret' });
    res.end(Buffer.from([0, 159, 146, 150]));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('HTTP host rules', () => {
  it('match exact hosts, subdomains of a wildcard and an optional port', () => {
    const rules = [
      { host: '*.pinecone.io', effect: 'read' as const },
      { host: 'hooks.slack.com', effect: 'write' as const },
      { host: 'localhost:6333', effect: 'read' as const },
    ];
    expect(matchHttpRule(rules, new URL('https://idx-1.svc.us-east1.pinecone.io/query'))?.effect).toBe('read');
    expect(matchHttpRule(rules, new URL('https://pinecone.io/'))).toBeUndefined();
    expect(matchHttpRule(rules, new URL('https://evilpinecone.io/'))).toBeUndefined();
    expect(matchHttpRule(rules, new URL('https://hooks.slack.com/services/x'))?.effect).toBe('write');
    expect(matchHttpRule(rules, new URL('https://hooks.slack.com.evil.test/'))).toBeUndefined();
    expect(matchHttpRule(rules, new URL('http://localhost:6333/collections'))?.effect).toBe('read');
    expect(matchHttpRule(rules, new URL('http://localhost:6334/'))).toBeUndefined();
    expect(matchHttpRule(rules, new URL('ftp://hooks.slack.com/'))).toBeUndefined();
    for (const bad of ['*', '*.', 'http://x.com', 'a b.com', '**.x.com', 'x.com/path']) expect(validHttpHost(bad), bad).toBe(false);
  });
});

describe('captured HTTP calls', () => {
  it('forward only to declared hosts, and store neither request headers nor cookies', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host: new URL(origin).host, effect: 'read' }] });
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
    const call = (upstream: string) => fetch(`${sidecar.url}/r/${run.runId}/http/blob?id=7`, { headers: { 'x-shadowlap-upstream': upstream, authorization: 'Bearer sk-secret' } });

    expect((await call('http://127.0.0.1:1')).status).toBe(403);
    const res = await call(origin);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(Buffer.from([0, 159, 146, 150]));
    sidecar.endRun(run.runId, 'completed');

    const [recorded] = store.getCalls(run.runId);
    expect(recorded).toMatchObject({ kind: 'tool', name: `GET ${new URL(origin).host}/blob`, effect: 'read' });
    const request = JSON.stringify(store.getJson(recorded!.requestRef!));
    const result = JSON.stringify(store.getJson(recorded!.end!.responseRef!));
    expect(request).toContain('/blob?id=7');
    expect(request).not.toContain('sk-secret');
    expect(result).not.toContain('session=secret');
    expect(result).toContain('"encoding":"base64"');
    await sidecar.close();
    store.close();
  });
});

describe('a captured JSON response', () => {
  // As services write them: pretty-printed, escaped, a whole-number float, an id past 2^53.
  const SENT = '{\n  "order": "A-1042",\n  "customer": "Ren\\u00e9e",\n  "total": 20.0,\n  "id": 1234567890123456789\n}\n';
  let json: Server;
  let jsonOrigin: string;
  beforeAll(async () => {
    json = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(SENT);
    });
    await new Promise<void>((r) => json.listen(0, '127.0.0.1', () => r()));
    jsonOrigin = `http://127.0.0.1:${(json.address() as AddressInfo).port}`;
  });
  afterAll(() => json.close());

  it('replays as the bytes the service sent, from the store and from a redacted copy', async () => {
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host: new URL(jsonOrigin).host, effect: 'read' }] });
    const get = async (runId: string) => {
      const res = await fetch(`${sidecar.url}/r/${runId}/http/orders/A-1042`, { headers: { 'x-shadowlap-upstream': jsonOrigin } });
      return { text: await res.text(), origin: res.headers.get('x-shadowlap-origin') };
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      expect(await get(rec.runId)).toEqual({ text: SENT, origin: 'live' });
      sidecar.endRun(rec.runId, 'completed');
      // Whatever reads the result as JSON still gets the parsed body.
      const [call] = store.getCalls(rec.runId);
      expect(store.getJson<{ result: { body: unknown } }>(call!.end!.responseRef!)!.result.body).toMatchObject({ order: 'A-1042', customer: 'Renée', total: 20 });

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['x'], cwd: '.' } });
      expect(await get(rep.runId)).toEqual({ text: SENT, origin: 'replayed' });
      expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();

      // A copy masks the body's strings where they sit; the rest stays byte for byte.
      const copy = Store.open(':memory:');
      redactRun(store, rec.runId, [{ pattern: '/Ren[ée]e/', replace: '<NAME>' }], copy);
      const copied = copy.getBlob(copy.getCalls(rec.runId)[0]!.end!.responseRef!)!.toString('utf8');
      expect(rawJsonMember(copied, ['result', 'body'])).toBe(SENT.replace('Ren\\u00e9e', '<NAME>'));
      copy.close();
    } finally {
      await sidecar.close();
      store.close();
    }
  });

  it('reads a member\'s text as written, with the whitespace around it', () => {
    expect(rawJsonMember('{"result":{"status":200,"body": [1, 2.0 ] ,"x":"}"}}', ['result', 'body'])).toBe(' [1, 2.0 ] ');
    expect(rawJsonMember('{"result":{"a":"b\\"}","body":{"k":"v"}}}', ['result', 'body'])).toBe('{"k":"v"}');
    expect(rawJsonMember('{"result":{"status":200}}', ['result', 'body'])).toBeNull();
    expect(rawJsonMember('not json', ['result', 'body'])).toBeNull();
  });
});
