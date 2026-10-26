import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { registerAgent } from '../src/agent-registry.js';
import { sessionRun, sessionSidecar, startMcpListener, type McpListener, type SidecarTarget } from '../src/mcp.js';
import { startFakeMcpHttpServer, type FakeMcpHttpServer } from './fake-mcp-http-server.js';

/**
 * A `shadowlap mcp --listen` started on its own, in a terminal beside the agent, finds the run each
 * session belongs to from the client's own process: the agent a Shadowlap command started, which is
 * registered by its process id. So the attempts of test, blame, verify, repair and replay --repeat,
 * which `run`'s active.json never named, record into their own runs, even several at once, and a
 * session no run is found for refuses writes instead of sending them live.
 */

const dir = mkdtempSync(join(tmpdir(), 'sl-listen-runs-'));
const home = join(dir, 'home');
const project = join(dir, 'project');
// An MCP client over Streamable HTTP, as an agent's would be: it waits for a line on stdin, then
// starts a session, lists the tools and calls send_note, a write, printing what it got.
const CLIENT = join(dir, 'client.mjs');
writeFileSync(
  CLIENT,
  `const endpoint = process.argv[2];
await new Promise((r) => process.stdin.once('data', r));
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
const sent = await request('tools/call', { name: 'send_note', arguments: { to: 'y' } });
console.log(JSON.stringify(sent.result));
`,
);

let store: Store;
let sidecar: Sidecar;
let server: FakeMcpHttpServer;
let listener: McpListener;
const said: string[] = [];
const target = (runId: string): SidecarTarget => ({ url: sidecar.envFor(runId).SHADOWLAP_URL, runId });

beforeAll(async () => {
  store = Store.open(':memory:');
  sidecar = await Sidecar.start({ store });
  server = await startFakeMcpHttpServer();
  // As `shadowlap mcp --url … --listen …` serves when started on its own: each session's run from its client's process.
  listener = await startMcpListener({ host: '127.0.0.1', port: 0, url: server.url, sidecar: (client) => sessionSidecar(client, project, (l) => said.push(l), { home }), log: () => {} });
});
afterAll(async () => {
  await listener.close();
  await server.close();
  await sidecar.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** An agent's MCP client, registered for `run` as a Shadowlap command registers the agents it starts (or not, with null), and what its call got. */
async function agent(runId: string | null): Promise<{ text: string; isError: boolean }> {
  const child: ChildProcess = spawn(process.execPath, [CLIENT, listener.url], { stdio: ['pipe', 'pipe', 'inherit'] });
  const registered = runId ? registerAgent(child.pid!, target(runId), { home, cwd: project }) : null;
  let out = '';
  child.stdout!.on('data', (d: Buffer) => (out += d.toString()));
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.stdin!.end('go\n');
  await exited;
  registered?.unregister();
  const result = JSON.parse(out.trim().split('\n').pop()!) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content[0].text, isError: result.isError === true };
}

describe('a standalone mcp --listen', () => {
  let recording: string;

  it("records a session into the run its client's process belongs to", async () => {
    recording = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: project } }).runId;
    const got = await agent(recording);
    sidecar.endRun(recording, 'completed');
    expect(got).toEqual({ text: 'send_note:{"to":"y"}:1', isError: false });
    expect(server.calls.map((c) => c.name)).toEqual(['send_note']);
    expect(store.getCalls(recording).filter((c) => c.kind === 'tool').map((c) => `${c.name}:${c.origin}`)).toEqual(['send_note:live']);
    expect(said.at(-1)).toBe(`a session started: recording into run ${recording}`);
  }, 60_000);

  it("serves a replay's write from the recording, never sending it live", async () => {
    const replay = sidecar.startRun({ mode: 'replay', parentRunId: recording, command: { argv: ['agent'], cwd: project } }).runId;
    const got = await agent(replay);
    sidecar.endRun(replay, 'completed');
    expect(got).toEqual({ text: 'send_note:{"to":"y"}:1', isError: false });
    expect(server.calls).toHaveLength(1);
    expect(store.getCalls(replay).filter((c) => c.kind === 'tool').map((c) => c.origin)).toEqual(['replayed']);
  }, 60_000);

  it('records attempts running at once each into its own run', async () => {
    const runs = [0, 1, 2].map(() => sidecar.startRun({ mode: 'replay', parentRunId: recording, command: { argv: ['agent'], cwd: project } }).runId);
    const got = await Promise.all(runs.map((r) => agent(r)));
    for (const r of runs) sidecar.endRun(r, 'completed');
    expect(got.every((g) => g.text === 'send_note:{"to":"y"}:1' && !g.isError)).toBe(true);
    expect(server.calls).toHaveLength(1);
    for (const r of runs) expect(store.getCalls(r).filter((c) => c.kind === 'tool').map((c) => c.origin)).toEqual(['replayed']);
  }, 60_000);

  it('refuses the writes of a session no run is found for, as this could be a replay', async () => {
    const got = await agent(null);
    expect(got.isError).toBe(true);
    expect(got.text).toBe("shadowlap: send_note was not sent. It is a write, and it can't be recorded: no Shadowlap run is active for it. A write is never sent unrecorded under Shadowlap, since this may be a replay.");
    expect(server.calls).toHaveLength(1);
    expect(said.at(-1)).toBe("a session started that can't be recorded (no Shadowlap run is active for it): write tools are refused, read tools pass through unrecorded");
  }, 60_000);

  it("falls back to the one run active for this user where the client's process can't be told", async () => {
    // A connection no process holds: the system can't say which process it is.
    const nowhere = { port: 1, serverPort: 2 };
    expect(sessionRun(nowhere, project, () => {}, { home })).toEqual({ kind: 'none' });
    const sleeper = (): ChildProcess => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const [a, b] = [sleeper(), sleeper()];
    try {
      const one = registerAgent(a.pid!, target('run-a'), { home, cwd: project });
      expect(sessionRun(nowhere, project, () => {}, { home })).toMatchObject({ kind: 'sidecar', target: { runId: 'run-a' } });
      const two = registerAgent(b.pid!, target('run-b'), { home, cwd: project });
      expect(sessionRun(nowhere, project, () => {}, { home })).toEqual({ kind: 'unusable', reason: "2 Shadowlap runs are active (run-a, run-b), and which one this session's client belongs to can't be told" });
      one.unregister();
      two.unregister();
    } finally {
      a.kill();
      b.kill();
    }
  }, 60_000);
});
