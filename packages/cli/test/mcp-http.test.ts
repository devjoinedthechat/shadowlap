import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { mcpServerUrl, parseHeaderFlags, startMcpHttpProxy, type SidecarTarget } from '../src/mcp.js';
import { guardEnv } from '../src/run-agent.js';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from './fake-mcp-http-server.js';

/**
 * `shadowlap mcp --url`: the agent's MCP client talks stdio to the proxy, and the proxy talks
 * Streamable HTTP to a remote server. Tool calls are recorded, replayed and fenced as with a local
 * server; the point to prove is that a remote write never runs again on replay.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

type Message = Record<string, unknown>;

/** Speaks to anything that reads and writes newline-delimited JSON-RPC, like an MCP client. */
function rpc(input: NodeJS.WritableStream, output: NodeJS.ReadableStream) {
  const waiters = new Map<number, (m: Message) => void>();
  const notifications: Message[] = [];
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as Message;
      if (typeof m.id === 'number' && m.method === undefined) waiters.get(m.id)?.(m);
      else notifications.push(m);
    }
  });
  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<Message> => {
    const id = nextId++;
    const p = new Promise<Message>((resolve) => waiters.set(id, resolve));
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n');
    return p;
  };
  const notify = (method: string) => input.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  /** The handshake every MCP client starts with. */
  const handshake = async () => {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    notify('notifications/initialized');
    return init;
  };
  return { request, notify, handshake, notifications, call: (name: string, args: unknown) => request('tools/call', { name, arguments: args }) };
}

const text = (m: Message) => (m.result as { content: Array<{ text: string }> }).content[0]!.text;

