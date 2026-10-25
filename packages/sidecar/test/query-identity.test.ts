import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packRun, Store, storeApiRequest, unpackRun, type Normalizer } from '@shadowlap/engine';
import { Sidecar } from '../src/index.js';

/**
 * A model call's query string is part of what makes it the call it is: Gemini's `alt=sse` asks for a
 * stream of events where the same request without it gets one JSON array, Azure's `api-version`
 * picks the API's shape, and a page cursor picks the page. A credential in it never is: a recording
 * keeps none, and a rotated key must still replay.
 */

/** An upstream that answers with what it was asked: the path and the query, as JSON, or as one event for `alt=sse`. */
let upstream: Server;
let upstreamUrl = '';
let asked = 0;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    asked++;
    const url = new URL(req.url ?? '/', 'http://upstream');
    const answer = JSON.stringify({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    req.resume();
    req.on('end', () => {
      if (url.searchParams.get('alt') === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`data: ${answer}\r\n\r\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(answer);
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

const command = { argv: ['agent'], cwd: '/' };
const GEMINI = '/v1beta/models/gemini-2.5-flash:streamGenerateContent';
const AZURE = '/openai/deployments/gpt-4o/chat/completions';
const body = (provider: string) => (provider === 'gemini' ? { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] } : { messages: [{ role: 'user', content: 'hello' }] });

interface Call {
  provider: 'gemini' | 'azure' | 'openai';
  path: string;
  query?: string;
  method?: 'GET' | 'POST';
}

/** Sends each call through a run of `mode`, in order, and ends the run: each answer's text, and the summary. */
async function through(store: Store, mode: 'record' | 'replay', calls: Call[], parentRunId?: string, clock: 'auto' | 'exact' = 'auto') {
  const sidecar = await Sidecar.start({ store, clock, upstreams: { gemini: upstreamUrl, azure: upstreamUrl, openai: upstreamUrl } });
  const run = sidecar.startRun({ mode, command, ...(parentRunId ? { parentRunId, offline: true } : {}) });
  const answers: string[] = [];
  try {
    for (const c of calls) {
      const method = c.method ?? 'POST';
      const res = await fetch(`${sidecar.url}/r/${run.runId}/${c.provider}${c.path}${c.query ? `?${c.query}` : ''}`, { method, headers: { 'content-type': 'application/json', 'api-key': 'azure-key-1' }, ...(method === 'POST' ? { body: JSON.stringify(body(c.provider)) } : {}) });
      answers.push(`${res.status} ${await res.text()}`);
    }
    return { runId: run.runId, answers, summary: sidecar.endRun(run.runId, 'completed').summary };
  } finally {
    await sidecar.close();
  }
}

describe('the query string in a call\'s identity', () => {
  it('tells a streamed Gemini call (alt=sse) from the same request without it', async () => {
    const store = Store.open(':memory:');
    const rec = await through(store, 'record', [{ provider: 'gemini', path: GEMINI, query: 'alt=sse' }]);
    expect(store.getCalls(rec.runId)[0].meta.query).toBe('alt=sse');
    expect((await through(store, 'replay', [{ provider: 'gemini', path: GEMINI, query: 'alt=sse' }], rec.runId)).summary.divergence).toBeNull();
    const without = await through(store, 'replay', [{ provider: 'gemini', path: GEMINI }], rec.runId);
    expect(without.summary.divergence).toMatchObject({ type: 'request_changed', callNo: 1, diff: [{ path: 'query.alt', op: 'removed', before: 'sse' }] });
    expect(without.summary.divergence?.hints?.map((h) => h.message).join('\n')).toContain('the alt query parameter is part of what makes a model call the same call');
    store.close();
  });

  it('forks on a changed Azure api-version, and names it', async () => {
    const store = Store.open(':memory:');
    const rec = await through(store, 'record', [{ provider: 'azure', path: AZURE, query: 'api-version=2024-10-21' }]);
    for (const clock of ['auto', 'exact'] as const) {
      expect((await through(store, 'replay', [{ provider: 'azure', path: AZURE, query: 'api-version=2024-10-21' }], rec.runId, clock)).summary.divergence, clock).toBeNull();
      const newer = await through(store, 'replay', [{ provider: 'azure', path: AZURE, query: 'api-version=2025-04-01-preview' }], rec.runId, clock);
      expect(newer.summary.divergence, clock).toMatchObject({ type: 'request_changed', diff: [{ path: 'query.api-version', op: 'changed', before: '2024-10-21', after: '2025-04-01-preview' }] });
    }
    store.close();
  });

  it('serves each page its own answer by its cursor, whatever order the pages are asked in', async () => {
    const store = Store.open(':memory:');
    const first: Call = { provider: 'openai', path: '/v1/files', query: 'limit=2', method: 'GET' };
    const second: Call = { provider: 'openai', path: '/v1/files', query: 'limit=2&after=file_2', method: 'GET' };
    const rec = await through(store, 'record', [first, second]);
    const before = asked;
    // Asked the second page first, as an agent resuming a listing does: the cursor's page, not the first recorded.
    const rep = await through(store, 'replay', [second, first], rec.runId);
    expect(rep.summary.divergence).toBeNull();
    expect(JSON.parse(rep.answers[0].slice(4)).query).toEqual({ limit: '2', after: 'file_2' });
    expect(JSON.parse(rep.answers[1].slice(4)).query).toEqual({ limit: '2' });
    expect(asked).toBe(before);
    // Another cursor is another page: the recording holds no answer for it.
    const other = (await through(store, 'replay', [{ ...second, query: 'limit=2&after=file_4' }], rec.runId)).summary.divergence;
    expect(other).toMatchObject({ type: 'request_changed', diff: [{ path: 'query.after', after: 'file_4' }] });
    store.close();
  });

  it('leaves a key in the query out of it: the recording keeps none, and a rotated key replays', async () => {
    const store = Store.open(':memory:');
    const rec = await through(store, 'record', [{ provider: 'gemini', path: GEMINI, query: 'alt=sse&key=AIzaSyA-recorded-key-1234567890' }]);
    expect(store.getCalls(rec.runId)[0].meta.query).toBe('alt=sse');
    expect(JSON.stringify(store.getCalls(rec.runId))).not.toContain('AIzaSyA');
    const rep = await through(store, 'replay', [{ provider: 'gemini', path: GEMINI, query: 'key=AIzaSyB-rotated-key-0987654321&alt=sse' }], rec.runId);
    expect(rep.summary.divergence).toBeNull();
    expect(rep.answers[0]).toContain('"alt":"sse"');
    store.close();
  });

  it('fingerprints a recording made before the query took part again, from the query it kept', async () => {
    const store = Store.open(':memory:');
    // As an earlier version left it: fingerprints computed without the query, under another version.
    const run = store.createRun({ mode: 'record', command, meta: { normalizersHash: 'fingerprints-of-an-earlier-version' } });
    store.appendCallStart({ runId: run.runId, callNo: 1, kind: 'api', name: `POST ${AZURE}`, fingerprint: 'computed-without-the-query', occurrence: 1, origin: 'live', effect: null, requestRef: storeApiRequest(store, body('azure')), meta: { provider: 'azure', fingerprintHeaders: {}, query: 'api-version=2024-10-21' }, at: run.startedAt });
    store.appendCallEnd({ kind: 'api', name: `POST ${AZURE}`, fingerprint: 'computed-without-the-query', occurrence: 1 }, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from('{"answer":"recorded"}')), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' } }, at: run.startedAt });
    store.endRun(run.runId, 'completed');
    for (const clock of ['auto', 'exact'] as const) {
      const rep = await through(store, 'replay', [{ provider: 'azure', path: AZURE, query: 'api-version=2024-10-21' }], run.runId, clock);
      expect(rep.summary.divergence, clock).toBeNull();
      expect(rep.answers[0], clock).toBe('200 {"answer":"recorded"}');
    }
    store.close();
  });

  it('matches whatever query a recording that kept none carries, and keeps none itself, so its replays match the same way', async () => {
    const store = Store.open(':memory:');
    // A call recorded before calls kept their query, or imported from a trace, which never knows it.
    const run = store.createRun({ mode: 'record', command, meta: {} });
    const identity = { kind: 'api' as const, name: `POST ${AZURE}`, fingerprint: 'f', occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, body('azure')), meta: { provider: 'azure', fingerprintHeaders: {} }, at: run.startedAt });
    store.appendCallEnd(identity, { runId: run.runId, callNo: 1, attempt: 0, responseRef: store.putBlob(Buffer.from('{"answer":"recorded"}')), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' } }, at: run.startedAt });
    store.endRun(run.runId, 'completed');
    const rep = await through(store, 'replay', [{ provider: 'azure', path: AZURE, query: 'api-version=2024-10-21' }], run.runId);
    expect(rep.summary.divergence).toBeNull();
    expect(store.getCalls(rep.runId)[0].meta.query).toBeUndefined();
    expect((await through(store, 'replay', [{ provider: 'azure', path: AZURE, query: 'api-version=2025-04-01-preview' }], rep.runId)).summary.divergence).toBeNull();
    store.close();
  });

  it('forks when a call recorded with no query is sent with one', async () => {
    const store = Store.open(':memory:');
    const rec = await through(store, 'record', [{ provider: 'azure', path: AZURE }]);
    // Kept as empty: it had none, which is not the same as not knowing.
    expect(store.getCalls(rec.runId)[0].meta.query).toBe('');
    const rep = await through(store, 'replay', [{ provider: 'azure', path: AZURE, query: 'api-version=2024-10-21' }], rec.runId);
    expect(rep.summary.divergence).toMatchObject({ type: 'request_changed', diff: [{ path: 'query.api-version', op: 'added', after: '2024-10-21' }] });
    store.close();
  });

  it('replays a redacted pack whose rule masked a query parameter, the live call read as the pack keeps it', async () => {
    const tenant = 'tenant=acme-corp-77';
    // A rule over the whole parameter, name and value, and one over its value alone.
    const rules: Normalizer[][] = [[{ kind: 'api', pattern: '/tenant=acme-corp-\\d+/g', replace: 'tenant=<TENANT>' }], [{ kind: 'api', pattern: '/acme-corp-\\d+/g', replace: '<TENANT>' }]];
    for (const redact of rules) {
      const store = Store.open(':memory:');
      const dir = mkdtempSync(join(tmpdir(), 'sl-redacted-query-'));
      try {
        const rec = await through(store, 'record', [{ provider: 'azure', path: AZURE, query: `api-version=2024-10-21&${tenant}` }]);
        packRun(store, rec.runId, join(dir, 'golden'), { redact });
        const golden = Store.open(':memory:');
        try {
          const { imported } = unpackRun(golden, join(dir, 'golden'));
          // The pack keeps the query masked, and no tenant.
          expect(JSON.stringify(golden.getCalls(imported[0]))).not.toContain('acme-corp-77');
          for (const clock of ['auto', 'exact'] as const) {
            const rep = await through(golden, 'replay', [{ provider: 'azure', path: AZURE, query: `api-version=2024-10-21&${tenant}` }], imported[0], clock);
            expect(rep.summary.divergence, `${JSON.stringify(redact)} ${clock}`).toBeNull();
            expect(rep.answers[0]).toContain('200 ');
          }
          // Another version still forks: only what the rule masked matches whatever it was.
          const other = await through(golden, 'replay', [{ provider: 'azure', path: AZURE, query: `api-version=2025-04-01-preview&${tenant}` }], imported[0]);
          expect(other.summary.divergence).toMatchObject({ type: 'request_changed', diff: [{ path: 'query.api-version' }] });
        } finally {
          golden.close();
        }
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

