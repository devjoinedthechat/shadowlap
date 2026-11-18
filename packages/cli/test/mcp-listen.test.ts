import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { listenAddress, runMcp, startMcpListener, type McpListener, type ProxySidecar, type SidecarTarget } from '../src/mcp.js';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from './fake-mcp-http-server.js';

/**
 * `shadowlap mcp --url <server> --listen <address>`: the remote server, served over Streamable HTTP
 * to an agent whose MCP client speaks HTTP. Tool calls are recorded, replayed and fenced as in the
 * stdio modes; the client keeps the server's own session, its GET stream and its event streams.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

type Message = Record<string, unknown>;

/** The events of an event stream's text, each event's data parsed. */
function events(text: string): Array<{ id?: string; data: Message }> {
  return text
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      const id = lines.find((l) => l.startsWith('id:'))?.slice(3).trim();
      return data ? { ...(id ? { id } : {}), data: JSON.parse(data) as Message } : null;
    })
    .filter((e): e is { id?: string; data: Message } => e !== null);
}

/** An MCP client over Streamable HTTP, as the transport asks: POSTs that accept JSON or an event stream, in the session the server names. */
function httpClient(endpoint: string) {
  let session: string | null = null;
  let version: string | null = null;
  let id = 0;
  const headers = (): Record<string, string> => ({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}), ...(version ? { 'mcp-protocol-version': version } : {}) });
  /** A request's answer, and every message that came before it on its stream. */
  const request = async (method: string, params?: unknown): Promise<{ answer: Message; before: Message[]; status: number; ids: string[] }> => {
    const res = await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params !== undefined ? { params } : {}) }) });
    const sid = res.headers.get('mcp-session-id');
    if (sid) session = sid;
    const text = await res.text();
    if ((res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
      const all = events(text);
      return { answer: all.at(-1)!.data, before: all.slice(0, -1).map((e) => e.data), status: res.status, ids: all.flatMap((e) => (e.id ? [e.id] : [])) };
    }
    return { answer: JSON.parse(text) as Message, before: [], status: res.status, ids: [] };
  };
  return {
    request,
    async handshake() {
      const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-client', version: '1' } });
      version = (init.answer.result as { protocolVersion: string }).protocolVersion;
      const sent = await fetch(endpoint, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
      expect(sent.status).toBe(202);
      return init;
    },
    call: (name: string, args: unknown) => request('tools/call', { name, arguments: args }),
    /** Opens the server's own stream, and resolves with its first message. */
    async firstStreamed(): Promise<{ status: number; message: Message; close: () => void }> {
      const abort = new AbortController();
      const res = await fetch(endpoint, { method: 'GET', headers: { accept: 'text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, signal: abort.signal });
      const reader = res.body!.getReader();
      let text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        const got = events(text);
        if (got.length) return { status: res.status, message: got[0].data, close: () => abort.abort() };
      }
      throw new Error('the stream ended');
    },
    end: () => fetch(endpoint, { method: 'DELETE', headers: headers() }),
    get session() {
      return session;
    },
  };
}

const text = (m: Message) => (m.result as { content: Array<{ text: string }> }).content[0].text;

describe('shadowlap mcp --listen', () => {
  let store: Store;
  let sidecar: Sidecar;
  let server: FakeMcpHttpServer;
  let listener: McpListener;
  /** The run the next session records into: a long-running proxy asks when each session starts. */
  let current: ProxySidecar = null;
  const target = (runId: string): SidecarTarget => ({ url: sidecar.envFor(runId).SHADOWLAP_URL, runId });

  beforeAll(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
  });
  beforeEach(async () => {
    server = await startFakeMcpHttpServer({ streams: true });
    listener = await startMcpListener({ host: '127.0.0.1', port: 0, url: server.url, headers: { authorization: 'Bearer t0ken' }, sidecar: () => current, log: () => {} });
  });
  afterEach(async () => {
    await listener.close();
    await server.close();
  });
  afterAll(async () => {
    await sidecar.close();
    store.close();
  });

  it('records tool calls over HTTP in the server\'s own session, streams included, and replays them without the server', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    current = target(rec.runId);
    const c = httpClient(listener.url);
    const init = await c.handshake();
    expect((init.answer.result as { serverInfo: { name: string } }).serverInfo.name).toBe('fake-http');
    // The client keeps the server's own session id.
    expect(c.session).toBe('session-1');
    // The server's standalone stream reaches the client through the proxy.
    const stream = c.firstStreamed();
    await server.notify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    const streamed = await stream;
    expect(streamed).toMatchObject({ status: 200, message: { method: 'notifications/tools/list_changed' } });
    streamed.close();
    const listed = await c.request('tools/list');
    expect((listed.answer.result as { tools: unknown[] }).tools).toHaveLength(3);
    expect(listed.before).toContainEqual({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'listing tools' } });
    // An answer on an event stream comes through as the server sent it: the progress first, the event ids kept.
    const read = await c.call('read_note', { id: 7 });
    expect(text(read.answer)).toBe('read_note:{"id":7}:1');
    expect(read.before).toEqual([{ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: 3, progress: 1, total: 2 } }]);
    expect(read.ids).toHaveLength(2);
    expect(text((await c.call('send_note', { to: 'x' })).answer)).toBe('send_note:{"to":"x"}:2');
    expect((await c.end()).status).toBe(200);
    sidecar.endRun(rec.runId, 'completed');

    const calls = store.getCalls(rec.runId);
    expect(calls.map((x) => [x.name, x.effect, x.end?.outcome])).toEqual([
      ['read_note', 'read', 'ok'],
      ['send_note', 'write', 'ok'],
    ]);
    expect(calls[0].meta.mcp).toMatchObject({ transport: 'http', server: new URL(server.url).host });
    // Every request reached the server in its session with the proxy's header; the client's own DELETE ended it.
    expect(server.seen.filter((s) => s.http === 'POST' && s.method !== 'initialize').every((s) => s.session === 'session-1' && s.authorization === 'Bearer t0ken')).toBe(true);
    expect(server.seen.at(-1)).toMatchObject({ http: 'DELETE', session: 'session-1' });

    // Replay: the recording answers both calls; the server never sees one.
    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    current = target(rep.runId);
    const before = server.calls.length;
    const r = httpClient(listener.url);
    await r.handshake();
    await r.request('tools/list');
    expect(text((await r.call('read_note', { id: 7 })).answer)).toBe('read_note:{"id":7}:1');
    expect(text((await r.call('send_note', { to: 'x' })).answer)).toBe('send_note:{"to":"x"}:2');
    await r.end();
    const replayed = sidecar.endRun(rep.runId, 'completed');
    expect(replayed.summary.divergence).toBeNull();
    expect(replayed.summary.byOrigin.replayed).toBe(2);
    expect(server.calls.length).toBe(before);

    // Fork: the changed read runs live; the write after it is refused and never reaches the server.
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    current = target(fork.runId);
    const f = httpClient(listener.url);
    await f.handshake();
    await f.request('tools/list');
    expect(text((await f.call('read_note', { id: 8 })).answer)).toMatch(/^read_note:\{"id":8\}:\d+$/);
    const blocked = await f.call('send_note', { to: 'x' });
    expect((blocked.answer.result as { isError: boolean }).isError).toBe(true);
    sidecar.endRun(fork.runId, 'completed');
    expect(server.calls.slice(before).map((x) => x.name)).toEqual(['read_note']);
    current = null;
  });

  it('passes everything through for a session that starts with no run', async () => {
    current = null;
    const c = httpClient(listener.url);
    await c.handshake();
    expect(text((await c.call('send_note', { to: 'y' })).answer)).toBe('send_note:{"to":"y"}:1');
    expect(server.calls.map((x) => x.name)).toEqual(['send_note']);
  });

  it('records a call the server answers with an HTTP error, and a replay answers with it as recorded', async () => {
    /** What the client got for a call: the status, the headers that say what it is, and the body. */
    const answer = async (session: string, name: string) => {
      const res = await fetch(listener.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: {} } }) });
      return { status: res.status, type: res.headers.get('content-type'), retry: res.headers.get('retry-after'), session: res.headers.get('mcp-session-id'), body: await res.text() };
    };
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    current = target(rec.runId);
    const c = httpClient(listener.url);
    await c.handshake();
    // The server's own error, and the proxy's when the server closed the connection without an answer.
    const failed = await answer(c.session!, 'flaky');
    expect(failed).toEqual({ status: 500, type: 'text/plain', retry: '7', session: null, body: 'upstream exploded' });
    const dropped = await answer(c.session!, 'drop');
    expect(dropped).toMatchObject({ status: 502, type: 'application/json' });
    expect(JSON.parse(dropped.body)).toMatchObject({ jsonrpc: '2.0', id: 9, error: { code: -32000, message: expect.stringMatching(/^could not reach the MCP server at 127\.0\.0\.1:\d+: /) as unknown } });
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getCalls(rec.runId).map((x) => [x.name, x.end?.outcome])).toEqual([
      ['flaky', 'error'],
      ['drop', 'error'],
    ]);

    // Replayed: each answer as the client got it, status and all, without the server.
    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    current = target(rep.runId);
    const r = httpClient(listener.url);
    await r.handshake();
    const seen = server.seen.length;
    expect(await answer(r.session!, 'flaky')).toEqual(failed);
    expect(await answer(r.session!, 'drop')).toEqual(dropped);
    const replayed = sidecar.endRun(rep.runId, 'completed');
    expect([replayed.summary.divergence, replayed.summary.byOrigin.replayed]).toEqual([null, 2]);
    expect(server.seen.slice(seen)).toEqual([]);
    current = null;
  });

  it('breaks the client\'s answer off when the server breaks its own off, and records the call as it ended', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    current = target(rec.runId);
    const c = httpClient(listener.url);
    await c.handshake();
    const asked = fetch(listener.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': c.session! }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'cut', arguments: {} } }) });
    // Part of an answer is never passed on as the whole: the client's response breaks off too.
    expect(await asked.then((r) => r.text()).then(() => 'whole', () => 'broken off')).toBe('broken off');
    sidecar.endRun(rec.runId, 'completed');
    const [call] = store.getCalls(rec.runId);
    expect([call.name, call.end?.outcome]).toEqual(['cut', 'error']);

    // Replayed, the client's response breaks off as it did live, never answered with an error in its place.
    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    current = target(rep.runId);
    const r = httpClient(listener.url);
    await r.handshake();
    const before = server.calls.length;
    const again = fetch(listener.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': r.session! }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'cut', arguments: {} } }) });
    expect(await again.then((res) => res.text()).then((t) => `answered: ${t}`, () => 'broken off')).toBe('broken off');
    const replayed = sidecar.endRun(rep.runId, 'completed');
    expect([replayed.summary.divergence, replayed.summary.byOrigin.replayed]).toEqual([null, 1]);
    expect(server.calls.length).toBe(before);
    current = null;
  });

  it('serves its own address only: another Host or a web page\'s Origin is refused', async () => {
    const port = new URL(listener.url).port;
    const asHost = await new Promise<number>((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host: 'evil.example:80', 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end('{}');
    });
    expect(asHost).toBe(403);
    expect((await fetch(listener.url, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await fetch(listener.url.replace('/mcp', '/other'), { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(listener.url, { method: 'PUT', body: '{}' })).status).toBe(405);
    expect(server.seen).toEqual([]);
  });

  it('takes a loopback address only, and needs --url', async () => {
    expect(listenAddress('8931')).toEqual({ host: '127.0.0.1', port: 8931 });
    expect(listenAddress('localhost:0')).toEqual({ host: 'localhost', port: 0 });
    expect(listenAddress('[::1]:8931')).toEqual({ host: '::1', port: 8931 });
    expect(() => listenAddress('0.0.0.0:8931')).toThrow(/not this machine/);
    expect(() => listenAddress('192.168.1.4:8931')).toThrow(/not this machine/);
    expect(() => listenAddress('127.0.0.1:99999')).toThrow(/--listen expects/);
    await expect(runMcp(['npx', 'server'], { header: [], effect: [], listen: '8931' }, undefined, new Set())).rejects.toThrow(/--listen serves a remote server over HTTP: give it with --url/);
  });
});

describe('shadowlap mcp --listen, as a command', () => {
  it('says where it serves, refuses the writes of a session with no run, and stops on a signal', async () => {
    const server = await startFakeMcpHttpServer({ streams: true });
    const project = mkdtempSync(join(tmpdir(), 'shadowlap-listen-'));
    // A proxy started on its own registers in the home folder (HOME, and on Windows USERPROFILE), with no SHADOWLAP_HOME: the test's own, never the user's or another test's.
    const child = spawn(process.execPath, [CLI, 'mcp', '--url', server.url, '--listen', '127.0.0.1:0'], { cwd: project, env: { ...process.env, HOME: project, USERPROFILE: project, SHADOWLAP_HOME: undefined, SHADOWLAP_URL: '', SHADOWLAP_RUN_ID: '', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const endpoint = await new Promise<string>((resolve, reject) => {
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString();
        const m = /serving \S+ at (http:\/\/127\.0\.0\.1:\d+\/mcp)/.exec(err);
        if (m) resolve(m[1]);
      });
      child.once('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
    });
    expect(err).toMatch(/started on its own: each session records into the run of the shadowlap command its client belongs to, and refuses writes when it has none/);
    const c = httpClient(endpoint);
    await c.handshake();
    await c.request('tools/list');
    // This test's process is no agent a shadowlap command started: reads pass through unrecorded, a write is refused.
    expect(text((await c.call('read_note', { id: 1 })).answer)).toBe('read_note:{"id":1}:1');
    const sent = (await c.call('send_note', { to: 'y' })).answer;
    expect(text(sent)).toMatch(/^shadowlap: send_note was not sent\. It is a write, and it can't be recorded: no shadowlap run is active for it\./);
    expect(server.calls.map((x) => x.name)).toEqual(['read_note']);
    expect(err).toMatch(/a session started that can't be recorded \(no shadowlap run is active for it\): write tools are refused, read tools pass through unrecorded/);
    const code = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    // A signal is POSIX's: on Windows, kill ends a process at once (TerminateProcess), with no code of its own.
    expect(await code).toBe(process.platform === 'win32' ? null : 143);
    await server.close();
  });
});
