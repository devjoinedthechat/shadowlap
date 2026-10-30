import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fingerprintTool, normalizersHash, redactRun, Store, type Normalizer } from '@shadowlap/engine';
import { credentialParam, credentialValue, decodeBody, matchHttpRule, rawJsonMember, storedRequestBody, storedResult, validHttpHost, withoutCredentials, withoutStoredCredentials } from '../src/http.js';
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

describe('a captured call whose body masking can\'t encode again', () => {
  // A JSON string can escape half of a surrogate pair on its own (\\ud800): decoded, it has no
  // URL encoding, so a credential masked inside a percent-encoded value next to it can't be written
  // back as it was. The value is masked whole, and the call goes through.
  const pct = encodeURIComponent('{"api_key":"SLSEC_LONE_q1w2e3r4","y":"');
  const bodies = {
    json: `{"q":"data=${pct}\\ud800%22%7D&x=1"}`,
    form: `data=${pct}\ud800%22%7D&x=1`,
    url: `{"u":"https://h/x?data=${pct}\\ud800%22%7D"}`,
  };

  it('is stored with that value masked whole, never thrown on', () => {
    for (const [name, text] of Object.entries(bodies)) {
      for (const contentType of ['application/json', 'text/plain', undefined]) {
        const stored = JSON.stringify(storedRequestBody(Buffer.from(text), contentType));
        expect(stored, `${name} ${String(contentType)}`).not.toContain('SLSEC_LONE');
        expect(stored).toMatch(/<CREDENTIAL>|%3CCREDENTIAL%3E/);
        const result = storedResult({ status: 200, headers: { 'content-type': contentType ?? 'text/plain' }, ...decodeBody(Buffer.from(text), contentType) }, Buffer.from(text)).toString('utf8');
        expect(result, `${name} ${String(contentType)}`).not.toContain('SLSEC_LONE');
      }
    }
  });

  it('reaches the service and the agent, and is recorded ended', async () => {
    const service = createServer((req, res) => {
      let got = '';
      req.on('data', (d: Buffer) => (got += d.toString()));
      req.on('end', () => res.writeHead(200, { 'content-type': 'text/plain' }).end(got));
    });
    await new Promise<void>((r) => service.listen(0, '127.0.0.1', () => r()));
    const at = `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host: new URL(at).host, effect: 'read' }] });
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      // JSON whose string escapes the half surrogate: the bytes on the wire are plain ASCII.
      const res = await fetch(`${sidecar.url}/r/${run.runId}/http/echo`, { method: 'POST', headers: { 'x-shadowlap-upstream': at, 'content-type': 'application/json' }, body: bodies.json });
      // The service got the body as sent, and the agent the answer as the service gave it.
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(bodies.json);
      sidecar.endRun(run.runId, 'completed');
      const [call] = store.getCalls(run.runId);
      expect(call.end).toMatchObject({ outcome: 'ok' });
      expect(JSON.stringify(store.getJson(call.requestRef!)) + JSON.stringify(store.getJson(call.end!.responseRef!))).not.toContain('SLSEC_LONE');
    } finally {
      await sidecar.close();
      store.close();
      await new Promise<void>((r) => service.close(() => r()));
    }
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
    const request = JSON.stringify(store.getJson(recorded.requestRef!));
    const result = JSON.stringify(store.getJson(recorded.end!.responseRef!));
    expect(request).toContain('/blob?id=7');
    expect(request).not.toContain('sk-secret');
    expect(result).not.toContain('session=secret');
    expect(result).toContain('"encoding":"base64"');
    await sidecar.close();
    store.close();
  });

  it('hand the agent a token from a response header live, and store the header without it', async () => {
    // OpenStack Keystone hands a token back in X-Subject-Token, Swift's auth in X-Auth-Token.
    const BODY = '{"token": {"expires_at": "2026-10-24T00:00:00Z"}, "id": 1234567890123456789}';
    const keystone = createServer((req, res) => {
      req.resume();
      res.writeHead(201, { 'content-type': 'application/json', 'x-subject-token': 'gAAAAABl-real-keystone-token', 'x-auth-token': 'AUTH_tk-real-swift', authorization: 'Bearer echoed-sk-secret', 'proxy-authorization': 'Basic cHJveHk6cGFzcw==', 'set-cookie': 'session=secret' });
      res.end(BODY);
    });
    await new Promise<void>((r) => keystone.listen(0, '127.0.0.1', () => r()));
    const at = `http://127.0.0.1:${(keystone.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host: new URL(at).host, effect: 'read' }] });
    const tokens = async (runId: string) => {
      const res = await fetch(`${sidecar.url}/r/${runId}/http/v3/auth/tokens`, { method: 'POST', headers: { 'x-shadowlap-upstream': at, 'content-type': 'application/json' }, body: '{"auth": {}}' });
      return { status: res.status, subject: res.headers.get('x-subject-token'), auth: res.headers.get('x-auth-token'), cookie: res.headers.get('set-cookie'), body: await res.text() };
    };
    try {
      const rec = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      expect(await tokens(rec.runId)).toEqual({ status: 201, subject: 'gAAAAABl-real-keystone-token', auth: 'AUTH_tk-real-swift', cookie: null, body: BODY });
      sidecar.endRun(rec.runId, 'completed');
      const [call] = store.getCalls(rec.runId);
      const stored = store.getBlob(call.end!.responseRef!)!.toString('utf8');
      for (const secret of ['real-keystone-token', 'real-swift', 'echoed-sk-secret', 'cHJveHk6cGFzcw==', 'session=secret']) expect(stored).not.toContain(secret);
      expect(JSON.parse(stored).result.headers).toMatchObject({ 'x-subject-token': '<CREDENTIAL>', 'x-auth-token': '<CREDENTIAL>', authorization: '<CREDENTIAL>', 'proxy-authorization': '<CREDENTIAL>' });
      // A replay finds the header it reads its token from, with the placeholder in it, and the body as sent.
      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['x'], cwd: '.' } });
      expect(await tokens(rep.runId)).toEqual({ status: 201, subject: '<CREDENTIAL>', auth: '<CREDENTIAL>', cookie: null, body: BODY });
      expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();
    } finally {
      await sidecar.close();
      store.close();
      keystone.close();
    }
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
      expect(store.getJson<{ result: { body: unknown } }>(call.end!.responseRef!)!.result.body).toMatchObject({ order: 'A-1042', customer: 'Renée', total: 20 });

      const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['x'], cwd: '.' } });
      expect(await get(rep.runId)).toEqual({ text: SENT, origin: 'replayed' });
      expect(sidecar.endRun(rep.runId, 'completed').summary.divergence).toBeNull();

      // A copy masks the body's strings where they sit; the rest stays byte for byte.
      const copy = Store.open(':memory:');
      redactRun(store, rec.runId, [{ pattern: '/Ren[ée]e/', replace: '<NAME>' }], copy);
      const copied = copy.getBlob(copy.getCalls(rec.runId)[0].end!.responseRef!)!.toString('utf8');
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

