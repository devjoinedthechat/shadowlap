import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { discoverSidecar, effectFromAnnotations, parseEffectFlags, startMcpProxy, stdioServerName, type SidecarTarget } from '../src/mcp.js';

const serverScript = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

/** Drives a proxy like an MCP client: sends requests, collects responses by id. */
function client(sidecar: SidecarTarget | null, effects?: Record<string, 'pure' | 'read' | 'write'>) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const responses = new Map<number, Record<string, unknown>>();
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  const batches: Array<(answers: Array<Record<string, unknown>>) => void> = [];
  let buf = '';
  clientOut.setEncoding('utf8');
  clientOut.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as Record<string, unknown> | Array<Record<string, unknown>>;
      if (Array.isArray(m)) {
        batches.shift()?.(m);
        continue;
      }
      responses.set(m.id as number, m);
      waiters.get(m.id as number)?.(m);
    }
  });
  const proxy = startMcpProxy({ clientIn, clientOut, server: { command: process.execPath, args: [serverScript] }, sidecar, ...(effects ? { effects } : {}) });
  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const p = new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve));
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n');
    return p;
  };
  const call = async (name: string, args: unknown) => request('tools/call', { name, arguments: args });
  const batch = (messages: unknown[]): Promise<Array<Record<string, unknown>>> => {
    const p = new Promise<Array<Record<string, unknown>>>((resolve) => batches.push(resolve));
    clientIn.write(JSON.stringify(messages) + '\n');
    return p;
  };
  const close = async () => {
    clientIn.end();
    await proxy.done;
  };
  return { request, call, batch, close };
}

const text = (m: Record<string, unknown>) => ((m.result as { content: Array<{ text: string }> }).content[0]!.text);

describe('shadowlap mcp: finding the sidecar safely', () => {
  // A cloned repository can commit .shadowlap/active.json; it must not be able to redirect tool data.
  const write = (content: unknown) => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-mcp-active-'));
    mkdirSync(join(dir, '.shadowlap'));
    writeFileSync(join(dir, '.shadowlap', 'active.json'), JSON.stringify(content));
    return dir;
  };
  it('trusts the file only for loopback, a live process and a regular file', () => {
    const reasons: string[] = [];
    const skip = (r: string) => reasons.push(r);
    expect(discoverSidecar({}, write({ url: 'http://127.0.0.1:4000/t/x', runId: 'r', pid: process.pid }), skip)).toEqual({ url: 'http://127.0.0.1:4000/t/x', runId: 'r' });
    expect(discoverSidecar({}, write({ url: 'https://attacker.example/collect', runId: 'r', pid: process.pid }), skip)).toBeNull();
    expect(discoverSidecar({}, write({ url: 'http://127.0.0.1:4000/t/x', runId: 'r', pid: 2 ** 22 - 3 }), skip)).toBeNull();
    expect(discoverSidecar({}, write({ url: 'http://127.0.0.1:4000/t/x', runId: 'r' }), skip)).toBeNull();
    expect(reasons.join('\n')).toMatch(/not loopback[\s\S]*has ended[\s\S]*incomplete/);
    if (process.platform !== 'win32') {
      const dir = mkdtempSync(join(tmpdir(), 'fp-mcp-link-'));
      mkdirSync(join(dir, '.shadowlap'));
      const target = join(dir, 'elsewhere.json');
      writeFileSync(target, JSON.stringify({ url: 'http://127.0.0.1:4000/t/x', runId: 'r', pid: process.pid }));
      symlinkSync(target, join(dir, '.shadowlap', 'active.json'));
      expect(discoverSidecar({}, dir, skip)).toBeNull();
    }
  });
});

