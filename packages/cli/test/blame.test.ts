import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decide, Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext, type ScriptResult } from '@shadowlap-testing/mock-anthropic';
import { unpricedOnly } from '../src/blame.js';

/**
 * `shadowlap blame` through the CLI, on a support agent whose run turns on one decision: at its third
 * model call it either refunds $240 (against policy) or escalates. The mock plays the model. The
 * small model decides by turns, refunding on odd decisions and escalating on even ones, so asking it
 * again can rescue the run; "big-model" always escalates; with MOCK_STUBBORN the small one always
 * refunds. The recording, the first decision, refunds. With `hold` set, the mock keeps the next
 * request it gets waiting before it answers: one attempt slower than the rest.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: 0 } });

let mock: MockServer;
let work: string;
let db: string;
let decisions = 0;
let stubborn = false;
/** The next request the mock gets waits `ms` before its answer; `held` counts the requests it held. */
let hold: { ms: number; held: number } | null = null;

function script(ctx: ScriptContext): ScriptResult {
  const result = answer(ctx);
  if (!hold || hold.held) return result;
  hold.held++;
  return { ...result, delayMs: hold.ms };
}

function answer(ctx: ScriptContext): ScriptResult {
  if (JSON.stringify(ctx.request.system ?? '').includes('You play a customer')) return { message: message([text('Hi, I would like a refund on order A-1042, please.')], { stop_reason: 'end_turn' }) };
  const lastResult = JSON.stringify(ctx.request.messages.at(-1)?.content ?? '');
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([text('Looking the order up.'), toolUse('lookup_order', { order_id: 'A-1042' }, `toolu_lookup_${ctx.requestNo}`)]) };
    case 1:
      return { message: message([toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)]) };
    case 2: {
      decisions++;
      const escalates = ctx.request.model === 'big-model' || (!stubborn && decisions % 2 === 0);
      return {
        message: escalates
          ? message([text('Above the limit.'), toolUse('escalate', { reason: 'refund of $240 is above $100' }, `toolu_decide_${ctx.requestNo}`)])
          : message([toolUse('issue_refund', { order_id: 'A-1042', amount: 240 }, `toolu_decide_${ctx.requestNo}`)]),
      };
    }
    default:
      return { message: message([text(lastResult.includes('ticket') ? 'Escalated to a manager.' : 'Refunded $240.')], { stop_reason: 'end_turn' }) };
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
});
beforeEach(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  work = mkdtempSync(join(tmpdir(), 'fp-blame-'));
  db = join(work, 'store.db');
  decisions = 0;
  stubborn = false;
  hold = null;
});

/** `interrupt`: Ctrl-C once what it printed says so; `afterInterrupt` is how long it ran on after that, ms. */
function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}, o: { interrupt?: (out: string) => boolean } = {}): Promise<{ code: number | null; out: string; stdout: string; afterInterrupt: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd: work, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', AGENT_OUTBOX: join(work, 'outbox.jsonl'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let stdout = '';
    let interruptedAt: number | null = null;
    const interrupt = () => {
      if (interruptedAt !== null || !o.interrupt?.(out)) return;
      interruptedAt = Date.now();
      child.kill('SIGINT');
    };
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      stdout += d.toString();
      interrupt();
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
      interrupt();
    });
    child.on('exit', (code) => resolve({ code, out, stdout, afterInterrupt: interruptedAt === null ? null : Date.now() - interruptedAt }));
  });
}

async function record(env: NodeJS.ProcessEnv = {}): Promise<string> {
  const r = await shadowlap(['run', '--', process.execPath, AGENT], env);
  expect(r.code, r.out).toBe(0);
  return /recording run (\w{26})/.exec(r.out)![1]!;
}

