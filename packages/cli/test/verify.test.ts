import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';

/**
 * `shadowlap verify` through the CLI, on the support agent. Order A-1042 is $240, which policy says to
 * escalate; order B-7 is $40, which it may refund. The mock plays the model under three prompts: the
 * original one refunds whatever it is asked to; the good fix escalates the large refund and still
 * refunds the small one; the bad fix names a `refund_order` tool the agent doesn't have, so the small
 * refund crashes it. "big-model" follows policy under any prompt. The oracle: never refund $240.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } });
const GOOD_FIX = 'You are a support agent. Escalate refunds above $100.';
const BAD_FIX = 'You are a support agent. Escalate refunds above $100; use refund_order for the rest.';

let mock: MockServer;
let work: string;
let db: string;

function script(ctx: ScriptContext) {
  const system = JSON.stringify(ctx.request.system ?? '');
  const small = JSON.stringify(ctx.request.messages[0]?.content ?? '').includes('B-7');
  const order = small ? 'B-7' : 'A-1042';
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([toolUse('lookup_order', { order_id: order }, `toolu_lookup_${ctx.requestNo}`)]) };
    case 1:
      return { message: message([toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)]) };
    case 2: {
      const follows = system.includes('Escalate refunds above $100') || ctx.request.model === 'big-model' || JSON.stringify(ctx.request.messages).includes('Never refund them yourself');
      if (small && system.includes('refund_order')) return { message: message([toolUse('refund_order', { order_id: order }, `toolu_decide_${ctx.requestNo}`)]) };
      if (!small && follows) return { message: message([text('Above the limit.'), toolUse('escalate', { reason: 'refund of $240 is above $100' }, `toolu_decide_${ctx.requestNo}`)]) };
      return { message: message([toolUse('issue_refund', { order_id: order, amount: small ? 40 : 240 }, `toolu_decide_${ctx.requestNo}`)]) };
    }
    default:
      return { message: message([text('Done.')], { stop_reason: 'end_turn' }) };
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
beforeEach(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  work = mkdtempSync(join(tmpdir(), 'fp-verify-'));
  db = join(work, 'store.db');
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd: work, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', AGENT_OUTBOX: join(work, 'outbox.jsonl'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

async function record(order?: string): Promise<string> {
  const r = await shadowlap(['run', '--', process.execPath, AGENT, ...(order ? [order] : [])]);
  expect(r.code, r.out).toBe(0);
  return /recording run (\w{26})/.exec(r.out)![1]!;
}

/** Two runs that refunded $240 against policy, and one that refunded $40 within it, labelled good. */
async function runs(): Promise<{ failed: string; heldOut: string; good: string }> {
  const failed = await record();
  const heldOut = await record();
  const good = await record('B-7');
  expect((await shadowlap(['label', good, 'good'])).code).toBe(0);
  return { failed, heldOut, good };
}

const outbox = () => (existsSync(join(work, 'outbox.jsonl')) ? readFileSync(join(work, 'outbox.jsonl'), 'utf8').trim().split('\n') : []);

interface Json {
  verdict: string;
  reasons: string[];
  warnings: string[];
  summary: Record<string, { passed: number; total: number }>;
  runs: Array<{ runId: string; role: string; outcome: string; passes: number; attempts: number; deterministic: boolean; recorded: { passed: boolean | null }; runs: Array<{ forkedAt: number | null }> }>;
  cost: { attempts: number; upstreamRequests: number };
}