describe('credentials in a captured call', () => {
  it('are read from a parameter name narrowly, so a sort key or a page token still tells calls apart', () => {
    for (const name of ['key', 'api_key', 'apiKey', 'API-KEY', 'x-api-key', 'Subscription-Key', 'access_token', 'token', 'id_token', 'X-Amz-Security-Token', 'X-Amz-Signature', 'X-Amz-Credential', 'sig', 'signature', 'client_secret', 'password', 'appid', 'app_key']) expect(credentialParam(name), name).toBe(true);
    for (const name of ['q', 'keyword', 'keywords', 'sort_key', 'idempotency_key', 'monkey', 'author', 'page_token', 'nextPageToken', 'tokens', 'client_id', 'X-Amz-Date', 'signed']) expect(credentialParam(name), name).toBe(false);
    expect(withoutCredentials('?key=AIzaSyD-live-key-0123&q=refund+policy&page_token=abc')).toBe('?key=<CREDENTIAL>&q=refund+policy&page_token=abc');
    expect(withoutCredentials('grant_type=client_credentials&client_id=app&client_secret=s3cr%3Dt')).toBe('grant_type=client_credentials&client_id=app&client_secret=<CREDENTIAL>');
    expect(withoutCredentials('?flag&api%5Fkey=v&key=')).toBe('?flag&api%5Fkey=<CREDENTIAL>&key=');
    expect(withoutCredentials('')).toBe('');
  });

  it('are read from the value too for a bare key or token, which is as often a lookup', () => {
    for (const value of ['AIzaSyD-live-key-0123456789abcdef', 'sk_live_51H8xYzAbC0123', '9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln', 'qwertyuiopasdfghjklzxcvb']) {
      expect(credentialValue(value), value).toBe(true);
      expect(credentialParam('key', value), value).toBe(true);
      expect(credentialParam('token', value), value).toBe(true);
    }
    for (const value of ['checkout_v2', 'checkout_redesign_2026', 'user:12345:settings', 'flags/New-Checkout-Flow', 'SECRET12']) {
      expect(credentialValue(value), value).toBe(false);
      expect(credentialParam('key', value), value).toBe(false);
      expect(credentialParam('Token', value), value).toBe(false);
    }
    // A name that says what it holds is a credential whatever its value.
    expect(credentialParam('api_key', 'v')).toBe(true);
    expect(credentialParam('access_token', 'abc')).toBe(true);
    // Decoded before it is read; and a masked query, masked again, is as it was.
    expect(withoutCredentials('?key=checkout_v2&token=flags%2Fnew-checkout')).toBe('?key=checkout_v2&token=flags%2Fnew-checkout');
    const masked = withoutCredentials('?key=AIzaSyD%2Dlive%2Dkey%2D0123&token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln&q=refund');
    expect(masked).toBe('?key=<CREDENTIAL>&token=<CREDENTIAL>&q=refund');
    expect(withoutCredentials(masked)).toBe(masked);
  });

  it('stored as sent by an earlier version still match, with the same key and with a rotated one', async () => {
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ items: [{ title: 'Refund policy' }] }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const calls = async (base: string, runId: string, key: string, secret: string) => {
      const search = await fetch(`${base}/r/${runId}/http/customsearch/v1?key=${key}&q=refund`, { headers: { 'x-shadowlap-upstream': `http://${host}` } });
      await search.text();
      const token = await fetch(`${base}/r/${runId}/http/oauth/token`, { method: 'POST', headers: { 'x-shadowlap-upstream': `http://${host}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=client_credentials&client_secret=${secret}` });
      await token.text();
      return [search.status, token.status];
    };
    const sidecars: Sidecar[] = [];
    try {
      // Recorded, then copied into a run as an earlier version stored it: the URL and form body as
      // sent, and fingerprinted so.
      const recording = await Sidecar.start({ store, http: [{ host, effect: 'read' }], clock: 'exact' });
      sidecars.push(recording);
      const run = recording.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      await calls(recording.url, run.runId, 'AIzaSyD-live-key-0123', 'live-secret-456');
      recording.endRun(run.runId, 'completed');
      const sent = [
        { method: 'GET', url: `http://${host}/customsearch/v1?key=AIzaSyD-live-key-0123&q=refund` },
        { method: 'POST', url: `http://${host}/oauth/token`, body: 'grant_type=client_credentials&client_secret=live-secret-456', encoding: 'text' },
      ];
      const old = store.createRun({ mode: 'record', command: { argv: ['x'], cwd: '.' }, meta: { normalizersHash: normalizersHash([], 'exact', false) } });
      store.getCalls(run.runId).forEach((call, i) => {
        const fingerprint = fingerprintTool(call.name, sent[i], []).fingerprint;
        store.appendCallStart({ ...call, runId: old.runId, fingerprint, requestRef: store.putJson({ args: sent[i] }) });
        store.appendCallEnd({ kind: call.kind, name: call.name, fingerprint, occurrence: call.occurrence }, { ...call.end!, runId: old.runId });
      });
      store.endRun(old.runId, 'completed');
      expect(seen).toHaveLength(2);

      // Its stored fingerprints reused (no normalizers), and fingerprinted again (one that changes nothing here).
      for (const normalizers of [[], [{ kind: 'api', pattern: 'uuid' }] as Normalizer[]]) {
        const sidecar = await Sidecar.start({ store, http: [{ host, effect: 'read' }], clock: 'exact', normalizers });
        sidecars.push(sidecar);
        for (const [key, secret] of [['AIzaSyD-live-key-0123', 'live-secret-456'], ['AIzaSyD-rotated-key-999', 'rotated-secret-789']] as const) {
          const replay = sidecar.startRun({ mode: 'replay', parentRunId: old.runId, command: { argv: ['x'], cwd: '.' } });
          expect(await calls(sidecar.url, replay.runId, key, secret)).toEqual([200, 200]);
          expect(sidecar.endRun(replay.runId, 'completed').summary.divergence, `${normalizers.length} ${key}`).toBeNull();
          expect(store.getCalls(replay.runId).map((c) => c.origin)).toEqual(['replayed', 'replayed']);
        }
      }
      expect(seen).toHaveLength(2);

      // A replay that changes the query diverges, and its report shows no credential as sent.
      const sidecar = sidecars[1];
      const changed = sidecar.startRun({ mode: 'replay', parentRunId: old.runId, command: { argv: ['x'], cwd: '.' } });
      await fetch(`${sidecar.url}/r/${changed.runId}/http/customsearch/v1?key=AIzaSyD-live-key-0123&q=refunds`, { headers: { 'x-shadowlap-upstream': `http://${host}` } }).then((r) => r.text());
      const { divergence } = sidecar.endRun(changed.runId, 'completed').summary;
      expect(divergence?.diff).toEqual([{ op: 'changed', path: '$.args.url', before: `http://${host}/customsearch/v1?key=<CREDENTIAL>&q=refund`, after: `http://${host}/customsearch/v1?key=<CREDENTIAL>&q=refunds` }]);
    } finally {
      for (const s of sidecars) await s.close();
      store.close();
      upstream.close();
    }
  });

  it('in a form, its credential first, match a replay that fingerprints the recording again, as one after the fingerprint cache changes does', async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"token_type":"bearer"}'));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const token = async (base: string, runId: string, secret: string) => {
      const res = await fetch(`${base}/r/${runId}/http/oauth/token`, { method: 'POST', headers: { 'x-shadowlap-upstream': `http://${host}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `client_secret=${secret}&grant_type=client_credentials&scope=read` });
      await res.text();
      return res.status;
    };
    const sidecars: Sidecar[] = [];
    try {
      const recording = await Sidecar.start({ store, http: [{ host, effect: 'read' }], clock: 'exact' });
      sidecars.push(recording);
      const run = recording.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      expect(await token(recording.url, run.runId, 'EXAMPLE-secret-0123')).toBe(200);
      recording.endRun(run.runId, 'completed');
      // A normalizer that changes nothing here: the stored request is fingerprinted again, not taken from the cache.
      const sidecar = await Sidecar.start({ store, http: [{ host, effect: 'read' }], clock: 'exact', normalizers: [{ kind: 'api', pattern: 'uuid' }] });
      sidecars.push(sidecar);
      for (const secret of ['EXAMPLE-secret-0123', 'EXAMPLE-rotated-4567']) {
        const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['x'], cwd: '.' }, offline: true });
        expect(await token(sidecar.url, replay.runId, secret)).toBe(200);
        expect(sidecar.endRun(replay.runId, 'completed').summary.divergence, secret).toBeNull();
        expect(store.getCalls(replay.runId).map((c) => c.origin)).toEqual(['replayed']);
      }
    } finally {
      for (const s of sidecars) await s.close();
      store.close();
      upstream.close();
    }
  });

  it("SigV2 names a URL's signer by, and a key only begun as an ARN under a secret's id, stored as sent by an earlier version, still match with the same key and a rotated one", async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const id = (key: string) => `arn:x:y::1:${key}`;
    const calls = async (base: string, runId: string, signer: string, key: string) => {
      const object = await fetch(`${base}/r/${runId}/http/bucket/report.csv?AWSAccessKeyId=${signer}&Expires=1761825600&Signature=EXAMPLE%2Bsignature%3D`, { headers: { 'x-shadowlap-upstream': `http://${host}` } });
      await object.text();
      const secret = await fetch(`${base}/r/${runId}/http/`, { method: 'POST', headers: { 'x-shadowlap-upstream': `http://${host}`, 'content-type': 'application/x-amz-json-1.1' }, body: JSON.stringify({ SecretId: id(key) }) });
      await secret.text();
      return [object.status, secret.status];
    };
    const sidecars: Sidecar[] = [];
    try {
      const recording = await Sidecar.start({ store, http: [{ host, effect: 'read' }], clock: 'exact' });
      sidecars.push(recording);
      const run = recording.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      expect(await calls(recording.url, run.runId, 'AKIAIOSFODNN7EXAMPLE', 'ghp_EXAMPLE16C7e42F292c6912E7710c838347A')).toEqual([200, 200]);
      recording.endRun(run.runId, 'completed');
      const kept = store.getCalls(run.runId).map((c) => JSON.stringify(store.getJson(c.requestRef!)));
      for (const secret of ['AKIAIOSFODNN7EXAMPLE', 'ghp_EXAMPLE16C7e42F292c6912E7710c838347A']) expect(kept.join('\n'), secret).not.toContain(secret);
      // As an earlier version stored the run: the key id and the key as sent, fingerprinted so.
      const sent = [
        { method: 'GET', url: `http://${host}/bucket/report.csv?AWSAccessKeyId=AKIAIOSFODNN7EXAMPLE&Expires=1761825600&Signature=<CREDENTIAL>` },
        { method: 'POST', url: `http://${host}/`, body: { SecretId: id('ghp_EXAMPLE16C7e42F292c6912E7710c838347A') }, encoding: 'json' },
      ];
      const old = store.createRun({ mode: 'record', command: { argv: ['x'], cwd: '.' }, meta: { normalizersHash: normalizersHash([], 'exact', false), secretNames: 2 } });
      store.getCalls(run.runId).forEach((call, i) => {
        const fingerprint = fingerprintTool(call.name, sent[i], []).fingerprint;
        store.appendCallStart({ ...call, runId: old.runId, fingerprint, requestRef: store.putJson({ args: sent[i] }) });
        store.appendCallEnd({ kind: call.kind, name: call.name, fingerprint, occurrence: call.occurrence }, { ...call.end!, runId: old.runId });
      });
      store.endRun(old.runId, 'completed');
      const sidecar = await Sidecar.start({ store, http: [{ host, effect: 'read' }], clock: 'exact' });
      sidecars.push(sidecar);
      for (const [signer, key] of [['AKIAIOSFODNN7EXAMPLE', 'ghp_EXAMPLE16C7e42F292c6912E7710c838347A'], ['AKIAI44QH8DHBEXAMPLE', 'ghp_EXAMPLErotatedEXAMPLErotated01234567']]) {
        const replay = sidecar.startRun({ mode: 'replay', parentRunId: old.runId, command: { argv: ['x'], cwd: '.' }, offline: true });
        expect(await calls(sidecar.url, replay.runId, signer, key)).toEqual([200, 200]);
        expect(sidecar.endRun(replay.runId, 'completed').summary.divergence, signer).toBeNull();
        expect(store.getCalls(replay.runId).map((c) => c.origin)).toEqual(['replayed', 'replayed']);
      }
    } finally {
      for (const s of sidecars) await s.close();
      store.close();
      upstream.close();
    }
  });

  it("in a webhook's address are stored masked, and a recording that kept them as sent still matches, with a rotated secret too", async () => {
    const seen: string[] = [];
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        seen.push(req.url ?? '');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const post = async (base: string, runId: string, token: string) => {
      const res = await fetch(`${base}/r/${runId}/http/api/webhooks/123456/${token}?session=SLSEC_QS_SESSION_q1w2e3`, { method: 'POST', headers: { 'x-shadowlap-upstream': `http://${host}`, 'content-type': 'application/json' }, body: '{"content":"refunded"}' });
      await res.text();
      return res.status;
    };
    const sidecars: Sidecar[] = [];
    try {
      const recording = await Sidecar.start({ store, http: [{ host, effect: 'write' }], clock: 'exact' });
      sidecars.push(recording);
      const run = recording.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      expect(await post(recording.url, run.runId, 'SLSEC_R2_DISCORDTOKEN_q1w2e3r4')).toBe(200);
      recording.endRun(run.runId, 'completed');
      // The service got the address as the agent sent it; the store keeps it without the secret.
      expect(seen).toEqual(['/api/webhooks/123456/SLSEC_R2_DISCORDTOKEN_q1w2e3r4?session=SLSEC_QS_SESSION_q1w2e3']);
      const [call] = store.getCalls(run.runId);
      expect(call.name).toBe(`POST ${host}/api/webhooks/123456/<CREDENTIAL>`);
      expect(JSON.stringify(store.getJson(call.requestRef!))).not.toContain('SLSEC_');

      // As an earlier version stored it: the secret in its name and address, fingerprinted so.
      const sent = { ...(store.getJson(call.requestRef!) as { args: Record<string, unknown> }).args, url: `http://${host}/api/webhooks/123456/SLSEC_R2_DISCORDTOKEN_q1w2e3r4?session=SLSEC_QS_SESSION_q1w2e3` };
      const name = `POST ${host}/api/webhooks/123456/SLSEC_R2_DISCORDTOKEN_q1w2e3r4`;
      const old = store.createRun({ mode: 'record', command: { argv: ['x'], cwd: '.' }, meta: { normalizersHash: normalizersHash([], 'exact', false) } });
      const fingerprint = fingerprintTool(name, sent, []).fingerprint;
      store.appendCallStart({ ...call, runId: old.runId, name, fingerprint, requestRef: store.putJson({ args: sent }) });
      store.appendCallEnd({ kind: call.kind, name, fingerprint, occurrence: call.occurrence }, { ...call.end!, runId: old.runId });
      store.endRun(old.runId, 'completed');

      const sidecar = await Sidecar.start({ store, http: [{ host, effect: 'write' }], clock: 'exact' });
      sidecars.push(sidecar);
      for (const token of ['SLSEC_R2_DISCORDTOKEN_q1w2e3r4', 'rotated-token-0123456789']) {
        for (const parent of [old.runId, run.runId]) {
          const replay = sidecar.startRun({ mode: 'replay', parentRunId: parent, command: { argv: ['x'], cwd: '.' } });
          expect(await post(sidecar.url, replay.runId, token)).toBe(200);
          expect(sidecar.endRun(replay.runId, 'completed').summary.divergence, `${token} on ${parent === old.runId ? 'the old recording' : 'the new one'}`).toBeNull();
        }
      }
      // Every replay was served from the recording: the service saw the recording's call alone.
      expect(seen).toHaveLength(1);
    } finally {
      for (const s of sidecars) await s.close();
      store.close();
      upstream.close();
    }
  });

  it('read from stored arguments as a call is stored now, which change nothing that already reads so', () => {
    const url = 'http://h/customsearch/v1?key=AIzaSyD-live-key-0123&q=refund';
    expect(withoutStoredCredentials({ method: 'GET', url })).toEqual({ method: 'GET', url: 'http://h/customsearch/v1?key=<CREDENTIAL>&q=refund' });
    expect(withoutStoredCredentials({ method: 'POST', url: 'http://h/t', body: 'client_id=app&client_secret=s', encoding: 'text' })).toEqual({ method: 'POST', url: 'http://h/t', body: 'client_id=app&client_secret=<CREDENTIAL>', encoding: 'text' });
    // A JSON body's credential members, by key, as a form's parameters.
    expect(withoutStoredCredentials({ method: 'POST', url: 'http://h/q', body: { client_secret: 's', q: 'refund' }, encoding: 'json' })).toEqual({ method: 'POST', url: 'http://h/q', body: { client_secret: '<CREDENTIAL>', q: 'refund' }, encoding: 'json' });
    for (const args of [
      { method: 'GET', url: 'http://h/customsearch/v1?key=<CREDENTIAL>&q=refund' },
      { method: 'GET', url: 'http://h/flags?key=checkout_v2' },
      { method: 'POST', url: 'http://h/q', body: { client_secret: '<CREDENTIAL>', q: 'refund' }, encoding: 'json' },
      { method: 'POST', url: 'http://h/q', body: 'note: client_secret=s is a secret', encoding: 'text' },
      null,
      'x',
    ]) {
      expect(withoutStoredCredentials(args)).toBe(args);
    }
    // A text body written as a form is stored as one, whatever its content type says.
    expect(storedRequestBody(Buffer.from('client_id=app&client_secret=s'), 'text/plain')).toEqual({ body: 'client_id=app&client_secret=<CREDENTIAL>', encoding: 'text' });
    expect(storedRequestBody(Buffer.from('client_secret=s is a secret'), 'text/plain')).toEqual({ body: 'client_secret=s is a secret', encoding: 'text' });
  });

  it('in a body are stored masked as a recorded call’s arguments are read, so both sides of matching agree', () => {
    const b = '----shadowlap0123456789';
    const multipart = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="api_key"\r\n\r\nSLSEC_TM_APIKEY_0123456789\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhello\r\n--${b}--\r\n`);
    const bodies: Array<[Buffer, string]> = [
      [Buffer.from(JSON.stringify({ api_key: 'tvly-SLSEC_TJ_APIKEY_0123456789', query: 'refund', password: 'SLSEC_TJ_PASSWORD_0123', client_secret: 'SLSEC_TJ_CLIENTSECRET_0123', nested: { refresh_token: 'SLSEC_TJ_REFRESH_0123456789', page_token: 'p2' } })), 'application/json'],
      [Buffer.from('grant_type=client_credentials&client_id=agent-app&client_secret=SLSEC_TF_CLIENTSECRET_0123456789&refresh_token=SLSEC_TF_REFRESH_0123456789'), 'application/x-www-form-urlencoded'],
      [multipart, `multipart/form-data; boundary=${b}`],
      [Buffer.concat([multipart.subarray(0, multipart.indexOf('hello')), Buffer.from([0, 159, 146, 150]), multipart.subarray(multipart.indexOf('hello') + 5)]), `multipart/form-data; boundary=${b}`],
    ];
    for (const [raw, contentType] of bodies) {
      // A live call as the sidecar stores and matches it, and the same call as an earlier version stored it, as sent.
      const live = { method: 'POST', url: 'http://h/x', ...storedRequestBody(raw, contentType) };
      const earlier = { method: 'POST', url: 'http://h/x', ...decodeBody(raw, contentType) };
      expect(withoutStoredCredentials(earlier), contentType).toEqual(live);
      expect(Buffer.from(JSON.stringify(live).replace(/"body":"([A-Za-z0-9+/=]+)"/, (_m, b64: string) => Buffer.from(b64, 'base64').toString('latin1'))).toString('latin1'), contentType).not.toMatch(/SLSEC_/);
      // Read again, it is what it was: the same object.
      expect(withoutStoredCredentials(live), contentType).toBe(live);
    }
  });

  it('a service hands back in a response body are stored masked in place, and the agent gets them as sent', () => {
    const oauth = Buffer.from('{"access_token": "SLSEC_RB_ACCESSTOKEN_eyJhbGciOiJIUzI1NiJ9", "refresh_token": "SLSEC_RB_REFRESH_0123456789", "token_type": "Bearer", "expires_in": 3600, "id": 1234567890123456789}');
    const blob = storedResult({ status: 200, headers: { 'content-type': 'application/json' }, ...decodeBody(oauth, 'application/json') }, oauth).toString('utf8');
    expect(blob).not.toMatch(/SLSEC_RB_/);
    expect(rawJsonMember(blob, ['result', 'body'])).toBe('{"access_token": "<CREDENTIAL>", "refresh_token": "<CREDENTIAL>", "token_type": "Bearer", "expires_in": 3600, "id": 1234567890123456789}');
    const form = Buffer.from('session_token=SLSEC_RB_TEXTBODY_0123456789abcdef&expires=3600');
    expect(JSON.parse(storedResult({ status: 200, headers: { 'content-type': 'text/plain' }, ...decodeBody(form, 'text/plain') }, form).toString('utf8')).result.body).toBe('session_token=<CREDENTIAL>&expires=3600');
  });

  it('in a JSON body recorded as sent by an earlier version still match, with the same secret and a rotated one', async () => {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ results: [{ title: 'Refund policy' }] }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const search = (base: string, runId: string, secret: string) =>
      fetch(`${base}/r/${runId}/http/search`, { method: 'POST', headers: { 'x-shadowlap-upstream': `http://${host}`, 'content-type': 'application/json' }, body: JSON.stringify({ api_key: `tvly-${secret}`, query: 'refund' }) }).then(async (r) => (await r.text(), r.status));
    const sidecars: Sidecar[] = [];
    try {
      const recording = await Sidecar.start({ store, http: [{ host, effect: 'read' }], clock: 'exact' });
      sidecars.push(recording);
      const run = recording.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      expect(await search(recording.url, run.runId, 'live-secret-0123456789')).toBe(200);
      recording.endRun(run.runId, 'completed');
      // Stored masked, as the review's sweep would read it.
      expect(JSON.stringify(store.getJson(store.getCalls(run.runId)[0].requestRef!))).not.toContain('live-secret');
      // The same call as an earlier version stored and fingerprinted it: its body as sent.
      const sent = { method: 'POST', url: `http://${host}/search`, body: { api_key: 'tvly-live-secret-0123456789', query: 'refund' }, encoding: 'json' };
      const old = store.createRun({ mode: 'record', command: { argv: ['x'], cwd: '.' }, meta: { normalizersHash: normalizersHash([], 'exact', false) } });
      const call = store.getCalls(run.runId)[0];
      const fingerprint = fingerprintTool(call.name, sent, []).fingerprint;
      store.appendCallStart({ ...call, runId: old.runId, fingerprint, requestRef: store.putJson({ args: sent }) });
      store.appendCallEnd({ kind: call.kind, name: call.name, fingerprint, occurrence: call.occurrence }, { ...call.end!, runId: old.runId });
      store.endRun(old.runId, 'completed');
      for (const parent of [run.runId, old.runId]) {
        for (const secret of ['live-secret-0123456789', 'rotated-secret-9876543210']) {
          const sidecar = await Sidecar.start({ store, http: [{ host, effect: 'read' }], clock: 'exact' });
          sidecars.push(sidecar);
          const replay = sidecar.startRun({ mode: 'replay', parentRunId: parent, command: { argv: ['x'], cwd: '.' } });
          expect(await search(sidecar.url, replay.runId, secret)).toBe(200);
          expect(sidecar.endRun(replay.runId, 'completed').summary.divergence, `${parent === old.runId ? 'earlier' : 'this'} recording, ${secret}`).toBeNull();
          expect(store.getCalls(replay.runId).map((c) => c.origin)).toEqual(['replayed']);
        }
      }
    } finally {
      for (const s of sidecars) await s.close();
      store.close();
      upstream.close();
    }
  });

  it('leave a lookup by a bare key as recorded, so lookups replayed in another order get their own answers', async () => {
    const upstream = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ flag: new URL(req.url ?? '/', 'http://x').searchParams.get('key') }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const store = Store.open(':memory:');
    const sidecar = await Sidecar.start({ store, http: [{ host, effect: 'read' }] });
    const flag = (runId: string, key: string) => fetch(`${sidecar.url}/r/${runId}/http/flags?key=${key}`, { headers: { 'x-shadowlap-upstream': `http://${host}` } }).then((r) => r.json());
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      expect(await flag(run.runId, 'checkout_v2')).toEqual({ flag: 'checkout_v2' });
      expect(await flag(run.runId, 'search_v3')).toEqual({ flag: 'search_v3' });
      sidecar.endRun(run.runId, 'completed');
      expect(store.getJson(store.getCalls(run.runId)[0].requestRef!)).toEqual({ args: { method: 'GET', url: `http://${host}/flags?key=checkout_v2` } });

      upstream.close();
      const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['x'], cwd: '.' } });
      expect(await flag(replay.runId, 'search_v3')).toEqual({ flag: 'search_v3' });
      expect(await flag(replay.runId, 'checkout_v2')).toEqual({ flag: 'checkout_v2' });
      expect(sidecar.endRun(replay.runId, 'completed').summary.divergence).toBeNull();
    } finally {
      await sidecar.close();
      store.close();
      upstream.close();
    }
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
      expect(seen[0].url).toBe('/customsearch/v1?key=AIzaSyD-live-key-0123&q=refund');
      expect(seen[1].body).toContain('client_secret=live-secret-456');

      const recorded = store.getCalls(run.runId);
      expect(store.getJson(recorded[0].requestRef!)).toEqual({ args: { method: 'GET', url: `http://${host}/customsearch/v1?key=<CREDENTIAL>&q=refund` } });
      expect(store.getJson(recorded[1].requestRef!)).toMatchObject({ args: { body: 'grant_type=client_credentials&client_id=app&client_secret=<CREDENTIAL>', encoding: 'text' } });
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

