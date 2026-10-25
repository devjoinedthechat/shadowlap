import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CREDENTIAL_PLACEHOLDER, rawJsonMember, resultBlob } from '../src/http.js';
import { loadApiRequest, storeApiRequest } from '../src/manifest.js';
import { packRun, unpackRun } from '../src/pack.js';
import { carriesCredentials, credentialFreeCall, previewRedaction, redactQuery, redactRun, redactRunWithDetails } from '../src/redact.js';
import { Store } from '../src/store.js';
import type { Normalizer } from '../src/types.js';

/**
 * Credentials an earlier version didn't know to mask: a pack, an HTML copy and a push leave without
 * them, rules or none, and the redaction rules reach a model call's query string.
 */

const SECRETS = ['SECRET-APIM-123', 'TOKEN-ECHOED', 'HUNTER2', 'SECRET-FORM', 'KEYSTONE-TOKEN', 'sid=COOKIE'];
const EMAIL: Normalizer = { pattern: 'email', replace: '<EMAIL>' };
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

/**
 * A run as an earlier version recorded it: an Azure APIM key in a model call's query (the sidecar
 * kept every parameter but key, token and the like), a credential response header, and a captured
 * HTTP call with a password in its URL, a client secret in its form body and a token in its
 * response headers.
 */
function older(store: Store) {
  const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
  const api = { kind: 'api' as const, name: 'POST /openai/deployments/gpt/chat/completions', fingerprint: 'a'.repeat(64), occurrence: 1 };
  const req = storeApiRequest(store, { messages: [{ role: 'user', content: 'refund order 4417' }] });
  store.appendCallStart({ runId: run.runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: req, meta: { provider: 'azure', query: 'subscription-key=SECRET-APIM-123&api-version=2024-10-21&customer=alice%40example.com' }, at: 1 });
  store.appendCallEnd(api, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from('{"choices":[]}')), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json', authorization: 'Bearer TOKEN-ECHOED' } }, at: 2 });
  const tool = { kind: 'tool' as const, name: 'POST keystone.example.com/v3/auth/tokens', fingerprint: 'b'.repeat(64), occurrence: 1 };
  const toolReq = store.putJson({ args: { method: 'POST', url: 'https://keystone.example.com/v3/auth/tokens?password=HUNTER2&region=eu', body: 'grant_type=client_credentials&client_secret=SECRET-FORM', encoding: 'text' } });
  const toolRes = store.putBlob(resultBlob({ status: 201, headers: { 'content-type': 'application/json', 'x-subject-token': 'KEYSTONE-TOKEN', 'set-cookie': 'sid=COOKIE' }, encoding: 'json' }, '{"token": {"id": 1234567890123456789}}'));
  store.appendCallStart({ runId: run.runId, callNo: 2, ...tool, origin: 'live', effect: 'read', requestRef: toolReq, meta: { http: 'keystone.example.com' }, at: 3 });
  store.appendCallEnd(tool, { runId: run.runId, callNo: 2, attempt: 0, responseRef: toolRes, outcome: 'ok', meta: {}, at: 4 });
  store.endRun(run.runId, 'completed');
  return run;
}

/** Every byte a folder holds, its files read in turn. */
function everything(dir: string): string {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map((path) => readFileSync(path, 'latin1'))
    .join('\n');
}

function packOf(store: Store, runId: string, redact: Normalizer[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), 'sl-pack-cred-'));
  dirs.push(dir);
  packRun(store, runId, join(dir, 'pack'), { redact });
  return join(dir, 'pack');
}

describe('a pack of a recording that kept credentials', () => {
  it('carries none of them, with the rules and with none (--no-redact)', () => {
    const store = Store.open(':memory:');
    const run = older(store);
    expect(carriesCredentials(store, run.runId)).toBe(true);
    for (const rules of [[], [EMAIL]]) {
      const dir = packOf(store, run.runId, rules);
      const bytes = everything(dir);
      for (const secret of SECRETS) expect(bytes, `${secret} with ${rules.length} rules`).not.toContain(secret);

      // What the pack brings in reads as a recording made today does.
      const into = Store.open(':memory:');
      const [id] = unpackRun(into, dir).imported;
      const [model, captured] = into.getCalls(id);
      expect(model.meta.query).toBe(rules.length ? 'api-version=2024-10-21&customer=%3CEMAIL%3E' : 'api-version=2024-10-21&customer=alice%40example.com');
      expect(model.end!.meta.headers).toEqual({ 'content-type': 'application/json', authorization: CREDENTIAL_PLACEHOLDER });
      expect(into.getJson(captured.requestRef!)).toEqual({ args: { method: 'POST', url: `https://keystone.example.com/v3/auth/tokens?password=${CREDENTIAL_PLACEHOLDER}&region=eu`, body: `grant_type=client_credentials&client_secret=${CREDENTIAL_PLACEHOLDER}`, encoding: 'text' } });
      const result = into.getBlob(captured.end!.responseRef!)!.toString('utf8');
      expect(JSON.parse(result).result.headers).toEqual({ 'content-type': 'application/json', 'x-subject-token': CREDENTIAL_PLACEHOLDER });
      // The body the service sent, its 64-bit id with it, byte for byte.
      expect(rawJsonMember(result, ['result', 'body'])).toBe('{"token": {"id": 1234567890123456789}}');
      // A pack made only to mask credentials records no rules.
      expect(into.getRun(id)!.meta?.redactions).toEqual(rules.length ? rules : undefined);
      into.close();
    }
    // The local store keeps the recording as it was made.
    expect(store.getCalls(run.runId)[0].meta.query).toContain('SECRET-APIM-123');
    store.close();
  });

  it('is written from the store as it is when the run kept none', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
    const api = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'c'.repeat(64), occurrence: 1 };
    const req = storeApiRequest(store, { model: 'm', temperature: 1.0, messages: [{ role: 'user', content: 'hi' }] });
    store.appendCallStart({ runId: run.runId, callNo: 1, ...api, origin: 'live', effect: null, requestRef: req, meta: { provider: 'anthropic', query: 'beta=true' }, at: 1 });
    store.appendCallEnd(api, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from('{"id": 1234567890123456789}')), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' } }, at: 2 });
    store.endRun(run.runId, 'completed');
    expect(carriesCredentials(store, run.runId)).toBe(false);
    const dir = packOf(store, run.runId);
    for (const name of readdirSync(join(dir, 'blobs'))) expect(readFileSync(join(dir, 'blobs', name))).toEqual(store.getBlob(name));
    store.close();
  });
});

