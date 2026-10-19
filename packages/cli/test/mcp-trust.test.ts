import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, trustOf, untrustedReads } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { openWorld, startMcpProxy } from '../src/mcp.js';

/**
 * Behind shadowlap mcp, a read tool whose server sets openWorldHint (it reaches outside entities: a
 * web search, a mailbox) is recorded untrusted, beside the readOnlyHint the proxy already reads, so
 * shadowlap injection plants in its reads. A write stays a write, whatever the hint.
 */
const serverScript = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

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

function client(runId: string, effects?: Record<string, 'pure' | 'read' | 'write'>) {
  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  let buf = '';
  clientOut.setEncoding('utf8');
  clientOut.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as Record<string, unknown>;
      waiters.get(m.id as number)?.(m);
    }
  });
  const sidecarTarget = { url: sidecar.envFor(runId).SHADOWLAP_URL!, runId };
  const proxy = startMcpProxy({ clientIn, clientOut, server: { command: process.execPath, args: [serverScript], env: { ...process.env, FAKE_MCP_OPEN_WORLD: '1' } }, sidecar: sidecarTarget, ...(effects ? { effects } : {}) });
  let id = 1;
  const request = (method: string, params?: unknown) => {
    const n = id++;
    const answer = new Promise<Record<string, unknown>>((resolve) => waiters.set(n, resolve));
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, ...(params !== undefined ? { params } : {}) }) + '\n');
    return answer;
  };
  return { request, close: async () => (clientIn.end(), await proxy.done) };
}

describe('shadowlap mcp and openWorldHint', () => {
  it('reads only a hint the server sets', () => {
    expect(openWorld({ readOnlyHint: true, openWorldHint: true })).toBe(true);
    expect(openWorld({ readOnlyHint: true })).toBe(false);
    expect(openWorld({ openWorldHint: false })).toBe(false);
    expect(openWorld(undefined)).toBe(false);
  });

  it('records an open-world read as untrusted, and leaves a closed read and an open-world write alone', async () => {
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c = client(run.runId);
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await c.request('tools/list');
    await c.request('tools/call', { name: 'web_search', arguments: { q: 'replay' } });
    await c.request('tools/call', { name: 'read_note', arguments: { id: 1 } });
    await c.request('tools/call', { name: 'post_status', arguments: { text: 'hi' } });
    await c.close();
    sidecar.endRun(run.runId, 'completed');
    const calls = store.getCalls(run.runId);
    expect(calls.map((x) => [x.name, x.effect, x.meta.trust ?? null])).toEqual([
      ['web_search', 'read', 'untrusted'],
      ['read_note', 'read', null],
      ['post_status', 'write', null],
    ]);
    // The tools the server offers carry it too, for Settings → Tools.
    expect(calls[0]!.meta.mcp?.tools?.find((t) => t.name === 'web_search')).toEqual({ name: 'web_search', effect: 'read', trust: 'untrusted' });
    // As shadowlap injection reads it: from MCP, and the config can say otherwise.
    expect(trustOf(calls[0]!)).toEqual({ trust: 'untrusted', from: 'mcp' });
    expect(untrustedReads(calls).reads.map((r) => [r.callNo, r.name, r.from])).toEqual([[calls[0]!.callNo, 'web_search', 'mcp']]);
    expect(trustOf(calls[0]!, { web_search: { trust: 'trusted' } })).toEqual({ trust: 'trusted', from: 'config' });
  });

  it('keeps an open-world tool given --effect write out of the untrusted reads', async () => {
    const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c = client(run.runId, { web_search: 'write' });
    await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    await c.request('tools/list');
    await c.request('tools/call', { name: 'web_search', arguments: { q: 'x' } });
    await c.close();
    sidecar.endRun(run.runId, 'completed');
    expect(store.getCalls(run.runId).map((x) => [x.effect, x.meta.trust ?? null])).toEqual([['write', null]]);
  });
});
