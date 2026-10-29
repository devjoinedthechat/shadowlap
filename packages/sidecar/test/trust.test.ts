import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { tool } from '@shadowlap/sdk';
import { Sidecar } from '../src/index.js';
import { pythonCommand } from '../../../testing/python-with.mjs';

/**
 * A tool marked untrusted (the reads `shadowlap injection` plants in) is recorded so on each call,
 * from the TypeScript SDK and the Python SDK alike, and the mark never enters a call's
 * fingerprint: a recording made before the tool was marked still replays.
 */

const PY_SDK = fileURLToPath(new URL('../../../sdks/python', import.meta.url));

const PYTHON = pythonCommand();

let store: Store;
let sidecar: Sidecar;

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
});
afterAll(async () => {
  await sidecar.close();
  store.close();
});

/** Runs `fn` with the SDK pointed at `runId`, as an agent under shadowlap run is. */
async function inRun<T>(runId: string, fn: () => Promise<T>): Promise<T> {
  const saved = { url: process.env.SHADOWLAP_URL, run: process.env.SHADOWLAP_RUN_ID };
  Object.assign(process.env, sidecar.envFor(runId));
  try {
    return await fn();
  } finally {
    for (const [k, v] of [['SHADOWLAP_URL', saved.url], ['SHADOWLAP_RUN_ID', saved.run]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('trust on a tool', () => {
  it('is recorded on each call of a tool the TypeScript SDK marks untrusted, and on no other', async () => {
    const fetchPage = tool('fetch_page', { effect: 'read', trust: 'untrusted' }, async ({ url }: { url: string }) => ({ url, text: 'a page' }));
    const search = tool('search', { effect: 'read' }, async ({ q }: { q: string }) => [q]);
    const lookup = tool('lookup', { effect: 'read', trust: 'trusted' }, async ({ k }: { k: string }) => k);
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    await inRun(run.runId, async () => {
      await fetchPage({ url: 'https://example.com/a' });
      await search({ q: 'x' });
      await lookup({ k: 'y' });
    });
    sidecar.endRun(run.runId, 'completed');
    expect(store.getCalls(run.runId).map((c) => [c.name, c.meta.trust ?? null, c.meta.trustFrom ?? null])).toEqual([
      ['fetch_page', 'untrusted', 'sdk'],
      ['search', null, null],
      ['lookup', null, null],
    ]);
  });

  it('records the config\'s marks on the calls too, either way, over the SDK\'s word', async () => {
    const marked = await Sidecar.start({ store, trust: { search: { trust: 'untrusted' }, fetch_page: { trust: 'trusted' } } });
    try {
      const fetchPage = tool('fetch_page', { effect: 'read', trust: 'untrusted' }, async ({ url }: { url: string }) => ({ url }));
      const search = tool('search', { effect: 'read' }, async ({ q }: { q: string }) => [q]);
      const other = tool('other', { effect: 'read' }, async () => 1);
      const run = marked.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      const saved = { url: process.env.SHADOWLAP_URL, run: process.env.SHADOWLAP_RUN_ID };
      Object.assign(process.env, marked.envFor(run.runId));
      try {
        await fetchPage({ url: 'https://example.com/a' });
        await search({ q: 'x' });
        await other({});
      } finally {
        for (const [k, v] of [['SHADOWLAP_URL', saved.url], ['SHADOWLAP_RUN_ID', saved.run]] as const) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      marked.endRun(run.runId, 'completed');
      expect(store.getCalls(run.runId).map((c) => [c.name, c.meta.trust ?? null, c.meta.trustFrom ?? null])).toEqual([
        ['fetch_page', 'trusted', 'config'],
        ['search', 'untrusted', 'config'],
        ['other', null, null],
      ]);
    } finally {
      await marked.close();
    }
  });

  it('refuses a trust it does not know when the tool is made', () => {
    expect(() => tool('x', { effect: 'read', trust: 'maybe' as never }, async () => 1)).toThrow('tool x: trust must be "trusted" or "untrusted"');
  });

  it('never changes how a call matches: a tool marked after its recording still replays', async () => {
    let ran = 0;
    const before = tool('fetch_page', { effect: 'read' }, async ({ url }: { url: string }) => (ran++, { url }));
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    await inRun(run.runId, () => before({ url: 'https://example.com/b' }));
    sidecar.endRun(run.runId, 'completed');
    const after = tool('fetch_page', { effect: 'read', trust: 'untrusted' }, async ({ url }: { url: string }) => (ran++, { url }));
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['agent'], cwd: '.' } });
    expect(await inRun(replay.runId, () => after({ url: 'https://example.com/b' }))).toEqual({ url: 'https://example.com/b' });
    const { summary } = sidecar.endRun(replay.runId, 'completed');
    expect(ran).toBe(1);
    expect(summary.divergence).toBeNull();
    expect(store.getCalls(replay.runId)[0].meta.trust).toBe('untrusted');
  });

  it.skipIf(!PYTHON)('is recorded on each call of a tool the Python SDK marks untrusted', async () => {
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: '.' } });
    const code = [
      'import sys',
      `sys.path.insert(0, ${JSON.stringify(PY_SDK)})`,
      'from shadowlap import tool',
      '@tool(effect="read", trust="untrusted")',
      'def fetch_page(url: str) -> dict:',
      '    return {"url": url, "text": "a page"}',
      '@tool(effect="read")',
      'def search(query: str) -> list:',
      '    return [query]',
      'fetch_page("https://example.com/a")',
      'search("x")',
    ].join('\n');
    await promisify(execFile)(PYTHON!, ['-c', code], { env: { ...process.env, ...sidecar.envFor(run.runId) }, encoding: 'utf8' });
    sidecar.endRun(run.runId, 'completed');
    expect(store.getCalls(run.runId).map((c) => [c.name, c.meta.trust ?? null])).toEqual([
      ['fetch_page', 'untrusted'],
      ['search', null],
    ]);
  });
});

