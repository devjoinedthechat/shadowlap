import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { mcpServerUrl, parseHeaderFlags, startMcpHttpProxy, type ProxySidecar, type SidecarTarget } from '../src/mcp.js';
import { guardEnv } from '../src/run-agent.js';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from './fake-mcp-http-server.js';

/**
 * `shadowlap mcp --url`: the agent's MCP client talks stdio to the proxy, and the proxy talks
 * Streamable HTTP to a remote server. Tool calls are recorded, replayed and fenced as with a local
 * server; the point to prove is that a remote write never runs again on replay.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const MCP_AGENT = fileURLToPath(new URL('./mcp-client-agent.mjs', import.meta.url));

type Message = Record<string, unknown>;

/** Speaks to anything that reads and writes newline-delimited JSON-RPC, like an MCP client. */
function rpc(input: NodeJS.WritableStream, output: NodeJS.ReadableStream) {
  const waiters = new Map<number, (m: Message) => void>();
  const notifications: Message[] = [];
  const batches: Array<(answers: Message[]) => void> = [];
  let buf = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as Message | Message[];
      if (Array.isArray(m)) batches.shift()?.(m);
      else if (typeof m.id === 'number' && m.method === undefined) waiters.get(m.id)?.(m);
      else notifications.push(m);
    }
  });
  /** Sends several messages as one JSON-RPC batch, and resolves with the batch of answers. */
  const batch = (messages: Message[]): Promise<Message[]> => {
    const p = new Promise<Message[]>((resolve) => batches.push(resolve));
    input.write(JSON.stringify(messages) + '\n');
    return p;
  };
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
  return { request, notify, handshake, notifications, batch, call: (name: string, args: unknown) => request('tools/call', { name, arguments: args }) };
}

const text = (m: Message) => (m.result as { content: Array<{ text: string }> }).content[0].text;