describe('shadowlap verify', () => {
  it('accepts a change that fixes the failing runs, held-out ones included, and keeps the good one', async () => {
    const { failed, heldOut, good } = await runs();
    const r = await shadowlap(['verify', '--fixes', failed, '--holdout', heldOut, '--keeps', 'label:good', '--expect', ORACLE, '--json'], { AGENT_SYSTEM: GOOD_FIX });
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Json;
    expect(report).toMatchObject({ verdict: 'accepted', reasons: [], warnings: [], summary: { targets: { passed: 1, total: 1 }, holdout: { passed: 1, total: 1 }, good: { passed: 1, total: 1 } } });
    // A changed prompt changes the first request, so every run forks there and runs live: the gate
    // passes a run that always passes after 12 attempts, at least 90% with 95% confidence.
    for (const run of report.runs) expect(run).toMatchObject({ outcome: run.role === 'good' ? 'kept' : 'fixed', passes: 12, attempts: 12, deterministic: false, decision: 'pass', rate: { decision: 'pass', sentence: 'passed: at least 90% with 95% confidence after 12 attempts' } });
    expect(report).toMatchObject({ gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 40 }, attemptsPerRun: 40, passesNeeded: 12 });
    expect(report.runs.find((x) => x.runId === failed)!.recorded.passed).toBe(false);
    expect(report.runs.find((x) => x.runId === good)!.recorded.passed).toBe(true);
    // Nothing the attempts did reached the world: the outbox holds the three recordings' writes only.
    expect(outbox()).toHaveLength(3);

    const store = Store.open(db);
    try {
      const attempts = store.allRuns().filter((x) => x.meta?.verify);
      expect(attempts).toHaveLength(36);
      expect(attempts.every((x) => x.meta!.verify!.passed)).toBe(true);
      expect(new Set(attempts.map((x) => x.meta!.repeat!.group)).size).toBe(3);
    } finally {
      store.close();
    }
  });

  it('rejects a change that fixes the failing runs but breaks a good one', async () => {
    const { failed, heldOut } = await runs();
    const r = await shadowlap(['verify', '--fixes', failed, '--holdout', heldOut, '--keeps', 'label:good', '--expect', ORACLE], { AGENT_SYSTEM: BAD_FIX });
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toContain('✗ Rejected: the change fixes 1 of 1 target run, 1 of 1 held-out run and keeps 0 of 1 good run');
    // Three straight failures fail the gate: at most 70% with 95% confidence.
    expect(r.stdout).toMatch(/· good run \w{10} broken: 0 of 3 passed, ≤ 0\.56 \(the agent exited with code 1\)/);
    expect(r.stdout).toMatch(/good +\w{10} +broken +0 of 3 passed, ≤ 0\.56 +the agent exited with code 1/);
    expect(r.stdout).toMatch(/target +\w{10} +fixed +12 of 12 passed, ≥ 0\.76 +forked at #1/);
    expect(r.stdout).toContain("Its gate decides after each attempt: pass at 90% or more, fail at 70% or less, at most 5% risk of the wrong verdict, up to 40 attempts; a clean replay settles it in one.");
    expect(r.stdout).toMatch(/per run, as it would run live: [\d,]+ → [\d,]+ input tokens/);
  });

  it('settles runs that replay clean with one free attempt each', async () => {
    const { failed, good } = await runs();
    const before = mock.requests.length;
    const r = await shadowlap(['verify', '--fixes', failed, '--keeps', good, '--expect', ORACLE, '--json']);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.verdict).toBe('rejected');
    expect(report.runs.map((x) => [x.outcome, x.attempts, x.deterministic, x.runs[0]!.forkedAt])).toEqual([
      ['not-fixed', 1, true, null],
      ['kept', 1, true, null],
    ]);
    expect(report.cost).toMatchObject({ attempts: 2, upstreamRequests: 0 });
    expect(mock.requests.length).toBe(before);
    expect(report.warnings).toContain('no held-out runs: the change was only tried on the runs it was written for (--holdout)');
  });

  it('verifies a change of model from the first model call', async () => {
    const { failed } = await runs();
    const r = await shadowlap(['verify', '--fixes', failed, '--keeps', 'label:good', '--expect', ORACLE, '--model', 'big-model', '--attempts', '2']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('✓ Accepted: the change fixes 1 of 1 target run and keeps 1 of 1 good run');
    expect(r.stdout).toContain("A run passes when 2 of 2 attempts meet the oracle, with model=big-model from each run's first model call");
  });

  it('stops early with --fail-fast, and reports what it never reached', async () => {
    const { failed, good } = await runs();
    const r = await shadowlap(['verify', '--fixes', failed, '--keeps', good, '--expect', ORACLE, '--fail-fast', '--json']);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.verdict).toBe('rejected');
    expect(report.runs.map((x) => [x.outcome, x.attempts])).toEqual([
      ['not-fixed', 1],
      ['unsettled', 0],
    ]);
    expect(report.reasons).toContain('1 run not settled: a run failed (--fail-fast)');
  });

  it('warns when a recording contradicts the role it was given', async () => {
    const { failed, good } = await runs();
    const r = await shadowlap(['verify', '--fixes', good, '--keeps', failed, '--expect', ORACLE]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/target run \w{10} already passes as recorded, so fixing it proves nothing/);
    expect(r.stdout).toMatch(/good run \w{10} fails as recorded \(issue_refund with \{"amount":240\} called 0 times, but called 1 time\), so it is not a good run/);
  });

  it('runs a fixed tool live with --live-tool, and warns when it was left out', async () => {
    // A copy of the agent to change, next to the original so its imports resolve.
    const copy = fileURLToPath(new URL(`./.tmp-support-agent-${process.pid}.mjs`, import.meta.url));
    copyFileSync(AGENT, copy);
    try {
      const r0 = await shadowlap(['run', '--', process.execPath, copy]);
      const failed = /recording run (\w{26})/.exec(r0.out)![1]!;
      // The fix is in the tool: its policy text now says what the model got wrong.
      writeFileSync(copy, readFileSync(copy, 'utf8').replace("escalate them.' })", "escalate them. Never refund them yourself.' })"));

      const stale = await shadowlap(['verify', '--fixes', failed, '--expect', ORACLE]);
      expect(stale.code).toBe(1);
      expect(stale.stdout).toMatch(/target +\w{10} +not fixed +clean replay/);
      expect(stale.stdout).toContain('read_policy changed since the recording; pass --live-tool read_policy to run it live');

      const live = await shadowlap(['verify', '--fixes', failed, '--expect', ORACLE, '--live-tool', 'read_policy', '--attempts', '2', '--json']);
      expect(live.code, live.out).toBe(0);
      const report = JSON.parse(live.stdout) as Json;
      expect(report.runs[0]).toMatchObject({ outcome: 'fixed', passes: 2, deterministic: false });
    } finally {
      rmSync(copy, { force: true });
    }
  });

  it('never takes a replay that went around Shadowlap for a clean one', async () => {
    const { good } = await runs();
    // The client fixes its base URL, and nothing tells Shadowlap that host is a model server: the
    // agent reaches the model directly, and nothing it does is recorded or served.
    const around = { SHADOWLAP_UPSTREAM_ANTHROPIC: '', SHADOWLAP_CAPTURE: 'off', AGENT_BASE_URL: mock.url };
    const r = await shadowlap(['verify', '--keeps', good, '--expect', ORACLE, '--attempts', '1', '--json'], around);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.runs[0]).toMatchObject({ outcome: 'broken', deterministic: false });
    expect(report.warnings.join(' ')).toContain('the replay made no calls through Shadowlap');
  });

  it('checks the runs it is given before running anything', async () => {
    const { failed } = await runs();
    expect((await shadowlap(['verify'])).out).toContain('give the runs to verify');
    expect((await shadowlap(['verify', '--fixes', failed, '--keeps', failed])).out).toContain('is given to both --fixes and --keeps; a run has one role');
    expect((await shadowlap(['verify', '--keeps', 'label:nothing'])).out).toContain('no run has the label "nothing"');
  });
});
