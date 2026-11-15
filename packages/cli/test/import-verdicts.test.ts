import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext, type ScriptResult } from '@shadowlap-testing/mock-anthropic';

/**
 * A trace imported from production, taken through the commands that rule on a change. The trace is
 * fixtures/traces/otel-genai.json: a support agent looked order A-1042 up and told the customer what
 * it cost, which the oracle forbids. The mock plays the model: it states the cost unless the system
 * prompt says not to, which is the fix. `decisions` and `check` read the import as it is; `blame` and
 * `verify` take the developer's own command; a replay of it packs into a golden for `test`.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./trace-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ answer: { excludes: '$240' } });
const FIX = 'You are a support agent. Look the order up before you answer. Never state what an order cost.';

let cwd: string;
let db: string;
let mock: MockServer;

function script(ctx: ScriptContext): ScriptResult {
  if (ctx.assistantTurns === 0) return { message: message([toolUse('lookup_order', { order_id: 'A-1042' }, `toolu_lookup_${ctx.requestNo}`)]) };
  const quiet = JSON.stringify(ctx.request.system ?? '').includes('Never state what an order cost');
  return { message: message([text(quiet ? 'Order A-1042 was delivered.' : 'Order A-1042 was delivered; it cost $240.')], { stop_reason: 'end_turn' }) };
}

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off', SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

beforeAll(async () => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'sl-import-verdicts-')));
  db = join(cwd, 'store.db');
  writeFileSync(join(cwd, 'trace.json'), readFileSync(new URL('./fixtures/traces/otel-genai.json', import.meta.url), 'utf8'));
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The trace imported into the store, and the run a replay of it with the developer's agent made. */
async function imported(): Promise<string> {
  const r = await shadowlap(['import', 'otel', 'trace.json', '--json']);
  expect(r.code, r.err).toBe(0);
  return (JSON.parse(r.out) as { runs: Array<{ runId: string }> }).runs[0].runId;
}
async function replayOf(trace: string): Promise<string> {
  const r = await shadowlap(['replay', trace, '--', process.execPath, AGENT]);
  expect(r.err).toContain('Replay clean: 3/3 calls replayed (2 api, 1 tool), 0 upstream requests');
  const runs = JSON.parse((await shadowlap(['ls', '--json'])).out) as Array<{ runId: string; parentRunId: string | null }>;
  return runs.find((x) => x.parentRunId === trace)!.runId;
}

describe('an imported trace, read as it is', () => {
  it('is judged by an oracle from what the trace kept, with nothing replayed', async () => {
    const trace = await imported();
    const before = mock.requests.length;
    const r = await shadowlap(['check', trace, '--expect', ORACLE]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ final answer doesn\'t include "$240": found in the final answer');
    expect(r.out).toContain('1 recording judged from what it recorded, nothing replayed: 1 failed');
    expect(mock.requests.length).toBe(before);
  });

  it('has each of its model calls asked again under a change, with no command and no tool run', async () => {
    const trace = await imported();
    const before = mock.requests.length;
    const r = await shadowlap(['decisions', trace, '--set', 'temperature=1', '--samples', '1', '--json']);
    expect(r.code, r.err).toBe(0);
    const report = JSON.parse(r.out) as { counts: Record<string, number>; runs: Array<{ runId: string; steps: number; asked: number }> };
    expect(report.counts).toMatchObject({ 1: 0, 2: 0, same: 2, notAsked: 0 });
    expect(report.runs[0]).toMatchObject({ runId: trace, steps: 2, asked: 2 });
    // The trace's two requests, sent as it kept them but for the field.
    const sent = mock.requests.slice(before);
    expect(sent).toHaveLength(2);
    expect(sent.every((q) => q.body.model === 'claude-haiku-4-5' && (q.body as { temperature?: unknown }).temperature === 1)).toBe(true);
  });

  it('is refused by blame and verify until they are given a command, as a trace kept none', async () => {
    const trace = await imported();
    for (const args of [['blame', trace, '--expect', ORACLE], ['verify', '--fixes', trace, '--expect', ORACLE]]) {
      const r = await shadowlap(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain(`${trace.slice(0, 10)} was imported from a capture and has no command to re-run. Give yours after --:`);
    }
  });
});

describe('an imported trace, with the developer\'s own agent', () => {
  it('verifies a fix to the prompt against the trace itself: accepted with the fix, rejected without', async () => {
    const trace = await imported();
    const verify = (env: NodeJS.ProcessEnv) => shadowlap(['verify', '--fixes', trace, '--expect', ORACLE, '--attempts', '2', '--json', '--', process.execPath, AGENT], env);
    const fixed = await verify({ AGENT_SYSTEM: FIX });
    expect(fixed.code, fixed.err).toBe(0);
    expect(JSON.parse(fixed.out)).toMatchObject({ verdict: 'accepted', summary: { targets: { passed: 1, total: 1 } }, runs: [{ runId: trace, role: 'target', outcome: 'fixed', passes: 2, attempts: 2 }] });
    // Without the fix the agent sends what the trace kept, so the trace answers and the answer still names the cost.
    const before = mock.requests.length;
    const unfixed = await verify({});
    expect(unfixed.code).toBe(1);
    expect(JSON.parse(unfixed.out)).toMatchObject({ verdict: 'rejected', summary: { targets: { passed: 0, total: 1 } }, cost: { upstreamRequests: 0 } });
    expect(mock.requests.length).toBe(before);
  });

  it('blames the trace\'s failure with the command given: not one unlucky answer', async () => {
    const trace = await imported();
    const r = await shadowlap(['blame', trace, '--expect', ORACLE, '--attempts', '2', '--json', '--', process.execPath, AGENT]);
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ runId: trace, outcome: 'unrescuable', blamed: null });
  });

  it('blames and verifies a replay of the trace as it does any recording of the agent', async () => {
    const run = await replayOf(await imported());
    const blamed = await shadowlap(['blame', run, '--expect', ORACLE, '--attempts', '2']);
    expect(blamed.code, blamed.err).toBe(0);
    expect(blamed.out).toContain('✗ Not rescued from the first model call');
    // show says what the blame kept on the run found in the words its report heads: from the first model call, not any.
    const shown = await shadowlap(['show', run]);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain('blame: not rescued from the first model call');
    const verified = await shadowlap(['verify', '--fixes', run, '--expect', ORACLE, '--attempts', '2'], { AGENT_SYSTEM: FIX });
    expect(verified.code, verified.err).toBe(0);
    expect(verified.out).toContain('✓ Accepted: the change fixes 1 of 1 target run');
    expect(verified.out).toContain('fixed  2 of 2 passed   forked at #1');
  });

  it('becomes a golden that passes with nothing live, and fails on a change to the prompt at the call it changes', async () => {
    const run = await replayOf(await imported());
    expect((await shadowlap(['pack', run, 'goldens/order'])).code).toBe(0);
    const before = mock.requests.length;
    const passed = await shadowlap(['test', 'goldens/order']);
    expect(passed.code, passed.out).toBe(0);
    expect(passed.out).toContain('✓ order: 3/3 replayed');
    expect(passed.out).toContain('1 passed, 0 failed · 0 upstream requests');
    const failed = await shadowlap(['test', 'goldens/order'], { AGENT_SYSTEM: FIX });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('✗ order: diverged at call 1 (api POST /v1/messages)');
    expect(failed.out).toContain('~ $.system');
    expect(mock.requests.length).toBe(before);
  });
});