describe('shadowlap mcp --url', () => {
  let store: Store;
  let sidecar: Sidecar;
  let server: FakeMcpHttpServer;
  const target = (runId: string): SidecarTarget => ({ url: sidecar.envFor(runId).SHADOWLAP_URL, runId });

  /** A client in front of a proxy in this process. */
  function client(sidecarTarget: ProxySidecar, opts: { headers?: Record<string, string>; effects?: Record<string, 'pure' | 'read' | 'write'> } = {}) {
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
    expect(calls[0].meta.implHash).toMatch(/^[0-9a-f]{64}$/);
    // Each call names its server by host (never its path, which can hold a key); the first lists the server's tools.
    const host = new URL(server.url).host;
    expect(calls[0].meta.mcp).toEqual({ transport: 'http', server: host, tools: [{ name: 'boom', effect: 'write' }, { name: 'read_note', effect: 'read' }, { name: 'send_note', effect: 'write' }] });
    expect(calls.slice(1).map((x) => x.meta.mcp)).toEqual([{ transport: 'http', server: host }, { transport: 'http', server: host }]);

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
    expect(store.getCalls(rec.runId)[0].effect).toBe('read');
  });

  it('starts a new session when the server ends one, and sends the request again in it', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c = client(target(rec.runId));
    await c.handshake();
    await c.request('tools/list');
    server.forgetSessions();
    // The write that met the ended session runs once, in the new session, and is recorded once.
    expect(text(await c.call('send_note', { to: 'x' }))).toBe('send_note:{"to":"x"}:1');
    expect(((await c.request('tools/list')).result as { tools: unknown[] }).tools).toHaveLength(3);
    // Requests that meet the end of a session together share one new session.
    server.forgetSessions();
    const both = await Promise.all([c.call('read_note', { id: 2 }), c.call('read_note', { id: 3 })]);
    expect(both.map(text).sort()).toEqual(['read_note:{"id":2}:2', 'read_note:{"id":3}:3'].sort());
    await c.close();
    sidecar.endRun(rec.runId, 'completed');
    // Each new session started from the client's own initialize, which never carries a session id.
    const inits = server.seen.filter((x) => x.method === 'initialize');
    expect(inits.map((x) => x.session)).toEqual([null, null, null]);
    expect(server.initParams[1]).toEqual(server.initParams[0]);
    expect(server.seen.filter((x) => x.method === 'tools/call' && x.session !== 'session-1' && x.session !== 'session-2').map((x) => x.session)).toEqual(['session-3', 'session-3']);
    expect(server.calls.map((x) => x.name)).toEqual(['send_note', 'read_note', 'read_note']);
    expect(store.getCalls(rec.runId).map((x) => [x.name, x.end?.outcome])).toEqual([
      ['send_note', 'ok'],
      ['read_note', 'ok'],
      ['read_note', 'ok'],
    ]);
  });

  it('lets the client start a new session itself: its initialize never names the old one', async () => {
    const c = client(null);
    await c.handshake();
    await c.request('tools/list');
    server.forgetSessions();
    // A server built on the MCP SDKs refuses an initialize that names a session it doesn't know.
    const again = await c.handshake();
    expect(again.error).toBeUndefined();
    expect(((await c.request('tools/list')).result as { tools: unknown[] }).tools).toHaveLength(3);
    await c.close();
    expect(server.seen.filter((x) => x.method === 'tools/list').map((x) => x.session)).toEqual(['session-1', 'session-2']);
  });

  it('records a call that fails at the HTTP level or finds the server gone, so a replay serves the same failure', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c = client(target(rec.runId));
    await c.handshake();
    await c.request('tools/list');
    const flaky = await c.call('flaky', {});
    expect((flaky.error as { message: string }).message).toMatch(/answered 500: upstream exploded/);
    await server.close();
    const down = await c.call('read_note', { id: 1 });
    expect((down.error as { message: string }).message).toMatch(/could not reach the MCP server/);
    await c.close();
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getCalls(rec.runId).map((x) => [x.name, x.end?.outcome])).toEqual([
      ['flaky', 'error'],
      ['read_note', 'error'],
    ]);

    server = await startFakeMcpHttpServer();
    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    const r = client(target(rep.runId));
    await r.handshake();
    await r.request('tools/list');
    expect(((await r.call('flaky', {})).error as { message: string }).message).toMatch(/answered 500: upstream exploded/);
    expect(((await r.call('read_note', { id: 1 })).error as { message: string }).message).toMatch(/could not reach the MCP server/);
    await r.close();
    const replayed = sidecar.endRun(rep.runId, 'completed');
    expect(replayed.summary.divergence).toBeNull();
    expect(replayed.summary.byOrigin.replayed).toBe(2);
    expect(server.calls).toEqual([]);
  });

  it('says when the server breaks its answer off, and never reads part of one as the whole', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c = client(target(rec.runId));
    await c.handshake();
    await c.request('tools/list');
    const cut = await c.call('cut', {});
    expect((cut.error as { message: string }).message).toMatch(/^the MCP server's answer was cut short: /);
    await c.close();
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getCalls(rec.runId).map((x) => [x.name, x.end?.outcome])).toEqual([['cut', 'error']]);
  });

  it('refuses a batch that carries tools/call, which it could neither record nor fence', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c = client(target(rec.runId));
    await c.handshake();
    await c.request('tools/list');
    const answers = await c.batch([
      { jsonrpc: '2.0', id: 'b1', method: 'tools/call', params: { name: 'send_note', arguments: { to: 'x' } } },
      { jsonrpc: '2.0', id: 'b2', method: 'tools/list' },
      { jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 1, progress: 1 } },
    ]);
    expect(answers.map((a) => [a.id, (a.error as { code: number }).code])).toEqual([
      ['b1', -32600],
      ['b2', -32600],
    ]);
    expect((answers[0].error as { message: string }).message).toMatch(/send each tools\/call on its own/);
    await c.close();
    sidecar.endRun(rec.runId, 'completed');
    expect(server.calls).toEqual([]);
    // The notification in it still reached the server, on its own.
    expect(server.seen.filter((x) => x.method === 'notifications/progress')).toHaveLength(1);

    // Without Shadowlap the proxy passes a batch on as it is.
    const t = client(null);
    await t.handshake();
    const passed = await t.batch([{ jsonrpc: '2.0', id: 'b3', method: 'tools/call', params: { name: 'send_note', arguments: { to: 'y' } } }]);
    expect(passed[0].result).toBeDefined();
    await t.close();
    expect(server.calls.map((x) => x.name)).toEqual(['send_note']);
  });

  it('refuses writes and passes reads unrecorded when it should record but can\'t', async () => {
    const c = client({ unusable: 'no run is registered for it' });
    await c.handshake();
    await c.request('tools/list');
    expect(text(await c.call('read_note', { id: 1 }))).toBe('read_note:{"id":1}:1');
    const refused = await c.call('send_note', { to: 'x' });
    expect((refused.result as { isError: boolean }).isError).toBe(true);
    expect(text(refused)).toMatch(/send_note was not sent.*no run is registered for it/);
    await c.close();
    expect(server.calls.map((x) => x.name)).toEqual(['read_note']);

    // A sidecar that can't be asked: the same.
    const d = client({ url: 'http://127.0.0.1:9/t/gone', runId: 'r' });
    await d.handshake();
    await d.request('tools/list');
    expect(text(await d.call('send_note', { to: 'x' }))).toMatch(/send_note was not sent.*could not be asked/);
    expect(text(await d.call('read_note', { id: 2 }))).toBe('read_note:{"id":2}:2');
    await d.close();
    expect(server.calls.map((x) => x.name)).toEqual(['read_note', 'read_note']);
  });

  it('is not held up by a server that keeps a stream open after answering', async () => {
    server.keepStreamsOpen();
    const c = client(null);
    await c.handshake();
    expect(((await c.request('tools/list')).result as { tools: unknown[] }).tools).toHaveLength(3);
    expect(text(await c.call('read_note', { id: 1 }))).toBe('read_note:{"id":1}:1');
    const exited = await Promise.race([c.close(), new Promise((resolve) => setTimeout(() => resolve('still running'), 3000))]);
    expect(exited).toBe(0);
  });

  it('checks the headers and the URL it is given', () => {
    expect(parseHeaderFlags(['Authorization: Bearer ${TOKEN}', 'X-Team:  support '], { TOKEN: 'abc' })).toEqual({ authorization: 'Bearer abc', 'x-team': 'support' });
    expect(() => parseHeaderFlags(['Authorization: Bearer ${MISSING}'], {})).toThrow(/\$\{MISSING\} is not set/);
    // $NAME too, for a client that fills in ${…} itself before it starts the proxy; $$ is a $ itself.
    expect(parseHeaderFlags(['Authorization: Bearer $TOKEN', 'X-Price: $$5 and $$TOKEN'], { TOKEN: 'abc' })).toEqual({ authorization: 'Bearer abc', 'x-price': '$5 and $TOKEN' });
    expect(() => parseHeaderFlags(['Authorization: Bearer $MISSING'], {})).toThrow(/\$MISSING is not set in the environment \(a \$ itself is written \$\$\)/);
    // A $ before anything that can't start a name stays as it is.
    expect(parseHeaderFlags(['X-Cost: $5 or $ 6'], {})).toEqual({ 'x-cost': '$5 or $ 6' });
    expect(() => parseHeaderFlags(['Mcp-Session-Id: forged'])).toThrow(/set by the proxy itself/);
    expect(() => parseHeaderFlags(['no colon'])).toThrow(/<name>: <value>/);
    expect(() => parseHeaderFlags(['X-Team: a\r\nX-Evil: 1'])).toThrow(/can't carry/);
    expect(() => parseHeaderFlags(['X-Team: ${V}'], { V: 'a\nb' })).toThrow(/can't carry/);
    expect(mcpServerUrl('https://mcp.example.com/mcp', true).host).toBe('mcp.example.com');
    expect(mcpServerUrl('http://127.0.0.1:3000/mcp', true).port).toBe('3000');
    expect(mcpServerUrl('http://mcp.internal/mcp', false).host).toBe('mcp.internal');
    expect(() => mcpServerUrl('http://mcp.internal/mcp', true)).toThrow(/use https.*--allow-http/);
    expect(mcpServerUrl('http://mcp.internal/mcp', true, true).host).toBe('mcp.internal');
    expect(mcpServerUrl('http://127.0.0.2:8080/mcp', true).host).toBe('127.0.0.2:8080');
    expect(mcpServerUrl('http://[::1]:8080/mcp', true).port).toBe('8080');
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

  it('says at the start when the sidecar it was given does not answer, and refuses writes', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp', '--url', server.url], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SHADOWLAP_URL: 'http://127.0.0.1:9/t/left-over', SHADOWLAP_RUN_ID: 'r', SHADOWLAP_TELEMETRY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const c = rpc(child.stdin, child.stdout);
    await c.handshake();
    await c.request('tools/list');
    expect(text(await c.call('send_note', { to: 'x' }))).toMatch(/send_note was not sent/);
    child.stdin.end();
    await new Promise((resolve) => child.on('exit', resolve));
    expect(stderr).toContain('does not answer, so write tools will be refused');
    expect(server.calls).toEqual([]);
  });

  it('gives only its own process the hook that allows a host past the guard', async () => {
    const probe = "console.log(typeof globalThis[Symbol.for('shadowlap.guard.allow')])";
    const seen = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', probe], { env: { ...process.env, ...sidecar.envFor('r'), ...guardEnv('block') }, stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', () => resolve(out.trim()));
    });
    expect(seen).toBe('undefined');
  });

  it('refuses a command and a URL together, and a header without a URL', async () => {
    const run = (args: string[]) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const child = spawn(process.execPath, [CLI, 'mcp', ...args], { env: { ...process.env, SHADOWLAP_TELEMETRY: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('exit', (code) => resolve({ code, err }));
      });
    expect(await run(['--url', server.url, '--', 'node', 'server.js'])).toMatchObject({ code: 2, err: expect.stringContaining('not both') });
    expect(await run(['--header', 'X-Team: a', '--', 'node', 'server.js'])).toMatchObject({ code: 2, err: expect.stringContaining('--header is for a server reached with --url') });
    expect(await run(['--allow-http', '--', 'node', 'server.js'])).toMatchObject({ code: 2, err: expect.stringContaining('--allow-http is for a server reached with --url') });
    expect(await run([])).toMatchObject({ code: 2, err: expect.stringContaining('give the MCP server') });
  });
});

