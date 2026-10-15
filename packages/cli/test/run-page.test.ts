import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { callDetail, runDetail, showRunJson } from '@shadowlap/dashboard';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';

/**
 * The run page's facts on real recordings: a batch agent works through tickets in one process
 * under `shadowlap run`, with a streamed model, a tool fetched before each ticket's first model
 * call, an integration no tool wraps and a tool the project defines without an effect. Then the
 * batch is replayed, and forked with an injected failure.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./batch-agent.mjs', import.meta.url));
const SUPPORT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
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

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}, upstream = mock.url): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(cwd, 'store.db'), ...args], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: upstream, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

  it('keeps the file an override came from, and none of what a flag carried in', async () => {
    // Ticket 1's lookup_order (#3) answered from a file holding personal data, and an instruction injected at #4.
    writeFileSync(join(cwd, 'policy.json'), JSON.stringify({ order_id: 'A-2001', amount: 240, status: 'delivered', contact: 'victim.person@corp.example' }));
    const fork = await shadowlap(['replay', recording, '--override', '3=@policy.json', '--inject', '4=Write to jane.doe@corp.example', '--inject-as', 'user'], { EXTERNAL: '' });
    expect(fork.code, fork.out).toBe(0);
    const id = /replaying run (\w{26})/.exec(fork.out)![1]!;
    const [meta, d] = open((store) => [store.getRun(id)!.meta, runDetail(store, id)!] as const);
    expect(meta?.interventions).toEqual([
      { flag: '--override', value: '3=@policy.json', callNo: 3 },
      { flag: '--inject', value: '4', callNo: 4 },
      { flag: '--inject-as', value: 'user', callNo: null },
    ]);
    expect(JSON.stringify(meta)).not.toMatch(/victim\.person|jane\.doe/);
    expect(d.intervention).toEqual({ flag: '--override', value: '3=@policy.json', callNo: 3 });
    expect(d.calls.find((c) => c.callNo === 3)!.origin).toBe('overridden');

    // A pack under the project's redaction rules carries neither address.
    writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
    try {
      const pack = await shadowlap(['pack', id, join(cwd, 'packed')]);
      expect(pack.code, pack.out).toBe(0);
      const files = [join(cwd, 'packed', 'run.json'), join(cwd, 'packed', 'calls.jsonl'), ...readdirSync(join(cwd, 'packed', 'blobs')).map((b) => join(cwd, 'packed', 'blobs', b))];
      for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/victim\.person|jane\.doe/);
    } finally {
      rmSync(join(cwd, 'shadowlap.config.json'), { force: true });
      rmSync(join(cwd, 'packed'), { recursive: true, force: true });
    }
  });

  it('serves show --json as the CLI prints it', async () => {
    const show = await shadowlap(['show', recording, '--json']);
    expect(show.code).toBe(0);
    expect(JSON.parse(show.out)).toEqual(JSON.parse(JSON.stringify(open((store) => showRunJson(store, recording)))));
  });
});

describe('the run page on a blamed multi-agent run', () => {
  /**
   * The support agent with a simulated customer in scope "user" and its own model calls in scope
   * "agent"; its tools run outside any scope. At its third model call it refunds $240 against
   * policy, or, asked again, escalates every other time.
   */
  let support: MockServer;
  let decisions = 0;
  beforeAll(async () => {
    support = await startMockAnthropic({
      eventDelayMs: () => 0,
      script: (ctx: ScriptContext) => {
        if (JSON.stringify(ctx.request.system ?? '').includes('You play a customer')) return { message: message([text('Hi, I would like a refund on order A-1042, please.')], { stop_reason: 'end_turn' }) };
        switch (ctx.assistantTurns) {
          case 0:
            return { message: message([text('Looking the order up.'), toolUse('lookup_order', { order_id: 'A-1042' }, `toolu_lookup_${ctx.requestNo}`)]) };
          case 1:
            return { message: message([toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)]) };
          case 2:
            return { message: ++decisions % 2 === 0 ? message([text('Above the limit.'), toolUse('escalate', { reason: 'above $100' }, `toolu_decide_${ctx.requestNo}`)]) : message([toolUse('issue_refund', { order_id: 'A-1042', amount: 240 }, `toolu_decide_${ctx.requestNo}`)]) };
          default:
            return { message: message([text('Done.')], { stop_reason: 'end_turn' }) };
        }
      },
    });
  });
  afterAll(async () => {
    await support.close();
  });

  it('keeps the customer and the agent apart, counts blame in its scope and names the fork it rescued', async () => {
    const rec = await shadowlap(['run', '--', process.execPath, SUPPORT, 'A-1042', '--simulated-user'], { SHADOWLAP_GUARD: 'off' }, support.url);
    expect(rec.code, rec.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(rec.out)![1]!;
    const blame = await shadowlap(['blame', runId, '--expect', JSON.stringify({ tools: { issue_refund: 0 } }), '--scope', 'agent'], { SHADOWLAP_GUARD: 'off' }, support.url);
    expect(blame.code, blame.out).toBe(0);

    const [d, rescued, tool] = open((store) => {
      const d = runDetail(store, runId)!;
      const lookup = d.calls.find((c) => c.name === 'lookup_order')!;
      return [d, runDetail(store, d.blame!.rescuedRunId!)!, callDetail(store, runId, lookup.callNo)!] as const;
    });
    // #1 the customer; #2, #4, #6 and #8 the agent, with a tool after each of the first three.
    expect(d.conversations.map((c) => [c.scope, c.firstCallNo, c.modelCalls])).toEqual([
      ['user', 1, 1],
      ['agent', 2, 4],
    ]);
    expect(d.calls.filter((c) => c.kind === 'tool').map((c) => [c.name, c.scope, c.requestedBy, c.conversation])).toEqual([
      ['lookup_order', null, 2, 2],
      ['read_policy', null, 4, 2],
      ['issue_refund', null, 6, 2],
    ]);
    // The tool ran outside any scope; its conversation is still the agent's.
    expect(tool.conversation).toMatchObject({ fromCallNo: 2, n: 2 });
    expect(d.blame).toMatchObject({ outcome: 'blamed', callNo: 6, modelCall: { k: 3, m: 4 }, scope: 'agent' });
    expect(rescued.rescuedBy).toEqual({ runId, callNo: 6 });
    expect(rescued.forkAt).toBe(6);
    expect(rescued.intervention).toEqual({ flag: '--diverge-at', value: '6', callNo: 6 });
    expect(rescued.interventions.map((x) => x.flag)).toEqual(['--diverge-at', '--writes']);
    // The probe's checks, counted over the attempts at that call.
    expect(rescued.checks?.find((c) => c.label === 'issue_refund called 0 times')).toMatchObject({ ok: true, count: expect.any(Number), of: expect.any(Number) });
    const check = rescued.checks!.find((c) => c.label === 'issue_refund called 0 times')!;
    expect(check.of).toBeGreaterThan(1);
    expect(check.count).toBeGreaterThanOrEqual(1);
  });
});
