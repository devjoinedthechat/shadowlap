import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { guardEnv } from '../src/index.js';
import { liveProxies, registerProxy } from '../src/mcp-proxies.js';
import { pythonCommand } from '../../../testing/python-with.mjs';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from './fake-mcp-http-server.js';

/**
 * A `shadowlap mcp --listen` started on its own records the tool calls of every Shadowlap command's
 * agents, so their network guard lets them reach it: it registers its address, owner-only, in the
 * home folder while it runs, and a command that starts agents lets them through to each running
 * proxy of this user's it finds there, `shadowlap test`'s block included, with no warning that the
 * connection bypasses Shadowlap. A registration that is stale, not this user's alone, or anything
 * but a proxy on this machine lets nothing through.
 */

const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const PYTHON = pythonCommand();
const POSIX = process.platform !== 'win32';
/** A process id no process has: past what macOS gives, and near the top of Linux's default range. */
const GONE = 2 ** 22 - 9;

describe('the MCP proxies a command lets its agents reach', () => {
  let home: string;
  const folder = () => join(home, 'mcp');
  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'sl-proxies-')));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('lists a running proxy of this user by its address, and localhost at its port, until it stops', () => {
    const registered = registerProxy({ host: '127.0.0.1', port: 8931 }, { home });
    expect(registered.file).toBe(join(folder(), `${process.pid}.json`));
    expect(liveProxies({ home })).toEqual(['127.0.0.1:8931', 'localhost:8931']);
    registered.unregister();
    expect(liveProxies({ home })).toEqual([]);
    expect(readdirSync(folder())).toEqual([]);
  });

  it('lets nothing through for a registration whose proxy is gone, or that names another process or a host off this machine', () => {
    mkdirSync(folder(), { recursive: true, mode: 0o700 });
    const write = (pid: number, body: unknown) => writeFileSync(join(folder(), `${pid}.json`), JSON.stringify(body), { mode: 0o600 });
    write(GONE, { v: 1, pid: GONE, host: '127.0.0.1', port: 8001 });
    write(process.pid, { v: 1, pid: process.pid, host: '10.0.0.5', port: 8002 });
    write(process.ppid, { v: 1, pid: GONE, host: '127.0.0.1', port: 8003 });
    expect(liveProxies({ home })).toEqual([]);
  });

  it.skipIf(!POSIX)("lets nothing through for a registration that isn't this user's alone: one others can read, a link, or in a folder others can read", () => {
    mkdirSync(folder(), { recursive: true, mode: 0o700 });
    const body = (port: number) => JSON.stringify({ v: 1, pid: process.pid, host: '127.0.0.1', port });
    writeFileSync(join(folder(), `${process.pid}.json`), body(8004), { mode: 0o644 });
    chmodSync(join(folder(), `${process.pid}.json`), 0o644);
    const elsewhere = join(home, 'elsewhere.json');
    writeFileSync(elsewhere, body(8005), { mode: 0o600 });
    symlinkSync(elsewhere, join(folder(), `${process.ppid}.json`));
    expect(liveProxies({ home })).toEqual([]);
    // Its own, in a folder others can read: refused all the same.
    rmSync(folder(), { recursive: true, force: true });
    mkdirSync(folder(), { recursive: true });
    chmodSync(folder(), 0o755);
    writeFileSync(join(folder(), `${process.pid}.json`), body(8006), { mode: 0o600 });
    expect(liveProxies({ home })).toEqual([]);
  });
});

describe("a proxy's address, under the network guard", () => {
  let store: Store;
  let sidecar: Sidecar;
  let proxy: Server;
  let port: number;
  let home: string;
  const run = promisify(execFile);

  beforeAll(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
    // Stands in for the proxy: what matters is that the guard lets the agent reach its address.
    proxy = createServer((_req, res) => res.end('reached'));
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    port = (proxy.address() as AddressInfo).port;
    home = realpathSync(mkdtempSync(join(tmpdir(), 'sl-proxies-guard-')));
  });
  afterAll(async () => {
    await sidecar.close();
    await new Promise<void>((r) => proxy.close(() => r()));
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  const NODE = `try { console.log(await (await fetch(process.env.TARGET)).text()); } catch (err) { console.log(String(err.cause?.code ?? err)); }`;
  const PY = `
import os, urllib.request
try:
    print(urllib.request.urlopen(os.environ['TARGET'], timeout=5).read().decode())
except OSError as err:
    print('refused', err)
`;

  /** What a Node agent, and a Python one where there is Python, got from the proxy under block, and what the run says bypassed Shadowlap. */
  async function reach(proxies: string): Promise<{ node: string; python: string | null; unguarded: unknown[] }> {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '.' } });
    const env = { ...process.env, ...sidecar.envFor(rec.runId), ...guardEnv('block'), TARGET: `http://127.0.0.1:${port}/`, SHADOWLAP_MCP_PROXIES: proxies };
    const node = (await run(process.execPath, ['--input-type=module', '-e', NODE], { env })).stdout.trim();
    const python = PYTHON ? (await run(PYTHON, ['-c', PY], { env })).stdout.trim() : null;
    const { unguarded } = sidecar.endRun(rec.runId, 'completed');
    return { node, python, unguarded };
  }

  it('lets a Node or Python agent reach a running proxy under block, as no bypass, and nothing once it is stale', async () => {
    const registered = registerProxy({ host: '127.0.0.1', port }, { home });
    expect(await reach(liveProxies({ home }).join(','))).toEqual({ node: 'reached', python: PYTHON ? 'reached' : null, unguarded: [] });
    registered.unregister();
    // Left by a proxy that was killed: its process is gone.
    writeFileSync(join(home, 'mcp', `${GONE}.json`), JSON.stringify({ v: 1, pid: GONE, host: '127.0.0.1', port }), { mode: 0o600 });
    const refused = await reach(liveProxies({ home }).join(','));
    expect(refused.node).toBe('ESHADOWLAP');
    if (PYTHON) expect(refused.python).toMatch(/^refused .*shadowlap: blocked an outbound connection to 127\.0\.0\.1:\d+/);
    expect(refused.unguarded).toEqual([{ target: `127.0.0.1:${port}`, count: PYTHON ? 2 : 1, action: 'blocked' }]);
  }, 60_000);
});

