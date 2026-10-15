import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { runDetail, showRunJson } from '@shadowlap/dashboard';
import { message, startMockAnthropic, text, toolUse, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * The run page's facts on real recordings: a batch agent works through tickets in one process
 * under `shadowlap run`, with a streamed model, a tool fetched before each ticket's first model
 * call, an integration no tool wraps and a tool the project defines without an effect. Then the
 * batch is replayed, and forked with an injected failure.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./batch-agent.mjs', import.meta.url));
const TICKETS = 6;

let mock: MockServer;
let external: Server;
let externalPort: number;
let cwd: string;
let recording: string;

beforeAll(async () => {
  mock = await startMockAnthropic({
    // Each ticket: look the order up, then answer. The prompt cache is written on a ticket's first
    // call and read back on its second, as with a cache breakpoint on the system prompt.
    script: (ctx) => {
      const order = /order (A-\d+)/.exec(String(ctx.request.messages[0]?.content))?.[1] ?? '?';
      const first = ctx.assistantTurns === 0;
      const m = message(first ? [text('Let me look it up.'), toolUse('lookup_order', { order_id: order })] : [text(`Refunded ${order}.`)]);
      return { message: { ...m, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: first ? 3000 : 400, cache_read_input_tokens: first ? 0 : 3010 } } };
    },
  });
  external = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => external.listen(0, 'localhost', r));
  externalPort = (external.address() as AddressInfo).port;
  cwd = mkdtempSync(join(tmpdir(), 'sl-run-page-'));
  // A tool the project defines with no effect: the agent never records it.
  writeFileSync(join(cwd, 'tools.py'), 'from langchain_core.tools import tool\n\n@tool\ndef send_slack(text: str) -> str:\n    """Post to the team channel."""\n    return "ok"\n');
});
afterAll(async () => {
  await mock.close();
  await new Promise<void>((r) => external.close(() => r()));
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const open = <T>(fn: (store: Store) => T): T => {
  const store = Store.open(join(cwd, 'store.db'));
  try {
    return fn(store);
  } finally {
    store.close();
  }
};

describe('the run page on a recorded batch', () => {
  it('knows each ticket’s conversation, where the cache hit, and what was never recorded', async () => {
    const run = await shadowlap(['run', '--', process.execPath, AGENT, String(TICKETS)], { EXTERNAL: `http://localhost:${externalPort}/` });
    expect(run.code, run.out).toBe(0);
    recording = /recording run (\w{26})/.exec(run.out)![1]!;
    const d = open((store) => runDetail(store, recording)!);
    // get_ticket, model, lookup_order, model: four calls a ticket.
    expect(d.calls).toHaveLength(TICKETS * 4);
    expect(d.conversations.map((c) => [c.n, c.firstCallNo, c.modelCalls, c.calls])).toEqual(Array.from({ length: TICKETS }, (_, i) => [i + 1, i * 4 + 2, 2, 4]));
    expect(d.calls.map((c) => c.conversation)).toEqual(Array.from({ length: TICKETS * 4 }, (_, i) => Math.floor(i / 4) + 1));
    // Every ticket's first call wrote the cache and its second read it back: no misses, though
    // each new ticket reads nothing after the previous ticket's last call.
    expect(d.cache.misses).toEqual([]);
    expect(d.cache.readShare).toBeCloseTo(3010 / (3010 + 3420), 3);
    // A streamed response's tool-use id, matched to the tool call it asked for.
    for (const c of d.calls.filter((x) => x.name === 'lookup_order')) {
      expect(c.requestedBy).toBe(c.callNo - 1);
      expect(c.toolUseId).toMatch(/^toolu_lookup_order_\d+$/);
      expect(c.resultShort).toMatch(/^\{"order_id":"A-20\d\d","amount":240,"status":"delivered"\}$/);
    }
    expect(d.notRecorded?.tools).toEqual(['send_slack']);
    expect(d.notRecorded?.hosts).toEqual([{ target: `localhost:${externalPort}`, count: expect.any(Number), action: 'warned' }]);
    expect(d.forkAt).toBeNull();
    expect(d.interventions).toEqual([]);
  });

  it('replays it without waiting, and says how long the recording waited', async () => {
    const replay = await shadowlap(['replay', recording], { EXTERNAL: '' });
    expect(replay.code, replay.out).toBe(0);
    const id = /replaying run (\w{26})/.exec(replay.out)![1]!;
    const [rec, d] = open((store) => [runDetail(store, recording)!, runDetail(store, id)!] as const);
    expect(d.calls.every((c) => c.origin === 'replayed' && c.latencyMs === 0)).toBe(true);
    expect(d.calls.map((c) => c.recordedMs)).toEqual(rec.calls.map((c) => c.latencyMs));
    expect(d.notWaitedMs).toBe(rec.calls.reduce((s, c) => s + (c.latencyMs ?? 0), 0));
    expect(d.notWaitedMs).toBeGreaterThan(0);
    expect(d.conversations).toHaveLength(TICKETS);
    // The recording's tools without an effect still run for real here.
    expect(d.notRecorded).toEqual({ hosts: [], tools: ['send_slack'] });
  });

  it('names the flag a fork was made with', async () => {
    // Ticket 2's first model call answers 529; the agent gives up there.
    const fork = await shadowlap(['replay', recording, '--fail-at', '6=529', '--writes', 'stub'], { EXTERNAL: '' });
    const id = /replaying run (\w{26})/.exec(fork.out)![1]!;
    const d = open((store) => runDetail(store, id)!);
    expect(d.forkAt).toBe(6);
    expect(d.intervention).toEqual({ flag: '--fail-at', value: '6=529', callNo: 6 });
    expect(d.interventions).toEqual([
      { flag: '--fail-at', value: '6=529', callNo: 6 },
      { flag: '--writes', value: 'stub', callNo: null },
    ]);
    expect(d.calls.find((c) => c.callNo === 6)!.origin).toBe('injected');
  });

  it('serves show --json as the CLI prints it', async () => {
    const show = await shadowlap(['show', recording, '--json']);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out)).toEqual(JSON.parse(JSON.stringify(open((store) => showRunJson(store, recording)))));
  });
});