describe('a captured HTTP call', () => {
  it('is marked by its host in the config, and, read anew after a fork, fenced when the replay asks', async () => {
    let served = 0;
    const page = createServer((req, res) => {
      served++;
      req.resume();
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`page ${req.url}`);
    });
    await new Promise<void>((r) => page.listen(0, '127.0.0.1', () => r()));
    const origin = `http://127.0.0.1:${(page.address() as AddressInfo).port}`;
    const host = new URL(origin).host;
    const capturing = await Sidecar.start({ store, http: [{ host, effect: 'read' }], trust: { [host]: { trust: 'untrusted' } } });
    try {
      const get = (runId: string, path: string) => fetch(`${capturing.url}/r/${runId}/http${path}`, { headers: { 'x-shadowlap-upstream': origin } });
      const run = capturing.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
      expect((await get(run.runId, '/a')).status).toBe(200);
      capturing.endRun(run.runId, 'completed');
      expect(store.getCalls(run.runId).map((c) => [c.meta.http, c.meta.trust, c.meta.trustFrom])).toEqual([[host, 'untrusted', 'config']]);
      // A replay that reads another page: the recording doesn't hold it, so it is fenced, never fetched.
      const replay = capturing.startRun({ mode: 'replay', parentRunId: run.runId, command: { argv: ['agent'], cwd: '.' }, replay: { writes: 'stub', reads: 'replay', liveTools: new Set(), unrecordedReads: 'fence' } });
      const fenced = await get(replay.runId, '/collect?d=x7f3kq2m%40canary.invalid');
      expect(fenced.status).toBe(409);
      expect(((await fenced.json()) as { error: { type: string; message: string } }).error).toEqual({ type: 'shadowlap_read_blocked', message: `GET ${host}/collect was not run: this replay answers only the reads its recording holds` });
      capturing.endRun(replay.runId, 'completed');
      expect(served).toBe(1);
      expect(store.getCalls(replay.runId).map((c) => c.origin)).toEqual(['blocked']);
    } finally {
      await capturing.close();
      await new Promise((r) => page.close(r));
    }
  });
});
