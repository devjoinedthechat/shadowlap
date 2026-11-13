import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { formatCheckReport } from '../src/commands/check.js';
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
  expect((await shadowlap(['label', runs.under, 'good'])).code).toBe(0);
  for (const [name, dir] of [['small', 'goldens/in-limit'], ['over', 'goldens/over-limit'], ['escalated', 'goldens/escalated']] as const) {
    const packed = await shadowlap(['pack', runs[name], dir]);
    expect(packed.code, packed.out).toBe(0);
  }
}, 120_000);

afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a calls rule through the CLI', () => {
  it('fails a replay that refunds above the looked-up amount, naming both values, and passes the same run below it', async () => {
    const over = await shadowlap(['replay', runs.over, '--expect', REFUND_RULE, '--summary-json', 'over-replay.json']);
    expect(over.code, over.out).toBe(1);
    expect(over.out).toContain('✗ 1 of 1 check failed (--expect)');
    expect(over.out).toMatch(/✗ every issue_refund call: after lookup_order, amount <= lookup_order\.result\.amount, but issue_refund #\d+: amount 300 > lookup_order\.result\.amount 240 \(#\d+\)/);
    const summary = JSON.parse(readFileSync(join(work, 'over-replay.json'), 'utf8')) as { checks: Array<Record<string, unknown>> };
    expect(summary.checks).toEqual([{ status: 'failed', ok: false, label: 'every issue_refund call: after lookup_order, amount <= lookup_order.result.amount', detail: expect.stringMatching(/^issue_refund #\d+: amount 300 > lookup_order\.result\.amount 240 \(#\d+\)$/) }]);

    const under = await shadowlap(['replay', runs.under, '--expect', REFUND_RULE]);
    expect(under.code, under.out).toBe(0);
    expect(under.out).toContain('✓ 1 check passed (--expect)');
  }, 60_000);

  it('judges recordings by a rule without replaying any: shadowlap check', async () => {
    const before = mock.requests.length;
    const r = await shadowlap(['check', runs.over, runs.under, runs.escalated, '--expect', REFUND_RULE, '--json']);
    expect(r.code, r.out).toBe(1);
    expect(mock.requests.length).toBe(before);
    const report = JSON.parse(r.stdout) as { expect: unknown; recordings: Array<{ runId: string; outcome: string; checks: Array<{ status: string; detail: string | null }> }>; counts: Record<string, number>; notes: string[]; unchecked: string[] };
    expect(report.expect).toEqual(JSON.parse(REFUND_RULE));
    expect(report.recordings.map((x) => [x.runId, x.outcome])).toEqual([
      [runs.over, 'failed'],
      [runs.under, 'passed'],
      [runs.escalated, 'passed'],
    ]);
    expect(report.recordings[0].checks[0].detail).toMatch(/amount 300 > lookup_order\.result\.amount 240/);
    expect(report.counts).toEqual({ passed: 2, failed: 1, inconclusive: 0, notApplicable: 0 });

    // Every recording in the store by default; a rule that fails a run labelled good says so.
    const strict = JSON.stringify({ calls: [{ tool: 'issue_refund', args: { amount: { '<=': 100 } } }] });
    const all = await shadowlap(['check', '--expect', strict]);
    expect(all.code).toBe(1);
    expect(all.out).toMatch(/4 recordings judged from what they recorded, nothing replayed: 2 failed, 2 passed/);
    expect(all.out).toContain(`! fails 1 recording labelled good: ${runs.under.slice(0, 10)}`);
    expect(all.out).toMatch(new RegExp(`✗ ${runs.under.slice(0, 10)}  good · node(\\.exe)? support-agent\\.mjs A-1042: failed`));
  }, 60_000);
});

describe('shadowlap check, named more than one way', () => {
  it('judges each recording once however it is named, the pack when it is one, and says a reason once', async () => {
    const r = await shadowlap(['check', runs.under, 'label:good', runs.over, 'goldens/over-limit', '--expect', REFUND_RULE, '--json']);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as { recordings: Array<{ runId: string; pack: string | null; outcome: string }>; counts: Record<string, number> };
    expect(report.recordings.map((x) => [x.runId, x.pack, x.outcome])).toEqual([
      [runs.under, null, 'passed'],
      [runs.over, 'goldens/over-limit', 'failed'],
    ]);
    expect(report.counts).toEqual({ passed: 1, failed: 1, inconclusive: 0, notApplicable: 0 });
    // A check on the output alone can't be settled from a recording: the line says why, once.
    const printed = await shadowlap(['check', runs.under, '--expect', JSON.stringify({ output: { includes: 'Done' } })]);
    expect(printed.code).toBe(3);
    expect(printed.out.match(/a check reads what the agent printed/g)).toHaveLength(1);
  }, 60_000);

  it('refuses a folder that is no pack in the words it always has, before reading anything from it', async () => {
    mkdirSync(join(work, 'not-a-pack'), { recursive: true });
    const r = await shadowlap(['check', 'not-a-pack', '--expect', REFUND_RULE]);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`${join(work, 'not-a-pack')}: no run.json: not a pack`);
  }, 60_000);

  it('words a recording that passed as every report does: a check that did not apply is not counted as passed', () => {
    const recording = { runId: '01K5CQ4V3H8M2XWQH6V3T9RB1D', pack: 'goldens/in-limit', labels: [], source: '--expect', outcome: 'passed' as const, why: [] };
    const passed = { status: 'passed' as const, ok: true, label: 'every issue_refund call: amount <= 100', detail: null };
    const notApplied = { status: 'not-applicable' as const, ok: true, label: 'when lookup_order has result.amount > 100: escalate called at least 1 time', detail: 'the condition never held: lookup_order #2: result.amount 40 <= 100' };
    const report = (checks: Array<typeof passed | typeof notApplied>) => formatCheckReport({ expect: null, recordings: [{ ...recording, checks }], counts: { passed: 1, failed: 0, inconclusive: 0, notApplicable: 0 }, unchecked: [], notes: [] });
    expect(report([passed, notApplied, notApplied])).toContain('goldens/in-limit: 1 check passed, 2 not applicable');
    expect(report([notApplied])).toContain('goldens/in-limit: 1 check not applicable');
    expect(report([])).toContain('goldens/in-limit: it exited 0, and no check applies to a recording');
  });

  it('counts a recording that no check applied to as not applicable in its totals, never as passed, and exits 0', async () => {
    const r = await shadowlap(['check', runs.small, runs.over, '--expect', JSON.stringify(ESCALATE), '--json']);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as { recordings: Array<{ runId: string; outcome: string }>; counts: Record<string, number> };
    expect(report.recordings.map((x) => [x.runId, x.outcome])).toEqual([
      [runs.small, 'passed'],
      [runs.over, 'failed'],
    ]);
    expect(report.counts).toEqual({ passed: 0, failed: 1, inconclusive: 0, notApplicable: 1 });
    const alone = await shadowlap(['check', runs.small, '--expect', JSON.stringify(ESCALATE)]);
    expect(alone.code, alone.out).toBe(0);
    expect(alone.out).toContain('1 recording judged from what it recorded, nothing replayed: 1 not applicable');
  }, 60_000);

  it('notes a value the checks read that none of the calls judged has, and the key it most likely meant', async () => {
    const misspelt = JSON.stringify({ when: [{ if: { tool: 'lookup_order', result: { amout: { '>': 100 } } }, then: { tools: { escalate: '>= 1' } } }] });
    const r = await shadowlap(['check', runs.over, runs.small, '--expect', misspelt, '--json']);
    expect(r.code, r.out).toBe(3);
    const report = JSON.parse(r.stdout) as { recordings: Array<{ outcome: string; checks: Array<{ status: string; detail: string }> }>; notes: string[] };
    expect(report.recordings.map((x) => x.outcome)).toEqual(['inconclusive', 'inconclusive']);
    expect(report.recordings[0].checks[0].detail).toMatch(/^could not tell whether the condition held: lookup_order #\d+: has no result\.amout$/);
    expect(report.notes).toEqual(['--expect.when[0].if.result["amout"] reads result.amout from lookup_order, which none of the 2 lookup_order calls judged has: did you mean amount?']);
  }, 60_000);
});

describe('a when rule through shadowlap test', () => {
  it('reports not applicable when its condition never held, in the terminal, the JSON and the job summary', async () => {
    config({ 'goldens/*': { expect: ESCALATE } });
    const r = await shadowlap(['test', 'goldens/in-limit', '--json', 'in-limit.json', '--markdown', 'in-limit.md', '--junit', 'in-limit.xml']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/✓ in-limit: .*, 2 checks not applicable/);
    const report = JSON.parse(readFileSync(join(work, 'in-limit.json'), 'utf8')) as { results: Array<{ ok: boolean; checks: Array<Record<string, unknown>> }> };
    expect(report.results[0].ok).toBe(true);
    expect(report.results[0].checks).toEqual([
      { status: 'not-applicable', ok: true, label: 'when lookup_order has result.amount > 100: escalate called at least 1 time', detail: expect.stringMatching(/^the condition never held: lookup_order #\d+: result\.amount 40 <= 100$/) },
      { status: 'not-applicable', ok: true, label: 'when lookup_order has result.amount > 100: issue_refund called 0 times', detail: expect.stringMatching(/^the condition never held/) },
    ]);
    expect(readFileSync(join(work, 'in-limit.md'), 'utf8')).toContain('| ✅ | `in-limit` | clean, 2 checks not applicable |');
    expect((JSON.parse(readFileSync(join(work, 'in-limit.json'), 'utf8')) as { results: Array<{ verdict: string }> }).results[0].verdict).toBe('passed');
    // A CI's JUnit view of a pass says what did not apply, rather than a plain pass.
    expect(readFileSync(join(work, 'in-limit.xml'), 'utf8')).toMatch(/<system-out><!\[CDATA\[– when lookup_order has result\.amount > 100: escalate called at least 1 time: not applicable · the condition never held: lookup_order #\d+: result\.amount 40 <= 100/);
    // The run it made counts its checks as they came out: none of them passed, two did not apply.
    const testRun = (JSON.parse(readFileSync(join(work, 'in-limit.json'), 'utf8')) as { results: Array<{ runId: string }> }).results[0].runId;
    const ls = await shadowlap(['ls', '--json']);
    const listed = (JSON.parse(ls.stdout) as Array<{ runId: string; checks: unknown }>).find((x) => x.runId === testRun);
    expect(listed?.checks).toEqual({ passed: 0, total: 2, notApplicable: 2 });
  }, 60_000);

  it('applies its checks when the condition held, and says where it held', async () => {
    const r = await shadowlap(['test', 'goldens/over-limit', 'goldens/escalated', '--json', 'over.json', '--markdown', 'over.md', '--junit', 'over.xml']);
    expect(r.code, r.out).toBe(1);
    expect(r.out).toMatch(/✗ over-limit: check failed: when lookup_order has result\.amount > 100: escalate called at least 1 time, but called 0 times; .*1 more check failed/);
    expect(r.out).toMatch(/✗ when lookup_order has result\.amount > 100: issue_refund called 0 times: called 1 time; the condition held at lookup_order #\d+ \(result\.amount 240 > 100\)/);
    expect(r.out).toMatch(/✓ escalated: .*, 2 checks passed/);
    const md = readFileSync(join(work, 'over.md'), 'utf8');
    // `#2` is the call's place, not an issue: split from its digits by an empty span, GitHub links no issue at it.
    expect(md).toMatch(/- ❌ when lookup_order has result\.amount > 100: issue_refund called 0 times: called 1 time; the condition held at lookup_order #<span><\/span>\d+ \(result\.amount 240 > 100\)/);
    // The JUnit failure carries the checks in its CDATA, as the terminal shows them.
    expect(readFileSync(join(work, 'over.xml'), 'utf8')).toContain('✗ when lookup_order has result.amount > 100: escalate called at least 1 time: called 0 times');
  }, 60_000);

  it('says inconclusive for a judge check with no verdict, which never passes', async () => {
    config({ 'goldens/escalated': { expect: { judge: [{ name: 'explains-escalation', question: 'Does the reply say why the refund was escalated?', model: 'claude-haiku-4-5' }] } } });
    const r = await shadowlap(['test', 'goldens/escalated', '--json', 'judged.json', '--markdown', 'judged.md']);
    expect(r.code, r.out).toBe(3);
    // The test runs offline: the golden holds no verdict, and the judge can't be asked.
    expect(r.out).toContain('? escalated: check inconclusive: judge "explains-escalation" answers yes, but not judged: no recorded verdict and the test runs offline');
    expect(r.out).toMatch(/0 passed, 0 failed, 1 inconclusive \(failing the run: --inconclusive warn lets them through\) · /);
    const report = JSON.parse(readFileSync(join(work, 'judged.json'), 'utf8')) as { failed: number; inconclusive: number; results: Array<{ ok: boolean; verdict: string; failure: string }> };
    expect(report).toMatchObject({ failed: 1, inconclusive: 1 });
    expect(report.results[0]).toMatchObject({ ok: false, verdict: 'inconclusive', failure: 'inconclusive' });
    expect(r.out).toContain('? judge "explains-escalation" answers yes: inconclusive · not judged: no recorded verdict and the test runs offline');
    const md = readFileSync(join(work, 'judged.md'), 'utf8');
    expect(md).toContain('- 🟡 judge "explains-escalation" answers yes: inconclusive · not judged: no recorded verdict and the test runs offline');
    expect(md).toContain('Inconclusive means a check could not be decided');
    expect(md).toContain('### Shadowlap: 0 of 1 golden passed · 1 inconclusive');
    expect(md).toContain('| 🟡 | `escalated` | check inconclusive: judge "explains-escalation" answers yes');
  }, 60_000);
});

describe('doctor on checks', () => {
  const doctor = () => runDoctor({ cwd: work, env: {}, version: '0.0.0', dbPath: join(work, 'store.db'), python: () => 'Python 3.12.1' }).filter((c) => c.name === 'check rules');
  const held = /\(\d+ packs? and \d+ runs? in the store\)/;

  it('names a rule\'s tool that no recording called or offered, and the one it most likely meant', () => {
    config({
      'goldens/over-limit': { expect: { tools: { send_emails: 0, escalate: 0 }, calls: [{ tool: 'issue_refund', after: 'lookup_orders' }], when: [{ if: { tool: 'escalate' }, then: { tools: { issue_refund: 0 } } }] } },
      'goldens/missing-*': { expect: { tools: { escalate: 1 } } },
    });
    const checks = doctor();
    const w = 'shadowlap.config.json: tests["goldens/over-limit"].expect';
    // The misspelt names, each with where it is and what it most likely meant. "Never call escalate",
    // and a condition on escalate, in a golden that never escalates, are what they say: other
    // recordings call escalate, so they are left alone.
    expect(checks.map((c) => c.detail.replace(held, '(…)'))).toEqual([
      `${w}.tools["send_emails"] names send_emails, which no recording called or offered to its model (…), so the count is of calls that never happen`,
      `${w}.calls[0].after names lookup_orders, which no recording called or offered to its model (…), so every call the rule checks fails it`,
      'tests["goldens/missing-*"] has checks but no recording: there is no pack that matches it',
    ]);
    expect(checks[0].detail).toMatch(held);
    expect(checks[1].fix).toBe('Did you mean lookup_order? Otherwise check the name: the recordings call escalate, issue_refund, lookup_order.');
    expect(checks.every((c) => c.verdict === 'warn')).toBe(true);
  });

  it('leaves alone a guard rule on a golden that never makes the call it guards', () => {
    // The escalation golden never refunds: a rule on its refunds guards against one, which is the point.
    config({ 'goldens/escalated': { fork: true, expect: { calls: [{ tool: 'issue_refund', after: 'lookup_order', args: { amount: { '<=': '@lookup_order.result.amount' } } }], when: [{ if: { tool: 'escalate' }, then: { tools: { issue_refund: 0 } } }] } }, 'goldens/*': { expect: ESCALATE } });
    const checks = doctor();
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ verdict: 'ok', detail: expect.stringMatching(/^every tool and value the checks name is in the recordings \(3 packs and \d+ runs in the store\)$/) });
  });

  it('names a value a rule reads that no recorded call of its tool has, and the key it most likely meant', () => {
    config({
      'goldens/*': {
        expect: {
          calls: [{ tool: 'issue_refund', args: { amount: { '<=': '@lookup_order.result.total' } } }],
          when: [{ if: { tool: 'lookup_order', result: { amout: { '>': 100 } } }, then: { tools: { escalate: '>= 1' } } }],
        },
      },
    });
    const checks = doctor();
    const w = 'shadowlap.config.json: tests["goldens/*"].expect';
    expect(checks.map((c) => [c.detail.replace(/\d+ recorded calls/, 'N recorded calls'), c.fix])).toEqual([
      [`${w}.calls[0].args["amount"]["<="] reads result.total from lookup_order, which none of its N recorded calls has, so a rule that reads it fails, or a condition that reads it is inconclusive`, 'Check the path: they have amount, order_id, status there.'],
      [`${w}.when[0].if.result["amout"] reads result.amout from lookup_order, which none of its N recorded calls has, so whether the condition held can't be told, and its checks read inconclusive`, 'Did you mean amount? Check the path: they have amount, order_id, status there.'],
    ]);
  });
});