const outbox = () => (existsSync(join(work, 'outbox.jsonl')) ? readFileSync(join(work, 'outbox.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { tool: string }) : []);

describe('shadowlap blame', () => {
  it('blames the model call that chose the refund, not the one where the run ended', async () => {
    const runId = await record();
    expect(outbox().map((e) => e.tool)).toEqual(['issue_refund']);
    const store = Store.open(db);
    const models = store.getCalls(runId).filter((c) => c.kind === 'api').map((c) => c.callNo);
    store.close();
    expect(models).toHaveLength(4);
    const [first, , decision, last] = models as [number, number, number, number];

    const r = await shadowlap(['blame', runId, '--expect', ORACLE]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('replays as recorded and fails: issue_refund called 0 times, but called 1 time');
    expect(r.stdout).toContain(`The run was lost at model call #${decision} (3 of 4)`);
    // Each probe is decided by blame's gate, which tells a rescue at 60% or more from lost at 10% or
    // less, 5% risk each: each says its verdict, its tally and the Wilson bound, the rule once.
    expect(r.stdout).toMatch(new RegExp(`The re-asked call #${decision}: rescued · \\d of \\d · rate >= 0\\.\\d\\d \\(95%\\); #${last}, the next model call: lost · 0 of 4 · rate <= 0\\.49 \\(95%\\)\\.`));
    expect(r.stdout).toContain('Probes (gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts; resample the probed call)');
    expect(r.stdout).not.toMatch(/at least|at most|of the time/);
    expect(r.stdout).toContain('Confidence: high');
    expect(r.stdout).toContain('issue_refund({"order_id":"A-1042","amount":240})');
    expect(r.stdout).toContain('"Above the limit.", escalate({"reason":"refund of $240 is above $100"})');
    expect(r.stdout).toMatch(new RegExp(`#${first} +1 of 4 .* rescued`));
    expect(r.stdout).toMatch(new RegExp(`#${decision} +3 of 4 .* rescued  ◂ blamed`));
    expect(r.stdout).toMatch(new RegExp(`#${last} +4 of 4 +0 of 4 passed · rate <= 0\\.49 \\(95%\\) +lost`));

    // Nothing a probe did reached the world: every refund and escalation after a fork was stubbed.
    expect(outbox().map((e) => e.tool)).toEqual(['issue_refund']);

    const after = Store.open(db);
    try {
      const blame = after.getRun(runId)!.meta!.blame!;
      expect(blame).toMatchObject({ outcome: 'blamed', callNo: decision, confidence: 'high', fields: {}, oracle: ['the agent exits 0', 'issue_refund called 0 times'] });
      const rescued = after.getRun(blame.rescuedRunId!)!;
      expect(rescued.meta?.probe).toEqual({ of: runId, callNo: decision, passed: true });
      expect(rescued.divergence).toMatchObject({ type: 'forced', callNo: decision });
      const fenced = after.getCalls(rescued.runId).filter((c) => c.name === 'escalate');
      expect(fenced.map((c) => c.origin)).toEqual(['stubbed']);
      // Probe attempts are bundled per probed call, as repeated attempts are.
      const attempts = after.allRuns().filter((x) => x.meta?.probe?.of === runId);
      expect(new Set(attempts.map((x) => x.meta!.repeat!.group)).size).toBe(blame.probes.length);
      // The baseline replay made to confirm the failure is not kept.
      expect(after.allRuns().filter((x) => x.parentRunId === runId && !x.meta?.probe)).toEqual([]);
    } finally {
      after.close();
    }

    const shown = await shadowlap(['show', runId]);
    expect(shown.stdout).toMatch(new RegExp(`blame: lost at model call #${decision} \\(high confidence\\), rescued by \\w{10}`));
    const rescuedId = /rescued fork: shadowlap diff \w+ (\w+)/.exec(r.stdout)![1]!;
    expect((await shadowlap(['show', rescuedId])).stdout).toContain(`an attempt of shadowlap blame ${runId.slice(0, 10)}, forked at model call #${decision}: passed`);
  });

  it('reports a failure no resample rescues, and finds it again with a stronger model', async () => {
    stubborn = true;
    const runId = await record();
    const plain = await shadowlap(['blame', runId, '--expect', ORACLE, '--json']);
    expect(plain.code, plain.out).toBe(0);
    const report = JSON.parse(plain.stdout) as Record<string, unknown> & { probes: Array<{ runs: unknown[] }> };
    expect(report).toMatchObject({ outcome: 'unrescuable', blamed: null, confidence: 'high', modelCalls: 4, passesNeeded: 2, attemptsPerProbe: 20, gate: { kind: 'sprt', good: 0.6, bad: 0.1, risk: 0.05, max: 20 }, rescue: { fields: {} } });
    expect(report.probes).toHaveLength(1);
    // Four straight failures: lost, as 2 of 5 would have called it.
    expect(report.probes[0]!.runs).toHaveLength(4);
    expect(report.probes[0]).toMatchObject({ rescued: false, decision: 'fail', rate: { decision: 'fail', sentence: 'lost · 0 of 4 · rate <= 0.49 (95%) · gate: rescue at 60%+, lost at 10%-, <= 5% risk, up to 20 attempts' } });

    const strong = await shadowlap(['blame', runId, '--expect', ORACLE, '--model', 'big-model', '--json']);
    expect(strong.code, strong.out).toBe(0);
    const found = JSON.parse(strong.stdout) as { outcome: string; blamed: { step: number; passes: number; attempts: number }; rescue: unknown; contrast: { rescued: Array<{ name?: string }> } };
    expect(found.outcome).toBe('blamed');
    expect(found.blamed).toMatchObject({ step: 3, passes: 2, attempts: 2 });
    expect(found.rescue).toEqual({ fields: { model: 'big-model' } });
    expect(found.contrast.rescued.map((b) => b.name).filter(Boolean)).toEqual(['escalate']);
    // Only the probed calls went to the stronger model.
    expect(mock.requests.filter((r) => r.body.model === 'big-model').length).toBeGreaterThan(0);
  });

  it('refuses a run that passes its oracle, and one that does not replay as recorded', async () => {
    const runId = await record();
    const passes = await shadowlap(['blame', runId]);
    expect(passes.code).toBe(1);
    expect(passes.out).toContain('passes its oracle when replayed (the agent exits 0), so there is no failure to blame');

    const drifted = await shadowlap(['blame', runId, '--expect', ORACLE, '--json'], { AGENT_SYSTEM: 'A different prompt.' });
    expect(drifted.code).toBe(1);
    const err = JSON.parse(drifted.stdout) as { outcome: string; error: { reason: string; message: string } };
    expect(err.outcome).toBe('error');
    expect(err.error.reason).toBe('diverged');
    expect(err.error.message).toContain('does not replay as recorded');
    expect(err.error.message).toContain(`shadowlap calibrate ${runId.slice(0, 10)}`);
  });

  it('refuses a run whose replay goes around Shadowlap', async () => {
    const runId = await record();
    const r = await shadowlap(['blame', runId, '--expect', ORACLE, '--json'], { SHADOWLAP_UPSTREAM_ANTHROPIC: '', SHADOWLAP_CAPTURE: 'off', AGENT_BASE_URL: mock.url });
    expect(r.code).toBe(1);
    const err = JSON.parse(r.stdout) as { error: { reason: string; message: string } };
    expect(err.error.reason).toBe('bypassed');
    expect(err.error.message).toContain('SHADOWLAP_UPSTREAM_OPENAI');
  });

  it('refuses a run that fails only because its model has no price, without a live request', async () => {
    const runId = await record();
    const before = mock.requests.length;
    const r = await shadowlap(['blame', runId, '--expect', JSON.stringify({ cost: '<= 1.00' }), '--json']);
    expect(r.code, r.out).toBe(1);
    const err = JSON.parse(r.stdout) as { outcome: string; error: { reason: string; message: string } };
    expect(err).toMatchObject({ outcome: 'error', error: { reason: 'unpriced' } });
    expect(err.error.message).toContain('fails only because small-model has no price, so the cost check can\'t be judged whatever the model answers. Add it under "prices" in shadowlap.config.json');
    expect(mock.requests.length).toBe(before);
  });

  it('tells a failure for want of a price from one that has another failure too', () => {
    const cost = { ok: false, label: 'cost at most $1.00', detail: 'no price for small-model, big-model; add it under "prices" in shadowlap.config.json' };
    const tool = { ok: false, label: 'issue_refund called 0 times', detail: 'called 1 time' };
    expect(unpricedOnly({ checks: [{ ok: true, label: 'escalate called', detail: null }, cost], failures: ['cost at most $1.00: no price …'] })).toEqual(['small-model', 'big-model']);
    expect(unpricedOnly({ checks: [cost, tool], failures: ['…', '…'] })).toBeNull();
    // A non-zero exit is a failure of its own.
    expect(unpricedOnly({ checks: [cost], failures: ['the agent exited with code 1', '…'] })).toBeNull();
    expect(unpricedOnly({ checks: [], failures: ['the agent exited with code 1'] })).toBeNull();
  });

  it('refuses a judge check no attempt can ask live, in blame, verify and repair, before anything runs', async () => {
    const runId = await record();
    const before = mock.requests.length;
    // Each attempt is a fork, whose judge is asked live: one on a provider with no key and no upstream can't be.
    const judged = JSON.stringify({ tools: { issue_refund: 0 }, judge: [{ name: 'explains', question: 'Does the reply say why the refund was escalated?', model: 'gemini-2.5-flash' }] });
    const noKey = { GEMINI_API_KEY: '', GOOGLE_API_KEY: '', SHADOWLAP_UPSTREAM_GEMINI: '' };
    for (const args of [['blame', runId], ['verify', '--fixes', runId], ['repair', '--fixes', runId]]) {
      const r = await shadowlap([...args, '--expect', judged], noKey);
      expect(r.code, r.out).toBe(1);
      expect(r.out).toContain('--expect has a check no attempt can decide: judge "explains" answers yes (an attempt is a fork, whose judge must be asked live: no key for gemini (GEMINI_API_KEY or GOOGLE_API_KEY))');
      expect(r.out).toContain(`so ${args[0]} would spend attempts to say nothing`);
    }
    expect(mock.requests.length).toBe(before);
  });

  it('refuses a run with a check it can\'t decide as recorded, after the free replay, without a live request', async () => {
    const runId = await record();
    const before = mock.requests.length;
    // The condition reads a field lookup_order's result doesn't have: whether it held can't be told,
    // on the recording or on any probe, so no probe could pass.
    const unreadable = JSON.stringify({ tools: { issue_refund: 0 }, when: [{ if: { tool: 'lookup_order', result: { totl: { '>': 100 } } }, then: { tools: { escalate: 1 } } }] });
    const r = await shadowlap(['blame', runId, '--expect', unreadable, '--json']);
    expect(r.code, r.out).toBe(1);
    const err = JSON.parse(r.stdout) as { outcome: string; error: { reason: string; message: string } };
    expect(err).toMatchObject({ outcome: 'error', error: { reason: 'inconclusive' } });
    expect(err.error.message).toMatch(/has a check that can't be decided as recorded, so no probe could pass whatever the model answers: when lookup_order has result\.totl > 100: escalate called 1 time \(could not tell whether the condition held: lookup_order #\d+: has no result\.totl\)/);
    expect(mock.requests.length).toBe(before);
  });

  it('stops at a budget and says what it found so far', async () => {
    writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ prices: { 'small-model': { input: 20000, output: 20000 } } }));
    const runId = await record();
    const r = await shadowlap(['blame', runId, '--expect', ORACLE, '--budget', '0.5']);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toContain('Stopped before the search finished: the budget of $0.50 is spent');
    expect(r.stdout).toContain('So far no probe had settled.');
    expect(r.stdout).toContain('Confidence: low');
    // The attempt that went over the budget counts: the report owns up to what was spent.
    expect(r.stdout).toMatch(/1 attempt · \d+ upstream requests · ≈\$\d+ spent/);
  });

  it('checks its flags before running anything', async () => {
    const runId = await record();
    const bad = await shadowlap(['blame', runId, '--expect', '{"tool":{}}']);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('--expect has an unknown key "tool"');
    const tooMany = await shadowlap(['blame', runId, '--attempts', '3', '--passes', '4']);
    expect(tooMany.out).toContain("--passes (4) can't be more than --attempts (3)");
    const both = await shadowlap(['blame', runId, '--model', 'a', '--set', 'model=b']);
    expect(both.out).toContain('--model and --set model=… both set the model');
    const allow = await shadowlap(['blame', runId, '--writes', 'allow']);
    expect(allow.out).toMatch(/--writes.*must be one of stub, block/);
  });

  it('probes only the calls of one scope, so a simulated user is never blamed', async () => {
    const r0 = await shadowlap(['run', '--', process.execPath, AGENT, 'A-1042', '--simulated-user']);
    expect(r0.code, r0.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(r0.out)![1]!;
    const store = Store.open(db);
    const calls = store.getCalls(runId).filter((c) => c.kind === 'api');
    store.close();
    expect(calls.map((c) => c.meta.scope)).toEqual(['user', 'agent', 'agent', 'agent', 'agent']);
    const agentCalls = calls.filter((c) => c.meta.scope === 'agent').map((c) => c.callNo);

    const scoped = await shadowlap(['blame', runId, '--expect', ORACLE, '--scope', 'agent', '--json']);
    expect(scoped.code, scoped.out).toBe(0);
    const report = JSON.parse(scoped.stdout) as { modelCalls: number; blamed: { callNo: number; step: number }; probes: Array<{ callNo: number }> };
    expect(report.modelCalls).toBe(4);
    expect(report.blamed).toMatchObject({ callNo: agentCalls[2], step: 3 });
    expect(report.probes.every((p) => agentCalls.includes(p.callNo))).toBe(true);

    const none = await shadowlap(['blame', runId, '--expect', ORACLE, '--scope', 'planner']);
    expect(none.out).toContain('made no model calls in scope planner (its scopes: user, agent)');
  });

  it('runs a probe\'s attempts at once with --concurrency, to the same verdict', async () => {
    const runId = await record();
    const r = await shadowlap(['blame', runId, '--expect', ORACLE, '--concurrency', '3', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as { outcome: string; blamed: { step: number } };
    expect(report.outcome).toBe('blamed');
    expect(report.blamed.step).toBe(3);
  });

  it('decides a probe once with --concurrency 2 and mixed outcomes, on the attempts in the order they started', async () => {
    // The small model alternates, so two attempts at once often end one passing, one failing.
    const runId = await record();
    const concurrency = 2;
    const r = await shadowlap(['blame', runId, '--expect', ORACLE, '--concurrency', String(concurrency), '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as { gate: SprtGateJson; probes: Array<{ decision: string; passes: number; rescued: boolean; runs: Array<{ passed: boolean }>; rate: { decision: string; sentence: string } }> };
    expect(report.probes.length).toBeGreaterThan(0);
    for (const p of report.probes) {
      // What it decided on: the first attempts to start, up to the one that settled it. An attempt
      // starts only while fewer than --concurrency have started that the gate hasn't read, so at most
      // concurrency - 1 ran past the one that settled it, however long any of them took.
      const on = Number(/^\w+ · \d+ of (\d+)/.exec(p.rate.sentence)![1]);
      const prefix = p.runs.slice(0, on).map((x) => x.passed);
      const decisions = prefix.map((_, i) => decide(prefix.slice(0, i + 1).filter(Boolean).length, i + 1, { kind: 'sprt', ...report.gate }));
      expect(decisions.slice(0, -1).every((d) => d === 'continue'), JSON.stringify(prefix)).toBe(true);
      expect(decisions.at(-1)).toBe(p.decision);
      expect(p.rate.decision).toBe(p.decision);
      expect(p.runs.length).toBeLessThanOrEqual(on + concurrency - 1);
      expect(p.rescued).toBe(p.decision === 'pass');
    }
  });

  it('starts no attempt the gate can\'t read yet while one runs slow, and decides as one after another would', async () => {
    // Every attempt fails, so no order they end in can change the verdict: lost, as without --concurrency.
    stubborn = true;
    const runId = await record();
    // The first attempt to ask the model waits 3 s for its answer: until it ends, the gate can read
    // no attempt that started after it.
    hold = { ms: 3_000, held: 0 };
    const concurrency = 2;
    const r = await shadowlap(['blame', runId, '--expect', ORACLE, '--concurrency', String(concurrency), '--json']);
    expect(r.code, r.out).toBe(0);
    expect(hold.held).toBe(1);
    const report = JSON.parse(r.stdout) as { outcome: string; probes: Array<{ decision: string; rescued: boolean; runs: Array<{ passed: boolean }>; rate: { sentence: string } }> };
    expect(report.outcome).toBe('unrescuable');
    expect(report.probes).toHaveLength(1);
    const p = report.probes[0]!;
    expect(p).toMatchObject({ decision: 'fail', rescued: false });
    expect(p.rate.sentence).toMatch(/^lost · 0 of 4 (\(and 1 more that ended after it decided\) )?· rate <= 0\.49 \(95%\)/);
    // While it ran, the other worker started no attempt the gate couldn't read yet, where it used to
    // start one after another until the held one ended: at most one ran past the four decided on.
    expect(p.runs.length).toBeLessThanOrEqual(4 + concurrency - 1);
    expect(p.runs.every((x) => !x.passed)).toBe(true);
  });

  it('ends promptly on Ctrl-C while an attempt waits for a slow one the gate must read first', async () => {
    stubborn = true;
    const runId = await record();
    // Held far longer than the test runs: only the interrupt can end the attempt.
    hold = { ms: 120_000, held: 0 };
    // Once an attempt after the first has ended, the worker that ran it waits for the held one.
    const waiting = (out: string) => [...out.matchAll(/\battempt (\d+) {2}/g)].some((m) => Number(m[1]) >= 2);
    const r = await shadowlap(['blame', runId, '--expect', ORACLE, '--concurrency', '2', '--json'], {}, { interrupt: waiting });
    expect(r.afterInterrupt, r.out).not.toBeNull();
    expect(r.afterInterrupt!, r.out).toBeLessThan(10_000);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as { outcome: string; stopReason: string; probes: unknown[] };
    expect(report).toMatchObject({ outcome: 'stopped', stopReason: 'interrupted', probes: [] });
  });
});

type SprtGateJson = { good: number; bad: number; risk: number; max: number };