describe('a captured call whose path holds what a rule masks', () => {
  it('replays from a redacted copy, matched by its name masked as the copy masks it', async () => {
    let hits = 0;
    const upstream = createServer((req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ name: 'Alice Martin', plan: 'pro' }));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const call = (base: string, runId: string) => fetch(`${base}/r/${runId}/http/crm/v1/contacts/alice.martin@example.com`, { headers: { 'x-shadowlap-upstream': `http://${host}` } }).then(async (r) => [r.status, await r.text()] as const);
    const store = Store.open(':memory:');
    const copy = Store.open(':memory:');
    const recording = await Sidecar.start({ store, http: [{ host, effect: 'read' }] });
    let replaying: Sidecar | null = null;
    try {
      const run = recording.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      expect((await call(recording.url, run.runId))[0]).toBe(200);
      recording.endRun(run.runId, 'completed');
      expect(store.getCalls(run.runId)[0].name).toBe(`GET ${host}/crm/v1/contacts/alice.martin@example.com`);

      // A pack's copy: the address is masked in the call's name as in its URL.
      redactRun(store, run.runId, [{ pattern: 'email', replace: '<EMAIL>' }], copy);
      const [packed] = copy.getCalls(run.runId);
      expect(packed.name).toBe(`GET ${host}/crm/v1/contacts/<EMAIL>`);
      expect(JSON.stringify([packed, copy.getJson(packed.requestRef!)])).not.toContain('alice.martin');

      // Replayed where the copy is all there is: the same call, served from it.
      replaying = await Sidecar.start({ store: copy, http: [{ host, effect: 'read' }] });
      const replay = replaying.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['x'], cwd: '.' } });
      expect(await call(replaying.url, replay.runId)).toEqual([200, JSON.stringify({ name: 'Alice Martin', plan: 'pro' })]);
      expect(replaying.endRun(replay.runId, 'completed').summary.divergence).toBeNull();
      expect(hits).toBe(1);
      // The replay keeps the name it was called by.
      expect(copy.getCalls(replay.runId)[0].name).toBe(`GET ${host}/crm/v1/contacts/alice.martin@example.com`);
    } finally {
      await recording.close();
      await replaying?.close();
      store.close();
      copy.close();
      upstream.close();
    }
  });

  interface ContactCall {
    query?: string;
    note?: string;
  }
  /**
   * One call to a contact service looked up by address, recorded, copied under the rules the host
   * gives (`rules`, as a pack copies it), and replayed from the copy alone with the second call:
   * the replay's divergence, or null.
   */
  async function replayCopy(rules: (host: string) => Normalizer[], recorded: ContactCall, replayed: ContactCall) {
    const upstream = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ plan: 'pro' }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const host = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const call = async (base: string, runId: string, c: ContactCall) => {
      const res = await fetch(`${base}/r/${runId}/http/crm/v1/contacts/alice.martin@example.com${c.query ?? ''}`, {
        method: c.note === undefined ? 'GET' : 'POST',
        headers: { 'x-shadowlap-upstream': `http://${host}`, 'content-type': 'application/json' },
        ...(c.note === undefined ? {} : { body: JSON.stringify({ note: c.note }) }),
      });
      await res.text();
      expect(res.status).toBe(200);
    };
    const store = Store.open(':memory:');
    const copy = Store.open(':memory:');
    const recording = await Sidecar.start({ store, http: [{ host, effect: 'read' }] });
    let replaying: Sidecar | null = null;
    try {
      const run = recording.startRun({ mode: 'record', command: { argv: ['x'], cwd: '.' } });
      await call(recording.url, run.runId, recorded);
      recording.endRun(run.runId, 'completed');
      redactRun(store, run.runId, rules(host), copy);
      expect(copy.getCalls(run.runId)[0].name).toMatch(/\/contacts\/<EMAIL>$/);
      replaying = await Sidecar.start({ store: copy, http: [{ host, effect: 'read' }] });
      const replay = replaying.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['x'], cwd: '.' } });
      await call(replaying.url, replay.runId, replayed);
      return replaying.endRun(replay.runId, 'completed').summary.divergence;
    } finally {
      await recording.close();
      await replaying?.close();
      store.close();
      copy.close();
      upstream.close();
    }
  }
  const EMAIL: Normalizer = { pattern: 'email', replace: '<EMAIL>' };

  it('reports a changed request against the recorded call it stands for, whose name the copy masked', async () => {
    const divergence = await replayCopy(() => [EMAIL], { query: '?fields=plan' }, { query: '?fields=plan,tier' });
    expect(divergence).toMatchObject({ type: 'request_changed', callNo: 1, counterpart: { callNo: 1 } });
    expect(divergence!.diff).toEqual([expect.objectContaining({ path: '$.args.url', op: 'changed' })]);
  });

  it('applies a rule written for the call by its name in a replay of the copy, though the copy masked that name', async () => {
    // A note that changes every run, masked for this one call, named as the run page shows it before a copy masks it.
    const NOTE = (host: string): Normalizer => ({ kind: 'tool', name: `POST ${host}/crm/v1/contacts/alice.martin@example.com`, path: '$.args.body.note', replace: '<NOTE>' });
    expect(await replayCopy((host) => [EMAIL, NOTE(host)], { note: 'called at 09:14' }, { note: 'called at 09:20' })).toBeNull();
    expect(await replayCopy((host) => [NOTE(host), EMAIL], { note: 'called at 09:14' }, { note: 'called at 09:20' })).toBeNull();
  });
});
