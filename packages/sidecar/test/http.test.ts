import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { credentialParam, matchHttpRule, validHttpHost, withoutCredentials } from '../src/http.js';
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

describe('credentials in a captured call', () => {
  it('are read from a parameter name narrowly, so a sort key or a page token still tells calls apart', () => {
    for (const name of ['key', 'api_key', 'apiKey', 'API-KEY', 'x-api-key', 'Subscription-Key', 'access_token', 'token', 'id_token', 'X-Amz-Security-Token', 'X-Amz-Signature', 'X-Amz-Credential', 'sig', 'signature', 'client_secret', 'password', 'appid', 'app_key']) expect(credentialParam(name), name).toBe(true);
    for (const name of ['q', 'keyword', 'keywords', 'sort_key', 'idempotency_key', 'monkey', 'author', 'page_token', 'nextPageToken', 'tokens', 'client_id', 'X-Amz-Date', 'signed']) expect(credentialParam(name), name).toBe(false);
    expect(withoutCredentials('?key=AIza-1&q=refund+policy&page_token=abc')).toBe('?key=<CREDENTIAL>&q=refund+policy&page_token=abc');
    expect(withoutCredentials('grant_type=client_credentials&client_id=app&client_secret=s3cr%3Dt')).toBe('grant_type=client_credentials&client_id=app&client_secret=<CREDENTIAL>');
    expect(withoutCredentials('?flag&api%5Fkey=v&key=')).toBe('?flag&api%5Fkey=<CREDENTIAL>&key=');
    expect(withoutCredentials('')).toBe('');
  });

  it('are forwarded, never stored, and a rotated key still replays', async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: [{ title: 'Refund policy' }] }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host, effect: 'read' }] });
    const calls = async (runId: string, key: string, secret: string) => {
      const search = await fetch(`${sidecar.url}/r/${runId}/http/customsearch/v1?key=${key}&q=refund`, { headers: { 'x-shadowlap-upstream': `http://${host}` } });
      expect(search.status).toBe(200);
      await search.text();
      const token = await fetch(`${sidecar.url}/r/${runId}/http/oauth/token`, { method: 'POST', headers: { 'x-shadowlap-upstream': `http://${host}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=client_credentials&client_id=app&client_secret=${secret}` });
      expect(token.status).toBe(200);
      await token.text();
    };
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      await calls(run.runId, 'AIzaSyD-live-key-0123', 'live-secret-456');
      sidecar.endRun(run.runId, 'completed');
      // The upstream got the real values.
      expect(seen[0]!.url).toBe('/customsearch/v1?key=AIzaSyD-live-key-0123&q=refund');
      expect(seen[1]!.body).toContain('client_secret=live-secret-456');

      const recorded = store.getCalls(run.runId);
      expect(store.getJson(recorded[0]!.requestRef!)).toEqual({ args: { method: 'GET', url: `http://${host}/customsearch/v1?key=<CREDENTIAL>&q=refund` } });
      expect(store.getJson(recorded[1]!.requestRef!)).toMatchObject({ args: { body: 'grant_type=client_credentials&client_id=app&client_secret=<CREDENTIAL>', encoding: 'text' } });
      const everything = JSON.stringify(recorded.map((c) => [c, store.getJson(c.requestRef!), store.getJson(c.end!.responseRef!)]));
      expect(everything).not.toContain('AIzaSyD-live-key');
      expect(everything).not.toContain('live-secret-456');

      // Another key and secret: the same calls, served from the recording.
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['x'], cwd: '.' } });
      await calls(replay.runId, 'AIzaSyD-rotated-key-999', 'rotated-secret-789');
      const { summary } = sidecar.endRun(replay.runId, 'completed');
      expect(summary.divergence).toBeNull();
      expect(seen).toHaveLength(2);
    } finally {
      await sidecar.close();
      store.close();
      upstream.close();
    }
  });
});
