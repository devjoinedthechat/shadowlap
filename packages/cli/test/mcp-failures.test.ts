import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type ReplayOptions } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { startMcpProxy, type SidecarTarget } from '../src/mcp.js';

/**
 * `replay --fail-at <call>=timeout|error|<status>` on an MCP tool behind `shadowlap mcp`: the server
 * never sees the call, and the client gets what an MCP server answers when a tool's handler fails (a
 * result with isError and the failure's message), so the model sees the error and the agent goes on.
 */

const serverScript = fileURLToPath(new URL('./fake-mcp-server.mjs', import.meta.url));

/** An MCP client over the proxy: sends requests and waits for the response with the same id. */
function client(sidecar: SidecarTarget) {
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
  const proxy = startMcpProxy({ clientIn, clientOut, server: { command: process.execPath, args: [serverScript] }, sidecar });
  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const p = new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve));
    clientIn.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }) + '\n');
    return p;
  };
  return {
    request,
    call: (name: string, args: unknown) => request('tools/call', { name, arguments: args }),
    close: async () => {
      clientIn.end();
      await proxy.done;
    },
  };
}

describe('shadowlap mcp: a tool failed with --fail-at', () => {
  let store: Store;
  let sidecar: Sidecar;
  let parent: string;
  const target = (runId: string): SidecarTarget => ({ url: sidecar.envFor(runId).SHADOWLAP_URL, runId });

  /** Lists the tools, then reads note 7, sends a note and reads note 8: the session every run makes. */
  async function session(runId: string) {
    const c = client(target(runId));
    await c.request('tools/list');
    const answers = [await c.call('read_note', { id: 7 }), await c.call('send_note', { to: 'ops' }), await c.call('read_note', { id: 8 })];
    // A tool after the failures runs live: the fresh server process counts it as its first call.
    const after = await c.call('read_note', { id: 9 });
    await c.close();
    return { answers, after };
  }

  beforeAll(async () => {
    store = Store.open(':memory:');
    sidecar = await Sidecar.start({ store });
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    await session(rec.runId);
    sidecar.endRun(rec.runId, 'completed');
    parent = rec.runId;
  });
  afterAll(async () => {
    await sidecar.close();
    store.close();
  });

  it('answers each failure as a tool result with isError, which the server never sees', async () => {
    const replay: Partial<ReplayOptions> = {
      toolFailures: new Map([
        [1, { kind: 'timeout' }],
        [2, { kind: 'error', message: 'connection reset by peer' }],
        [3, { kind: 'status', status: 503 }],
      ]),
    };
    const run = sidecar.startRun({ mode: 'replay', parentRunId: parent, command: { argv: ['agent'], cwd: '/' }, replay });
    const { answers, after } = await session(run.runId);
    const { summary } = sidecar.endRun(run.runId, 'completed');

    // What a failing handler answers, as the model will read it, with nothing that names Shadowlap.
    expect(answers.map((a) => a.error)).toEqual([undefined, undefined, undefined]);
    expect(answers.map((a) => a.result)).toEqual([
      { content: [{ type: 'text', text: 'read_note timed out' }], isError: true },
      { content: [{ type: 'text', text: 'connection reset by peer' }], isError: true },
      { content: [{ type: 'text', text: 'HTTP 503 Service Unavailable' }], isError: true },
    ]);
    // The server saw none of them: the call after them is the first it counts.
    expect((after.result as { content: Array<{ text: string }> }).content[0].text).toBe('read_note:{"id":9}:1');

    const calls = store.getCalls(run.runId);
    expect(calls.slice(0, 3).map((c) => [c.name, c.origin, c.end?.meta.injected])).toEqual([
      ['read_note', 'live', true],
      ['send_note', 'live', true],
      ['read_note', 'live', true],
    ]);
    expect(summary.injected).toBe(3);
    expect(summary.divergence?.callNo).toBe(1);
  });

  it('still answers a recorded error as it was recorded', async () => {
    const rec = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const c1 = client(target(rec.runId));
    await c1.request('tools/list');
    const recorded = await c1.call('boom', {});
    await c1.close();
    sidecar.endRun(rec.runId, 'completed');

    const rep = sidecar.startRun({ mode: 'replay', parentRunId: rec.runId, command: { argv: ['agent'], cwd: '/' } });
    const c2 = client(target(rep.runId));
    await c2.request('tools/list');
    const replayed = await c2.call('boom', {});
    await c2.close();
    sidecar.endRun(rep.runId, 'completed');
    expect(replayed.error).toEqual(recorded.error);
    expect(replayed.result).toBeUndefined();
  });
});
