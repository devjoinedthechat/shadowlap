import { spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext, type ScriptResult } from '@shadowlap-testing/mock-anthropic';
import { removeTempProject, tempProject } from '../../../testing/temp-project.mjs';
import { limitHangs, watch } from './hang-limit.js';

/**
 * `shadowlap verify` through the CLI, on the support agent. Order A-1042 is $240, which policy says to
 * escalate; order B-7 is $40, which it may refund. The mock plays the model under three prompts: the
 * original one refunds whatever it is asked to; the good fix escalates the large refund and still
 * refunds the small one; the bad fix names a `refund_order` tool the agent doesn't have, so the small
 * refund crashes it. "big-model" follows policy under any prompt. The oracle: never refund $240. With
 * `hold` set, the mock keeps the next request it gets waiting before it answers.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } });
const GOOD_FIX = 'You are a support agent. Escalate refunds above $100.';
const BAD_FIX = 'You are a support agent. Escalate refunds above $100; use refund_order for the rest.';

let mock: MockServer;
let work: string;
let db: string;
/** The next request the mock gets waits `ms` before its answer; `held` counts the requests it held. */
let hold: { ms: number; held: number } | null = null;

function script(ctx: ScriptContext): ScriptResult {
  const result = answer(ctx);
  if (!hold || hold.held) return result;
  hold.held++;
  return { ...result, delayMs: hold.ms };
}

