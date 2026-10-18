import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';

/**
 * What a captured HTTP call (a host under "http" in shadowlap.config.json) carries out of the
 * machine: an agent that calls a search service with its API key in the query string, recorded
 * with `shadowlap run`, then packed and exported. The key is forwarded and never stored, so no copy
 * holds it and a rotated key still replays.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

const KEY = 'AIzaSyD-live-key-0123456789abcdef';
let upstream: Server;
let origin: string;
const received: string[] = [];
let cwd: string;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    received.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{ title: 'Refund policy' }] }));
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-http-redact-')));
  writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ http: { [new URL(origin).host]: 'read' } }));
  writeFileSync(
    join(cwd, 'agent.mjs'),
    `const res = await fetch(process.env.SEARCH_URL + '/customsearch/v1?key=' + process.env.SEARCH_KEY + '&q=refund');\nconsole.log('status', res.status, (await res.json()).items.length);\n`,
  );
});
afterAll(() => {
  upstream.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SEARCH_URL: origin, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

/** Every file under `dir`, as text. */
function readTree(dir: string): string {
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .map((path) => (statSync(path).isDirectory() ? readTree(path) : readFileSync(path, 'latin1')))
    .join('\n');
}

describe('a captured HTTP call', () => {
  it('forwards an API key in its query string and keeps it out of the store, a pack and an HTML export', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs'], { SEARCH_KEY: KEY });
    expect(recorded.code, recorded.out).toBe(0);
    expect(recorded.out).toContain('status 200 1');
    expect(received).toEqual([`/customsearch/v1?key=${KEY}&q=refund`]);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;

    const store = Store.open(join(cwd, '.shadowlap', 'shadowlap.db'));
    const [call] = store.getCalls(runId);
    expect(store.getJson(call!.requestRef!)).toEqual({ args: { method: 'GET', url: `${origin}/customsearch/v1?key=<CREDENTIAL>&q=refund` } });
    store.close();
    expect(readTree(join(cwd, '.shadowlap'))).not.toContain(KEY);

    const packed = await shadowlap(['pack', runId, 'share/run']);
    expect(packed.code, packed.out).toBe(0);
    expect(readTree(join(cwd, 'share'))).not.toContain(KEY);
    const html = await shadowlap(['export', 'html', runId, 'run.html']);
    expect(html.code, html.out).toBe(0);
    expect(readFileSync(join(cwd, 'run.html'), 'utf8')).not.toContain(KEY);

    // A rotated key is the same call: served from the recording, without asking the service.
    const replay = await shadowlap(['replay', runId, '--strict'], { SEARCH_KEY: 'AIzaSyD-rotated-key-999999999' });
    expect(replay.code, replay.out).toBe(0);
    expect(replay.out).toMatch(/Replay clean: 1\/1 calls replayed/);
    expect(received).toHaveLength(1);
  });
});