/**
 * As the review found it: an HTTP MCP client recorded through a proxy started on its own, packed,
 * then tested, whose `block` refused the agent's connection to the proxy itself.
 */
describe('shadowlap mcp --listen started on its own, beside run, pack and test', () => {
  let server: FakeMcpHttpServer;
  let dir: string;
  let home: string;
  let cwd: string;
  let client: string;
  let proxy: ChildProcess | null = null;

  beforeAll(async () => {
    server = await startFakeMcpHttpServer();
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'sl-listen-guard-')));
    home = join(dir, 'home');
    cwd = join(dir, 'project');
    mkdirSync(home);
    mkdirSync(cwd);
    // An agent's MCP client over Streamable HTTP: a session, a read and a write, printing what each got.
    client = join(dir, 'client.mjs');
    writeFileSync(
      client,
      `const endpoint = process.argv[2];
let session = null, version = null, id = 0;
const headers = () => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}) });
async function request(method, params) {
  const res = await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) }) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) session = sid;
  const text = await res.text();
  if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) return JSON.parse(text);
  const data = text.split(/\\r?\\n\\r?\\n/).map((b) => b.split(/\\r?\\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\\n')).filter(Boolean);
  return JSON.parse(data.at(-1));
}
const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent', version: '1' } });
version = init.result.protocolVersion;
await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
await request('tools/list');
const read = await request('tools/call', { name: 'read_note', arguments: { id: 1 } });
const sent = await request('tools/call', { name: 'send_note', arguments: { to: 'y' } });
console.log(JSON.stringify({ read: read.result.content[0].text, sent: sent.result.content[0].text }));
`,
    );
  });
  afterAll(async () => {
    proxy?.kill('SIGKILL');
    await server.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  // The home folder is HOME, and on Windows USERPROFILE: with no SHADOWLAP_HOME, the proxy registers in its .shadowlap, and every command reads it.
  const env = () => ({ ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: undefined, SHADOWLAP_GUARD: undefined, SHADOWLAP_URL: undefined, SHADOWLAP_RUN_ID: undefined });

  function shadowlap(args: string[]): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], { cwd, env: env(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out }));
    });
  }

  it("records through it with no warning that it bypasses Shadowlap, and its golden passes under test's block", async () => {
    const started = spawn(process.execPath, [CLI, 'mcp', '--url', server.url, '--listen', '127.0.0.1:0'], { cwd, env: env(), stdio: ['ignore', 'ignore', 'pipe'] });
    proxy = started;
    let said = '';
    const endpoint = await new Promise<string>((resolve, reject) => {
      started.stderr.on('data', (chunk: Buffer) => {
        said += chunk.toString();
        const m = /serving \S+ at (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(said);
        if (m) resolve(m[1]);
      });
      started.once('exit', (code) => reject(new Error(`exited ${code}: ${said}`)));
    });
    expect(readdirSync(join(home, '.shadowlap', 'mcp'))).toEqual([`${started.pid}.json`]);

    const rec = await shadowlap(['run', '--', process.execPath, client, endpoint]);
    expect(rec.code, rec.out).toBe(0);
    expect(rec.out).toContain('{"read":"read_note:{\\"id\\":1}:1","sent":"send_note:{\\"to\\":\\"y\\"}:2"}');
    // The guard's warning, and the summary's list of what bypassed Shadowlap: neither names the proxy.
    expect(rec.out).not.toMatch(/outbound connection|bypassed Shadowlap/);
    expect(server.calls.map((c) => c.name)).toEqual(['read_note', 'send_note']);
    const runId = /recording run (\w{26})/.exec(rec.out)![1];

    expect((await shadowlap(['pack', runId, 'goldens/g'])).code).toBe(0);
    const test = await shadowlap(['test', 'goldens/g']);
    expect(test.code, test.out).toBe(0);
    expect(test.out).toMatch(/1 passed, 0 failed/);
    expect(test.out).not.toMatch(/outbound connection|bypassed Shadowlap|blocked/);
    // The recording answered both calls: the server saw neither again.
    expect(server.calls).toHaveLength(2);

    // Stopped, it takes its registration with it.
    const code = new Promise<number | null>((resolve) => started.once('exit', resolve));
    started.kill('SIGTERM');
    expect(await code).toBe(143);
    proxy = null;
    expect(readdirSync(join(home, '.shadowlap', 'mcp'))).toEqual([]);
  }, 120_000);
});