/**
 * The MCP SDKs' stdio clients start a server with a minimal environment, so the proxy never gets
 * SHADOWLAP_URL. Under `test`, `replay --repeat` and the rest, it finds its run through the agent
 * Shadowlap started, and a remote write still never runs again.
 */
describe('shadowlap mcp started with a minimal environment', () => {
  let server: FakeMcpHttpServer;
  let home: string;
  let cwd: string;

  function shadowlap(args: string[], o: { home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      // The home folder is HOME, and on Windows USERPROFILE, which is where Node looks for it there. With
      // no SHADOWLAP_HOME, which the proxy's minimal environment never has, agents are registered in its .shadowlap.
      const homeEnv = { HOME: o.home ?? home, USERPROFILE: o.home ?? home, SHADOWLAP_HOME: undefined };
      const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], { cwd, env: { ...process.env, ...homeEnv, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', ...o.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (out += d.toString()));
      child.on('exit', (code) => resolve({ code, out }));
    });
  }

  beforeAll(async () => {
    server = await startFakeMcpHttpServer();
    home = realpathSync(mkdtempSync(join(tmpdir(), 'sl-mcp-home-')));
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-mcp-project-')));
  });
  afterAll(async () => {
    await server.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  it('records through the agent that started it, and never sends the write again on replay --repeat, a fork or test', async () => {
    const rec = await shadowlap(['run', '--', process.execPath, MCP_AGENT, CLI, server.url]);
    expect(rec.code, rec.out).toBe(0);
    expect(rec.out).toContain('send_note -> send_note:{"to":"billing"}:2');
    expect(server.calls.map((x) => x.name)).toEqual(['read_note', 'send_note']);
    const runId = /recording run (\w{26})/.exec(rec.out)![1];
    const store = Store.open(join(cwd, 'store.db'));
    expect(store.getCalls(runId).map((x) => [x.name, x.effect, x.end?.outcome])).toEqual([
      ['read_note', 'read', 'ok'],
      ['send_note', 'write', 'ok'],
    ]);
    store.close();

    const repeat = await shadowlap(['replay', runId, '--repeat', '2']);
    expect(repeat.code, repeat.out).toBe(0);
    expect(repeat.out.match(/send_note -> send_note:\{"to":"billing"\}:2/g)).toHaveLength(2);
    expect(server.calls).toHaveLength(2);

    // A fork at the read: it runs live, and the write after it is refused before it leaves.
    const fork = await shadowlap(['replay', runId, '--diverge-at', '1']);
    expect(fork.out).toContain('send_note -> refused:');
    expect(server.calls.map((x) => x.name)).toEqual(['read_note', 'send_note', 'read_note']);

    expect((await shadowlap(['pack', runId, 'goldens/notes'])).code).toBe(0);
    const test = await shadowlap(['test', 'goldens/notes']);
    expect(test.out, test.out).toMatch(/1 passed/);
    expect(server.calls).toHaveLength(3);

    // Each agent's registration went when the agent did.
    expect(readdirSync(join(home, '.shadowlap', 'agents'))).toEqual([]);
    expect(existsSync(join(cwd, '.shadowlap', 'agents'))).toBe(false);
    // Five proxies, each reading the process tree: on Windows that takes PowerShell, a second or two each.
  }, 120_000);

  it('refuses the write when it was started under Shadowlap but can\'t find its run', async () => {
    // The client hands the proxy another home folder, where no agent is registered.
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'sl-mcp-elsewhere-')));
    const before = server.calls.length;
    const rec = await shadowlap(['run', '--', process.execPath, MCP_AGENT, CLI, server.url, elsewhere]);
    rmSync(elsewhere, { recursive: true, force: true });
    expect(rec.out).toContain('read_note -> read_note:{"id":1}');
    expect(rec.out).toMatch(/send_note -> refused: shadowlap: send_note was not sent/);
    expect(rec.out).toContain('no run is registered for it');
    expect(server.calls.slice(before).map((x) => x.name)).toEqual(['read_note']);
  }, 60_000);

  it("refuses the write under every command that runs the agent, injection's among them, when it can't find its run", async () => {
    // Recorded where its proxy finds its run; then tested for injection, each attempt's proxy handed another home folder.
    const rec = await shadowlap(['run', '--', process.execPath, MCP_AGENT, CLI, server.url]);
    expect(rec.code, rec.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(rec.out)![1];
    const store = Store.open(join(cwd, 'store.db'));
    const read = store.getCalls(runId).find((x) => x.name === 'read_note')!.callNo;
    store.close();
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'sl-mcp-elsewhere-')));
    const before = server.calls.length;
    const neutral = JSON.stringify({ content: [{ type: 'text', text: '' }] });
    const tested = await shadowlap(['injection', runId, '--clean', `${read}=${neutral}`, '--guard', 'off', '--json'], { env: { MCP_AGENT_PROXY_HOME: elsewhere } });
    rmSync(elsewhere, { recursive: true, force: true });
    // Every attempt ran the agent: its reads went through unrecorded, and its write never left.
    expect(server.calls.slice(before).filter((x) => x.name === 'read_note').length, tested.out).toBeGreaterThan(0);
    expect(server.calls.slice(before).map((x) => x.name), tested.out).not.toContain('send_note');
  }, 90_000);
});