function answer(ctx: ScriptContext): ScriptResult {
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

// A verify runs dozens of attempts, each an agent of its own: one that hangs is stopped before its test times out.
limitHangs();

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  for (const dir of [work, recorded?.dir]) if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
beforeEach(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  work = mkdtempSync(join(tmpdir(), 'fp-verify-'));
  db = join(work, 'store.db');
  hold = null;
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd: work, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', AGENT_OUTBOX: join(work, 'outbox.jsonl'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    watch(child, `shadowlap ${args.join(' ')}`, () => out, reject);
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
  return /recording run (\w{26})/.exec(r.out)![1];
}

/** The folder the first test to ask for `runs()` recorded them in, its store and outbox, and the runs' ids. */
let recorded: { dir: string; ids: { failed: string; heldOut: string; good: string } } | null = null;

/**
 * Two runs that refunded $240 against policy, and one that refunded $40 within it, labelled good.
 * Recorded once, by the first test that asks: the mock answers them the same every time, so each
 * test after it gets a copy of the folder they were recorded in, store and outbox, where it would
 * spend three recordings and a label.
 */
async function runs(): Promise<{ failed: string; heldOut: string; good: string }> {
  if (recorded) {
    cpSync(recorded.dir, work, { recursive: true });
    return recorded.ids;
  }
  const failed = await record();
  const heldOut = await record();
  const good = await record('B-7');
  expect((await shadowlap(['label', good, 'good'])).code).toBe(0);
  const dir = mkdtempSync(join(tmpdir(), 'fp-verify-runs-'));
  cpSync(work, dir, { recursive: true });
  recorded = { dir, ids: { failed, heldOut, good } };
  return recorded.ids;
}

const outbox = () => (existsSync(join(work, 'outbox.jsonl')) ? readFileSync(join(work, 'outbox.jsonl'), 'utf8').trim().split('\n') : []);

interface Json {
  verdict: string;
  reasons: string[];
  warnings: string[];
  summary: Record<string, { passed: number; total: number }>;
  runs: Array<{ runId: string; role: string; outcome: string; passes: number; attempts: number; deterministic: boolean; recorded: { passed: boolean | null }; runs: Array<{ forkedAt: number | null; afterFork?: Record<string, number> }> }>;
  cost: { attempts: number; upstreamRequests: number };
}

describe('shadowlap verify', () => {
  it('accepts a change that fixes the failing runs, held-out ones included, and keeps the good one', async () => {
    const { failed, heldOut, good } = await runs();
    const r = await shadowlap(['verify', '--fixes', failed, '--holdout', heldOut, '--keeps', 'label:good', '--expect', ORACLE, '--json'], { AGENT_SYSTEM: GOOD_FIX });
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Json;
    // The change here is the environment, in a folder git doesn't hold: there is no code before the
    // change to run the good run's baseline at, so it is judged by its gate on its own, and the
    // report says so (verify-baseline.test.ts verifies against a baseline).
    expect(report).toMatchObject({ verdict: 'accepted', reasons: [], summary: { targets: { passed: 1, total: 1 }, holdout: { passed: 1, total: 1 }, good: { passed: 1, total: 1 } } });
    expect(report.warnings).toEqual([`good run ${good.slice(0, 10)} was judged by the gate on its own, not against the code before the change: the working directory is not in a git repository, so there is no code before the change to compare a good run with`]);
    // A changed prompt changes the first request, so every run forks there and runs live: the gate,
    // which tells 90% or more from 70% or less, passes a run that always passes after 12 attempts.
    for (const run of report.runs) expect(run).toMatchObject({ outcome: run.role === 'good' ? 'kept' : 'fixed', passes: 12, attempts: 12, deterministic: false, decision: 'pass', rate: { decision: 'pass', sentence: 'passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts' } });
    expect(report).toMatchObject({ gate: { kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 80 }, attemptsPerRun: 80, passesNeeded: 12 });
    expect(report.runs.find((x) => x.runId === failed)!.recorded.passed).toBe(false);
    expect(report.runs.find((x) => x.runId === good)!.recorded.passed).toBe(true);
    // Nothing the attempts did reached the world: the outbox holds the three recordings' writes only.
    expect(outbox()).toHaveLength(3);
    // After the fork each attempt looked the order up live, was served the pure policy as recorded,
    // and had its write stubbed: escalate for the large order, which the recording never made, and
    // the small order's refund.
    for (const run of report.runs) for (const a of run.runs) expect(a.afterFork).toEqual({ recorded: 1, inOrder: 0, live: 1, stubbed: 1, blocked: 0 });

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
    // Three straight failures fail the gate. Each run's outcome, its tally and the bound; the rule once.
    expect(r.stdout).toMatch(/· good run \w{10} broken: 0 of 3 passed · rate <= 0\.71 \(95%\) \(the agent exited with code 1\)/);
    expect(r.stdout).toMatch(/good +\w{10} +broken +0 of 3 passed · rate <= 0\.71 \(95%\) +the agent exited with code 1/);
    expect(r.stdout).toMatch(/target +\w{10} +fixed +12 of 12 passed · rate >= 0\.73 \(95%\) +forked at #1/);
    expect(r.stdout).toContain("Its gate decides after each attempt (gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts); a clean replay settles it in one.");
    expect(r.stdout).not.toMatch(/at least|at most|of the time|% confidence/);
    // The mock's token counts grow with every answer it gave in this file, so the figures can be any size.
    expect(r.stdout).toMatch(/per run, as it would run live: [\d.,]+[kM]? → [\d.,]+[kM]? input tokens/);
    // The good run's attempts crashed on the third model call's answer (refund_order, a tool the agent
    // doesn't have), before any write: the 12 + 12 fixing attempts made 3 tool calls each, its 3 made 2.
    expect(r.stdout).toContain("after the fork, the change's 27 attempts made 78 tool calls: 27 answered as recorded, 27 ran live, 24 stubbed");
  });

  it('settles runs that replay clean with one free attempt each', async () => {
    const { failed, good } = await runs();
    const before = mock.requests.length;
    const r = await shadowlap(['verify', '--fixes', failed, '--keeps', good, '--expect', ORACLE, '--json']);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.verdict).toBe('rejected');
    expect(report.runs.map((x) => [x.outcome, x.attempts, x.deterministic, x.runs[0].forkedAt, x.runs[0].afterFork])).toEqual([
      ['not-fixed', 1, true, null, undefined],
      ['kept', 1, true, null, undefined],
    ]);
    expect(r.stdout).not.toContain('after the fork');
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
    // A copy of the agent to change, in a folder below a link to this repository's packages so its imports resolve.
    const folder = tempProject('sl-verify-agent-');
    const copy = join(folder, 'agent.mjs');
    copyFileSync(AGENT, copy);
    try {
      const r0 = await shadowlap(['run', '--', process.execPath, copy]);
      const failed = /recording run (\w{26})/.exec(r0.out)![1];
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
      removeTempProject(folder);
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

  it('verifies runs at once with --concurrency, each run\'s attempts one after another, so none runs past its gate\'s verdict', async () => {
    const { failed, heldOut, good } = await runs();
    // The first attempt to ask the model waits 2 s for its answer, holding back its own run alone.
    hold = { ms: 2_000, held: 0 };
    const r = await shadowlap(['verify', '--fixes', failed, '--holdout', heldOut, '--keeps', 'label:good', '--expect', ORACLE, '--concurrency', '3', '--json'], { AGENT_SYSTEM: GOOD_FIX });
    expect(r.code, r.out).toBe(0);
    expect(hold.held).toBe(1);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.verdict).toBe('accepted');
    // Each run's gate read its attempts as they ended, one after another: the 12 of 12 it takes
    // without --concurrency, and no attempt past them.
    for (const run of report.runs) expect(run).toMatchObject({ passes: 12, attempts: 12, decision: 'pass', rate: { sentence: 'passed · 12 of 12 · rate >= 0.73 (95%) · gate: tells 90%+ from 70%- at <= 5% risk, up to 80 attempts' } });
    const store = Store.open(db);
    try {
      const all = store.allRuns().filter((x) => x.meta?.verify);
      const of = (runId: string) => all.filter((x) => x.parentRunId === runId).sort((a, b) => a.meta!.repeat!.attempt - b.meta!.repeat!.attempt);
      for (const runId of [failed, heldOut, good]) {
        const attempts = of(runId);
        expect(attempts).toHaveLength(12);
        // Each started once the one before it had ended.
        attempts.slice(1).forEach((a, i) => expect(a.startedAt).toBeGreaterThanOrEqual(attempts[i].endedAt!));
      }
      // The runs went at once: another run's attempts ran while the held one waited.
      const held = all.reduce((x, y) => (y.endedAt! - y.startedAt > x.endedAt! - x.startedAt ? y : x));
      expect(held.endedAt! - held.startedAt).toBeGreaterThanOrEqual(2_000);
      expect(all.some((x) => x.parentRunId !== held.parentRunId && x.startedAt < held.endedAt! && x.endedAt! > held.startedAt)).toBe(true);
    } finally {
      store.close();
    }
  });
});