describe('shadowlap mcp', () => {
  let store: Store;
  let sidecar: Sidecar;
  const target = (runId: string): SidecarTarget => ({ url: sidecar.envFor(runId).SHADOWLAP_URL!, runId });
  beforeAll(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
  });
  afterAll(async () => {
    await sidecar.close();
    store.close();
  });

  it('records tools/call with effects from annotations, replays them, and fences writes after a fork', async () => {
    // Record: both calls reach the server (counter 1, 2).
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c1 = client(target(rec.runId));
    expect(((await c1.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })).result as { serverInfo: { name: string } }).serverInfo.name).toBe('fake');
    await c1.request('tools/list');
    expect(text(await c1.call('read_note', { id: 7 }))).toBe('read_note:{"id":7}:1');
    expect(text(await c1.call('send_note', { to: 'x' }))).toBe('send_note:{"to":"x"}:2');
    const err = await c1.call('boom', {});
    expect((err.error as { message: string }).message).toBe('boom failed');
    await c1.close();
    const recorded = sidecar.endRun(rec.runId, 'completed');
    expect(recorded.summary.byOrigin.live).toBe(3);
    const calls = store.getCalls(rec.runId);
    expect(calls.map((c) => [c.name, c.effect, c.end?.outcome])).toEqual([
      ['read_note', 'read', 'ok'],
      ['send_note', 'write', 'ok'],
      ['boom', 'write', 'error'],
    ]);
    expect(calls[0]!.meta.implHash).toMatch(/^[0-9a-f]{64}$/); // the tool's input schema
    // A local server is named by its command, never by its arguments.
    expect(calls.map((c) => c.meta.mcp?.server)).toEqual(['node', 'node', 'node']);
    expect(calls[0]!.meta.mcp?.tools).toEqual([{ name: 'read_note', effect: 'read' }, { name: 'send_note', effect: 'write' }]);

    // Replay: the server is a fresh process (counter would restart at 1) but the client gets the recorded results.
    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    const c2 = client(target(rep.runId));
    await c2.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await c2.request('tools/list');
    expect(text(await c2.call('read_note', { id: 7 }))).toBe('read_note:{"id":7}:1');
    expect(text(await c2.call('send_note', { to: 'x' }))).toBe('send_note:{"to":"x"}:2');
    const rerr = await c2.call('boom', {});
    expect(rerr.error).toEqual({ code: -32001, message: 'boom failed', data: { n: 3 } });
    await c2.close();
    const replayed = sidecar.endRun(rep.runId, 'completed');
    expect(replayed.summary.divergence).toBeNull();
    expect(replayed.summary.byOrigin.replayed).toBe(3);

    // Fork: a changed read diverges; the write after it is refused as a tool error the model can see.
    const fork = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    const c3 = client(target(fork.runId));
    await c3.request('tools/list');
    expect(text(await c3.call('read_note', { id: 8 }))).toBe('read_note:{"id":8}:1'); // live, fresh server
    const blocked = await c3.call('send_note', { to: 'x' });
    expect((blocked.result as { isError: boolean }).isError).toBe(true);
    expect(text(blocked)).toMatch(/send_note/);
    await c3.close();
    const forked = sidecar.endRun(fork.runId, 'completed');
    expect(forked.summary.divergence?.callNo).toBe(1);
    expect(forked.summary.byOrigin).toMatchObject({ live: 1, blocked: 1 });
  });

  it('is transparent without a sidecar and honors effect overrides', async () => {
    const c = client(null);
    expect(text(await c.call('send_note', { to: 'y' }))).toBe('send_note:{"to":"y"}:1');
    await c.close();

    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c2 = client(target(rec.runId), { send_note: 'read' });
    await c2.call('send_note', { to: 'z' });
    await c2.close();
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getCalls(rec.runId)[0]!.effect).toBe('read');
  });

  it('refuses a batch that carries tools/call, and records a call the server never answered', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c = client(target(rec.runId));
    await c.request('tools/list');
    const answers = await c.batch([{ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'send_note', arguments: { to: 'x' } } }]);
    expect(answers).toEqual([{ jsonrpc: '2.0', id: 90, error: { code: -32600, message: expect.stringContaining('batch') } }]);
    // The server never ran it: its first tool call is still to come.
    expect(text(await c.call('read_note', { id: 1 }))).toBe('read_note:{"id":1}:1');
    await c.close();
    sidecar.endRun(rec.runId, 'completed');
    expect(store.getCalls(rec.runId).map((x) => x.name)).toEqual(['read_note']);
  });

  it('names a local server by its command, and the package a runner starts', () => {
    expect(stdioServerName('npx', ['-y', '@modelcontextprotocol/server-filesystem', '/srv/notes'])).toBe('npx @modelcontextprotocol/server-filesystem');
    expect(stdioServerName('/usr/local/bin/uvx', ['mcp-server-fetch'])).toBe('uvx mcp-server-fetch');
    // A flag that may take a value comes first: the argument after it could be anything, a token included.
    expect(stdioServerName('npx', ['--registry', 'https://npm.example', 'server'])).toBe('npx');
    expect(stdioServerName('docker', ['run', '-i', '-e', 'TOKEN=secret', 'mcp/github'])).toBe('docker');
    expect(stdioServerName('C:\\tools\\python.exe', ['server.py', '--key', 'k'])).toBe('python');
  });

  it('parses flags, annotations and the active-run file', () => {
    expect(parseEffectFlags(['a=read', 'b=write'])).toEqual({ a: 'read', b: 'write' });
    expect(() => parseEffectFlags(['a=maybe'])).toThrow(/pure\|read\|write/);
    expect(effectFromAnnotations({ readOnlyHint: true })).toBe('read');
    expect(effectFromAnnotations({ destructiveHint: false })).toBe('write');
    expect(effectFromAnnotations(undefined)).toBe('write');
    expect(discoverSidecar({ SHADOWLAP_URL: 'http://127.0.0.1:1/t/', SHADOWLAP_RUN_ID: 'r' }, '/nonexistent')).toEqual({ url: 'http://127.0.0.1:1/t', runId: 'r' });
    expect(discoverSidecar({}, '/nonexistent')).toBeNull();
    expect(discoverSidecar({ SHADOWLAP_URL: 'https://collector.example/t', SHADOWLAP_RUN_ID: 'r' }, '/nonexistent')).toBeNull();
    // Where the process tree is known, the active run's file counts only for a run this process descends from.
    const dir = mkdtempSync(join(tmpdir(), 'fp-mcp-tree-'));
    mkdirSync(join(dir, '.shadowlap'));
    writeFileSync(join(dir, '.shadowlap', 'active.json'), JSON.stringify({ url: 'http://127.0.0.1:4000/t/x', runId: 'r', pid: process.pid }));
    expect(discoverSidecar({}, dir, () => {}, [process.pid, process.ppid])).toEqual({ url: 'http://127.0.0.1:4000/t/x', runId: 'r' });
    expect(discoverSidecar({}, dir, () => {}, [process.ppid])).toBeNull();
  });
});
