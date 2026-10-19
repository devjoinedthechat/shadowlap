import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { runDoctor } from '../src/doctor.js';

/**
 * The richer checks through the CLI, on real recordings of the support agent (its lookup_order
 * answers 240 for order A-1042 and 40 for B-7): a refund above the looked-up amount fails a
 * `calls` rule that reads it, naming both values, and the same rule passes a refund below it; a
 * `when` rule whose condition never held reads not applicable in `shadowlap test` and its reports;
 * `shadowlap check` judges recordings by a rule with nothing replayed; `doctor` names a rule's tool
 * no recording called. The mock plays the model and refunds what `refund` says, or escalates.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));

let refund: number | null = 300;

function script(ctx: ScriptContext) {
  const order = /order (\S+)\./.exec(JSON.stringify(ctx.request.messages[0]?.content ?? ''))?.[1] ?? 'A-1042';
  if (ctx.assistantTurns === 0) return { message: message([text('Looking the order up.'), toolUse('lookup_order', { order_id: order }, `toolu_lookup_${ctx.requestNo}`)]) };
  if (ctx.assistantTurns === 1) {
    return refund === null
      ? { message: message([text('Above the limit.'), toolUse('escalate', { reason: 'refund above $100' }, `toolu_escalate_${ctx.requestNo}`)]) }
      : { message: message([text('Refunding.'), toolUse('issue_refund', { order_id: order, amount: refund }, `toolu_refund_${ctx.requestNo}`)]) };
  }
  return { message: message([text('Done.')]) };
}

let mock: MockServer;
let work: string;
const runs: Record<string, string> = {};

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(work, 'store.db'), ...args], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(work, 'home') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

async function record(name: string, order: string, amount: number | null): Promise<void> {
  refund = amount;
  const r = await shadowlap(['run', '--summary-json', `${name}.json`, '--', process.execPath, AGENT, order]);
  expect(r.code, r.out).toBe(0);
  runs[name] = (JSON.parse(readFileSync(join(work, `${name}.json`), 'utf8')) as { summary: { runId: string } }).summary.runId;
}

const config = (tests: unknown) => writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [], redact: [], tests }, null, 2));

/** Every refund at most what the order came to, as lookup_order found it before. */
const REFUND_RULE = JSON.stringify({ calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.amount' } } }] });
/** Above the limit, escalate and don't refund. */
const ESCALATE = { when: [{ if: { tool: 'lookup_order', result: { amount: { '>': 100 } } }, then: { tools: { escalate: '>= 1', issue_refund: 0 } } }] };

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
  work = mkdtempSync(join(tmpdir(), 'sl-checks-cli-'));
  config({});
  await record('over', 'A-1042', 300);
  await record('under', 'A-1042', 200);
  await record('small', 'B-7', 40);
  await record('escalated', 'A-1042', null);
  expect((await shadowlap(['label', runs.under!, 'good'])).code).toBe(0);
  for (const [name, dir] of [['small', 'goldens/in-limit'], ['over', 'goldens/over-limit'], ['escalated', 'goldens/escalated']] as const) {
    const packed = await shadowlap(['pack', runs[name]!, dir]);
    expect(packed.code, packed.out).toBe(0);
  }
}, 120_000);

afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a calls rule through the CLI', () => {
  it('fails a replay that refunds above the looked-up amount, naming both values, and passes the same run below it', async () => {
    const over = await shadowlap(['replay', runs.over!, '--expect', REFUND_RULE, '--summary-json', 'over-replay.json']);
    expect(over.code, over.out).toBe(1);
    expect(over.out).toContain('✗ 1 of 1 check failed (--expect)');
    expect(over.out).toMatch(/✗ every issue_refund call: after lookup_order, amount <= lookup_order\.result\.amount, but issue_refund #\d+: amount 300 > lookup_order\.result\.amount 240 \(#\d+\)/);
    const summary = JSON.parse(readFileSync(join(work, 'over-replay.json'), 'utf8')) as { checks: Array<Record<string, unknown>> };
    expect(summary.checks).toEqual([{ status: 'failed', ok: false, label: 'every issue_refund call: after lookup_order, amount <= lookup_order.result.amount', detail: expect.stringMatching(/^issue_refund #\d+: amount 300 > lookup_order\.result\.amount 240 \(#\d+\)$/) }]);

    const under = await shadowlap(['replay', runs.under!, '--expect', REFUND_RULE]);
    expect(under.code, under.out).toBe(0);
    expect(under.out).toContain('✓ 1 check passed (--expect)');
  }, 60_000);

  it('judges recordings by a rule without replaying any: shadowlap check', async () => {
    const before = mock.requests.length;
    const r = await shadowlap(['check', runs.over!, runs.under!, runs.escalated!, '--expect', REFUND_RULE, '--json']);
    expect(r.code, r.out).toBe(1);
    expect(mock.requests.length).toBe(before);
    const report = JSON.parse(r.stdout) as { expect: unknown; recordings: Array<{ runId: string; outcome: string; checks: Array<{ status: string; detail: string | null }> }>; counts: Record<string, number>; notes: string[]; unchecked: string[] };
    expect(report.expect).toEqual(JSON.parse(REFUND_RULE));
    expect(report.recordings.map((x) => [x.runId, x.outcome])).toEqual([
      [runs.over, 'failed'],
      [runs.under, 'passed'],
      [runs.escalated, 'passed'],
    ]);
    expect(report.recordings[0]!.checks[0]!.detail).toMatch(/amount 300 > lookup_order\.result\.amount 240/);
    expect(report.counts).toEqual({ passed: 2, failed: 1, inconclusive: 0 });

    // Every recording in the store by default; a rule that fails a run labelled good says so.
    const strict = JSON.stringify({ calls: [{ tool: 'issue_refund', args: { amount: { '<=': 100 } } }] });
    const all = await shadowlap(['check', '--expect', strict]);
    expect(all.code).toBe(1);
    expect(all.out).toMatch(/4 recordings judged from what they recorded, nothing replayed: 2 failed, 2 passed/);
    expect(all.out).toContain(`! fails 1 recording labelled good: ${runs.under!.slice(0, 10)}`);
    expect(all.out).toMatch(new RegExp(`✗ ${runs.under!.slice(0, 10)}  good · node(\\.exe)? support-agent\\.mjs A-1042: failed`));
  }, 60_000);
});

describe('a when rule through shadowlap test', () => {
  it('reports not applicable when its condition never held, in the terminal, the JSON and the job summary', async () => {
    config({ 'goldens/*': { expect: ESCALATE } });
    const r = await shadowlap(['test', 'goldens/in-limit', '--json', 'in-limit.json', '--markdown', 'in-limit.md']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/✓ in-limit: .*, 2 checks not applicable/);
    const report = JSON.parse(readFileSync(join(work, 'in-limit.json'), 'utf8')) as { results: Array<{ ok: boolean; checks: Array<Record<string, unknown>> }> };
    expect(report.results[0]!.ok).toBe(true);
    expect(report.results[0]!.checks).toEqual([
      { status: 'not-applicable', ok: true, label: 'when lookup_order has result.amount > 100: escalate called at least 1 time', detail: expect.stringMatching(/^the condition never held: lookup_order #\d+: result\.amount 40 <= 100$/) },
      { status: 'not-applicable', ok: true, label: 'when lookup_order has result.amount > 100: issue_refund called 0 times', detail: expect.stringMatching(/^the condition never held/) },
    ]);
    expect(readFileSync(join(work, 'in-limit.md'), 'utf8')).toContain('| ✅ | `in-limit` | clean, 2 checks not applicable |');
  }, 60_000);

  it('applies its checks when the condition held, and says where it held', async () => {
    const r = await shadowlap(['test', 'goldens/over-limit', 'goldens/escalated', '--json', 'over.json', '--markdown', 'over.md', '--junit', 'over.xml']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ over-limit: check failed: when lookup_order has result\.amount > 100: escalate called at least 1 time, but called 0 times; .*1 more check failed/);
    expect(r.out).toMatch(/✗ when lookup_order has result\.amount > 100: issue_refund called 0 times: called 1 time; the condition held at lookup_order #\d+ \(result\.amount 240 > 100\)/);
    expect(r.out).toMatch(/✓ escalated: .*, 2 checks passed/);
    const md = readFileSync(join(work, 'over.md'), 'utf8');
    expect(md).toMatch(/- ❌ when lookup_order has result\.amount > 100: issue_refund called 0 times: called 1 time; the condition held at lookup_order #\d+ \(result\.amount 240 > 100\)/);
    // The JUnit failure carries the checks in its CDATA, as the terminal shows them.
    expect(readFileSync(join(work, 'over.xml'), 'utf8')).toContain('✗ when lookup_order has result.amount > 100: escalate called at least 1 time: called 0 times');
  }, 60_000);

  it('says inconclusive for a judge check with no verdict, which never passes', async () => {
    config({ 'goldens/escalated': { expect: { judge: [{ name: 'explains-escalation', question: 'Does the reply say why the refund was escalated?', model: 'claude-haiku-4-5' }] } } });
    const r = await shadowlap(['test', 'goldens/escalated', '--json', 'judged.json', '--markdown', 'judged.md']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain('✗ escalated: check inconclusive: judge "explains-escalation" answers yes, but not judged: no recorded verdict and no key for anthropic');
    expect(r.out).toContain('? judge "explains-escalation" answers yes: inconclusive · not judged: no recorded verdict and no key for anthropic');
    const md = readFileSync(join(work, 'judged.md'), 'utf8');
    expect(md).toContain('- ⚠️ judge "explains-escalation" answers yes: inconclusive · not judged: no recorded verdict and no key for anthropic');
    expect(md).toContain('An inconclusive check could not be decided');
  }, 60_000);
});

describe('doctor on checks', () => {
  it('names a rule\'s tool that no recording called, and the one it most likely meant', () => {
    config({
      'goldens/over-limit': { expect: { tools: { send_emails: 0, escalate: 0 }, calls: [{ tool: 'issue_refund', after: 'lookup_orders' }], when: [{ if: { tool: 'escalate' }, then: { tools: { issue_refund: 0 } } }] } },
      'goldens/missing-*': { expect: { tools: { escalate: 1 } } },
    });
    const checks = runDoctor({ cwd: work, env: {}, version: '0.0.0', dbPath: join(work, 'store.db'), python: () => 'Python 3.12.1' }).filter((c) => c.name === 'check rules');
    const w = 'shadowlap.config.json: tests["goldens/over-limit"].expect';
    // The misspelt names, each with where it is and what it most likely meant; "never call escalate"
    // on a tool the agent has is what it says, and is left alone.
    expect(checks.map((c) => c.detail)).toEqual([
      `${w}.tools["send_emails"] names send_emails, which goldens/over-limit never called or offered to the model`,
      `${w}.calls[0].after names lookup_orders, which goldens/over-limit never called or offered to the model`,
      `${w}.when[0].if.tool names escalate, which goldens/over-limit never called, so the condition never holds there and the rule is not applicable`,
      'tests["goldens/missing-*"] has checks but no recording: there is no pack that matches it',
    ]);
    expect(checks[1]!.fix).toBe('Did you mean lookup_order? Otherwise check the name: they call issue_refund, lookup_order.');
    expect(checks.every((c) => c.verdict === 'warn')).toBe(true);

    config({ 'goldens/*': { expect: ESCALATE } });
    expect(runDoctor({ cwd: work, env: {}, version: '0.0.0', dbPath: join(work, 'store.db'), python: () => 'Python 3.12.1' }).filter((c) => c.name === 'check rules')).toEqual([
      { name: 'check rules', verdict: 'ok', detail: 'every tool the checks name is called in their recordings (3 recordings)' },
    ]);
  });
});