describe('shadowlap mcp --url', () => {
  let store: Store;
  let sidecar: Sidecar;
  let server: FakeMcpHttpServer;
  const target = (runId: string): SidecarTarget => ({ url: sidecar.envFor(runId).SHADOWLAP_URL!, runId });

  /** A client in front of a proxy in this process. */
  function client(sidecarTarget: SidecarTarget | null, opts: { headers?: Record<string, string>; effects?: Record<string, 'pure' | 'read' | 'write'> } = {}) {
    const clientIn = new PassThrough();
    const clientOut = new PassThrough();
    const proxy = startMcpHttpProxy({ clientIn, clientOut, url: server.url, sidecar: sidecarTarget, ...(opts.headers ? { headers: opts.headers } : {}), ...(opts.effects ? { effects: opts.effects } : {}) });
    const c = rpc(clientIn, clientOut);
    return {
      ...c,
      close: async () => {
        clientIn.end();
        return proxy.done;
      },
    };
  }

  beforeAll(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
  });
  beforeEach(async () => {
    server = await startFakeMcpHttpServer();
  });
  afterEach(async () => {
    await server.close();
  });
  afterAll(async () => {
    await sidecar.close();
    store.close();
  });

  it('records tool calls over Streamable HTTP, with effects from readOnlyHint, in the session the server gave', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c = client(target(rec.runId), { headers: { authorization: 'Bearer t0ken' } });
    const init = await c.handshake();
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('fake-http');
    const listed = await c.request('tools/list');
    expect((listed.result as { tools: unknown[] }).tools).toHaveLength(3);
    // The server's own message on the event stream reaches the client too.
    expect(c.notifications).toContainEqual({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing tools' } });
    expect(text(await c.call('read_note', { id: 7 }))).toBe('read_note:{"id":7}:1');
    expect(text(await c.call('send_note', { to: 'x' }))).toBe('send_note:{"to":"x"}:2');
    expect(((await c.call('boom', {})).error as { message: string }).message).toBe('boom failed');
    expect(await c.close()).toBe(0);
    sidecar.endRun(rec.runId, 'completed');

    const calls = store.getCalls(rec.runId);
    expect(calls.map((x) => [x.name, x.effect, x.end?.outcome])).toEqual([
      ['read_note', 'read', 'ok'],
      ['send_note', 'write', 'ok'],
      ['boom', 'write', 'error'],
    ]);
    expect(calls[0]!.meta.implHash).toMatch(/^[0-9a-f]{64}$/);

    // Every request after initialize carried the session and the protocol version; every one carried the header.
    const afterInit = server.seen.filter((s) => s.http === 'POST' && s.method !== 'initialize');
    expect(afterInit.every((s) => s.session === 'session-1' && s.protocol === '2025-06-18')).toBe(true);
    expect(server.seen.filter((s) => s.http === 'POST').every((s) => s.authorization === 'Bearer t0ken')).toBe(true);
    // The proxy asked for the server's own stream once the session started, and ended the session on leaving.
    expect(server.seen.map((s) => s.http)).toContain('GET');
    expect(server.seen.at(-1)).toMatchObject({ http: 'DELETE', session: 'session-1' });

    // Replay: answered from the recording; the server never sees a tool call.
    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    const before = server.calls.length;
    const r = client(target(rep.runId), { headers: { authorization: 'Bearer t0ken' } });
    await r.handshake();
    await r.request('tools/list');
    expect(text(await r.call('read_note', { id: 7 }))).toBe('read_note:{"id":7}:1');
    expect(text(await r.call('send_note', { to: 'x' }))).toBe('send_note:{"to":"x"}:2');
    expect((await r.call('boom', {})).error).toEqual({ code: -32001, message: 'boom failed', data: { n: 3 } });
    await r.close();
    const replayed = sidecar.endRun(rep.runId, 'completed');
    expect(replayed.summary.divergence).toBeNull();
    expect(replayed.summary.byOrigin.replayed).toBe(3);
    expect(server.calls.length).toBe(before);

    // Fork: a changed read runs live; the remote write after it is refused and never reaches the server.
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    const f = client(target(fork.runId));
    await f.handshake();
    await f.request('tools/list');
    expect(text(await f.call('read_note', { id: 8 }))).toMatch(/^read_note:\{"id":8\}:\d+$/);
    const blocked = await f.call('send_note', { to: 'x' });
    expect((blocked.result as { isError: boolean }).isError).toBe(true);
    await f.close();
    const forked = sidecar.endRun(fork.runId, 'completed');
    expect(forked.summary.divergence?.callNo).toBe(1);
    expect(forked.summary.byOrigin).toMatchObject({ live: 1, blocked: 1 });
    expect(server.calls.slice(before).map((x) => x.name)).toEqual(['read_note']);

    // --writes stub: the write is answered by the proxy, and still never runs.
    const stub = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' }, replay: { writes: 'stub' } });
    const s = client(target(stub.runId));
    await s.handshake();
    await s.request('tools/list');
    await s.call('read_note', { id: 9 });
    expect(text(await s.call('send_note', { to: 'x' }))).toMatch(/send_note was not executed/);
    await s.close();
    expect(sidecar.endRun(stub.runId, 'completed').summary.byOrigin.stubbed).toBe(1);
    expect(server.calls.filter((x) => x.name === 'send_note')).toHaveLength(1);
  });

  it('honors effect overrides, and is transparent without a sidecar', async () => {
    const c = client(null);
    await c.handshake();
    expect(text(await c.call('send_note', { to: 'y' }))).toBe('send_note:{"to":"y"}:1');
    await c.close();

    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const o = client(target(rec.runId), { effects: { send_note: 'read' } });
    await o.handshake();
    await o.call('send_note', { to: 'z' });
    await o.close();
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getCalls(rec.runId)[0]!.effect).toBe('read');
  });

  it('answers the client with an error when the session has ended or the server is gone', async () => {
    const c = client(null);
    await c.handshake();
    server.forgetSessions();
    const gone = await c.request('tools/list');
    expect((gone.error as { message: string }).message).toMatch(/session has ended.*initialize again/);
    await server.close();
    const down = await c.call('read_note', { id: 1 });
    expect((down.error as { message: string }).message).toMatch(/could not reach the MCP server/);
    await c.close();
    server = await startFakeMcpHttpServer();
  });

  it('checks the headers and the URL it is given', () => {
    expect(parseHeaderFlags(['Authorization: Bearer ${TOKEN}', 'X-Team:  support '], { TOKEN: 'abc' })).toEqual({ authorization: 'Bearer abc', 'x-team': 'support' });
    expect(() => parseHeaderFlags(['Authorization: Bearer ${MISSING}'], {})).toThrow(/\$\{MISSING\} is not set/);
    expect(() => parseHeaderFlags(['Mcp-Session-Id: forged'])).toThrow(/set by the proxy itself/);
    expect(() => parseHeaderFlags(['no colon'])).toThrow(/<name>: <value>/);
    expect(mcpServerUrl('https://mcp.example.com/mcp', true).host).toBe('mcp.example.com');
    expect(mcpServerUrl('http://127.0.0.1:3000/mcp', true).port).toBe('3000');
    expect(mcpServerUrl('http://mcp.internal/mcp', false).host).toBe('mcp.internal');
    expect(() => mcpServerUrl('http://mcp.internal/mcp', true)).toThrow(/use https/);
    expect(() => mcpServerUrl('https://user:pw@mcp.example.com/mcp', false)).toThrow(/credentials/);
    expect(() => mcpServerUrl('ws://x', false)).toThrow(/https/);
  });

  it('runs as shadowlap mcp --url, under the network guard, which leaves its own connection alone', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const child = spawn(process.execPath, [CLI, 'mcp', '--url', server.url, '--header', 'X-Team: ${TEAM}'], {
      env: { ...process.env, ...sidecar.envFor(rec.runId), ...guardEnv('block'), TEAM: 'support', SHADOWLAP_TELEMETRY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const c = rpc(child.stdin, child.stdout);
    await c.handshake();
    expect(text(await c.call('read_note', { id: 1 }))).toBe('read_note:{"id":1}:1');
    child.stdin.end();
    expect(await new Promise((resolve) => child.on('exit', resolve))).toBe(0);
    const ended = sidecar.endRun(rec.runId, 'completed');
    expect(ended.unguarded).toEqual([]);
    expect(stderr).not.toContain('blocked');
    expect(server.seen.find((s) => s.method === 'tools/call')?.team).toBe('support');
    expect(store.getCalls(rec.runId).map((x) => x.name)).toEqual(['read_note']);
  });

  it('refuses a command and a URL together, and a header without a URL', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI, 'mcp', ...args], { env: { ...process.env, SHADOWLAP_TELEMETRY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('exit', (code) => resolve({ code, err }));
      });
    expect(await run(['--url', server.url, '--', 'node', 'server.js'])).toMatchObject({ code: 1, err: expect.stringContaining('not both') });
    expect(await run(['--header', 'X-Team: a', '--', 'node', 'server.js'])).toMatchObject({ code: 1, err: expect.stringContaining('--header is for a server reached with --url') });
    expect(await run([])).toMatchObject({ code: 1, err: expect.stringContaining('give the MCP server') });
  });
});