describe('an HTML copy, and the copies that are only read', () => {
  it('carry none of them either', () => {
    const store = Store.open(':memory:');
    const run = older(store);
    for (const rules of [[], [EMAIL]]) {
      const copy = Store.open(':memory:');
      redactRunWithDetails(store, run.runId, rules, copy);
      const calls = JSON.stringify(copy.getCalls(run.runId));
      const blobs = copy.getCalls(run.runId).flatMap((c) => [c.requestRef, c.end?.responseRef].filter((r): r is string => !!r).map((r) => copy.getBlob(r)!.toString('latin1')));
      for (const secret of SECRETS) expect([calls, ...blobs].join('\n'), secret).not.toContain(secret);
      copy.close();
    }
    store.close();
  });
});

describe('the rules on a model call\'s query', () => {
  const call = { kind: 'api' as const, name: 'POST /openai/deployments/gpt/chat/completions' };

  it('read each parameter decoded, as name=value, and write a changed one encoded', () => {
    expect(redactQuery('customer=alice%40example.com&api-version=2024-10-21', [EMAIL], call)).toBe('customer=%3CEMAIL%3E&api-version=2024-10-21');
    // A lookbehind on the parameter's name.
    expect(redactQuery('tenant=acme+corp&x=1', [{ pattern: '/(?<=tenant=)[\\w ]+/', replace: '<TENANT>' }], call)).toBe('tenant=%3CTENANT%3E&x=1');
    // Credentials go before any rule; a rule scoped to tools, or with a path, doesn't reach the query.
    expect(redactQuery('key=AIza&q=bob%40example.com', [{ kind: 'tool', pattern: 'email', replace: '<EMAIL>' }, { path: '$.q', replace: '<Q>' }], call)).toBe('q=bob%40example.com');
    expect(redactQuery('token=x', [EMAIL], call)).toBeUndefined();
    // Masking twice changes nothing.
    const once = redactQuery('customer=alice%40example.com', [EMAIL], call)!;
    expect(redactQuery(once, [EMAIL], call)).toBe(once);
  });

  it('are counted by the preview as the copy masks them', () => {
    const store = Store.open(':memory:');
    const run = older(store);
    const preview = previewRedaction(store, run.runId, [EMAIL]);
    expect(preview.rules[0].count).toBe(1);
    expect(preview.rules[0].samples[0]).toEqual({ before: 'customer=alice@example.com', after: 'customer=<EMAIL>' });
    // And redactRun writes what the preview counted.
    const copy = Store.open(':memory:');
    redactRun(store, run.runId, [EMAIL], copy);
    expect(copy.getCalls(run.runId)[0].meta.query).toBe('api-version=2024-10-21&customer=%3CEMAIL%3E');
    expect((loadApiRequest(copy, copy.getCalls(run.runId)[0].requestRef!) as { messages: unknown[] }).messages).toHaveLength(1);
    copy.close();
    store.close();
  });
});

describe('a call as a push copies it', () => {
  it('leaves its query\'s credentials and credential headers behind, and is the same call when it has none', () => {
    const store = Store.open(':memory:');
    const run = older(store);
    const [model, captured] = store.getCalls(run.runId);
    const pushed = credentialFreeCall(model);
    expect(pushed.meta.query).toBe('api-version=2024-10-21&customer=alice%40example.com');
    expect(pushed.end!.meta.headers).toEqual({ 'content-type': 'application/json', authorization: CREDENTIAL_PLACEHOLDER });
    expect(credentialFreeCall(pushed)).toBe(pushed);
    expect(credentialFreeCall(captured)).toBe(captured);
    store.close();
  });
});
