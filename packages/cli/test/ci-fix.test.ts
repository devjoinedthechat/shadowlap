import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type ScriptContext, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { branchName, fixSummary, planFixes, repairArgs, type ReportResult } from '../../../action/fix.mjs';

/**
 * Fix on failure in the GitHub Action, run as action.yml runs it, on the support agent in a git
 * repository of its own with a bare remote and a stand-in for gh. Its golden is a run that refunded
 * a $240 order against policy, and the config checks that no such refund happens, so the golden
 * fails a check on a clean replay. The mock plays the agent's model (which, asked again, escalates
 * every other time, and always under the fixed prompt) and the repairer.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const RUN = join(ROOT, 'action', 'run.mjs');
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const FIX = 'You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.';
const EXPECT = { tools: { issue_refund: { count: 0, args: { amount: 240 } } } };

let mock: MockServer;
let mode: 'refund' | 'alternate' = 'refund';
let decisions = 0;
let counter = 0;
let project: string;
let remote: string;
let bin: string;

function script(ctx: ScriptContext) {
  const system = JSON.stringify(ctx.request.system ?? '');
  const usage = { input_tokens: Math.round(JSON.stringify(ctx.request).length / 4), output_tokens: 30 };
  if (system.includes('You improve AI agents')) {
    const user = JSON.stringify(ctx.request.messages);
    const anchor = Number(/\[(\d+)\] system prompt, in [^:]+:/.exec(user.replace(/\\n/g, '\n'))?.[1]);
    return { message: message([text(JSON.stringify({ diagnosis: 'The prompt never says what the policy asks of large refunds.', candidates: [{ anchor, replace: FIX, strategy: 'Escalate refunds above the policy limit', why: 'Saying what to do above the limit makes the right tool clear.' }] }))], usage) };
  }
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([toolUse('lookup_order', { order_id: 'A-1042' }, `toolu_lookup_${ctx.requestNo}`)], usage) };
    case 1:
      return { message: message([toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)], usage) };
    case 2: {
      decisions++;
      const escalates = system.includes('escalate every refund above the limit') || (mode === 'alternate' && decisions % 2 === 0);
      return { message: escalates ? message([text('Above the limit.'), toolUse('escalate', { reason: 'above the refund limit' }, `toolu_decide_${ctx.requestNo}`)], usage) : message([toolUse('issue_refund', { order_id: 'A-1042', amount: 240 }, `toolu_decide_${ctx.requestNo}`)], usage) };
    }
    default:
      return { message: message([text('Done.')], { ...usage, stop_reason: 'end_turn' }) };
  }
}

const sh = (cwd: string, cmd: string, args: string[]) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const env = () => ({ ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'test-key', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', PATH: `${bin}${delimiter}${process.env.PATH}` });

function run(cmd: string[], extra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cmd, { cwd: project, env: { ...env(), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

async function action(inputs: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-cifix-'));
  const output = join(dir, 'output');
  const summary = join(dir, 'summary.md');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const vars: NodeJS.ProcessEnv = { SHADOWLAP_CLI: CLI, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir, INPUT_RECORDINGS: 'goldens/*', INPUT_WORKING_DIRECTORY: project, INPUT_GUARD: 'off', INPUT_STORE: join(dir, 'ci.db') };
  for (const [k, v] of Object.entries(inputs)) vars[`INPUT_${k}`] = v;
  const r = await run([RUN], vars);
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const result = { ...r, outputs, summary: readFileSync(summary, 'utf8') };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
});

beforeEach(async () => {
  // Inside this repository, so the agent's imports resolve; a git repository of its own.
  project = join(fileURLToPath(new URL('.', import.meta.url)), `.tmp-cifix-${process.pid}-${counter++}`);
  mkdirSync(project);
  copyFileSync(AGENT, join(project, 'agent.mjs'));
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n');
  sh(project, 'git', ['init', '-q', '-b', 'main']);
  sh(project, 'git', ['config', 'user.name', 'Test']);
  sh(project, 'git', ['config', 'user.email', 'test@example.com']);
  mode = 'refund';
  decisions = 0;
  const recorded = await run([CLI, 'run', '--', process.execPath, 'agent.mjs']);
  expect(recorded.code, recorded.out).toBe(0);
  const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
  expect((await run([CLI, 'pack', runId, 'goldens/refund-over-limit'])).code).toBe(0);
  writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund-over-limit': { expect: EXPECT } } }, null, 2));
  sh(project, 'git', ['add', '.']);
  sh(project, 'git', ['commit', '-q', '-m', 'agent and its golden']);
  remote = mkdtempSync(join(tmpdir(), 'sl-remote-'));
  sh(remote, 'git', ['init', '-q', '--bare']);
  sh(project, 'git', ['remote', 'add', 'origin', remote]);
  // A stand-in for gh: records how it was called and prints a pull request URL, as gh does.
  bin = mkdtempSync(join(tmpdir(), 'sl-gh-'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(bin, 'args')}"\necho https://github.com/example/agent/pull/7\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  mode = 'alternate';
});
afterEach(() => {
  for (const d of [project, remote, bin]) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

// The stand-in for gh is a shell script, which Windows won't run by name.
describe.skipIf(process.platform === 'win32')('fix on failure in the GitHub Action', () => {
  it('opens a pull request with the fix verify accepted when a golden fails its check, and merges nothing', async () => {
    const head = sh(project, 'git', ['rev-parse', 'HEAD']);
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic' });
    expect(r.code, r.out).toBe(1);
    expect(r.outputs).toMatchObject({ passed: '0', failed: '1', diverged: '0', 'checks-failed': '1', fixes: '1', 'fix-prs': 'https://github.com/example/agent/pull/7' });
    expect(r.out).toContain('::notice title=Shadowlap::refund-over-limit: opened https://github.com/example/agent/pull/7');

    // The branch has the fix and is on the remote; HEAD, the working tree and main are as they were.
    const branch = sh(project, 'git', ['branch', '--list', 'shadowlap/fix-*', '--format=%(refname:short)']);
    expect(branch).toMatch(/^shadowlap\/fix-refund-over-limit-[0-9a-z]{6}$/);
    expect(sh(project, 'git', ['show', `${branch}:agent.mjs`])).toContain(FIX);
    expect(sh(remote, 'git', ['rev-parse', branch])).toBe(sh(project, 'git', ['rev-parse', branch]));
    expect(sh(project, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(project, 'agent.mjs'), 'utf8')).not.toContain(FIX);
    expect(sh(project, 'git', ['status', '--porcelain'])).toBe('');
    const args = readFileSync(join(bin, 'args'), 'utf8').split('\n');
    expect(args.slice(0, 8)).toEqual(['pr', 'create', '--head', branch, '--base', 'main', '--title', 'Escalate refunds above the policy limit']);
    expect(readFileSync(args[9]!, 'utf8')).toContain('## Escalate refunds above the policy limit');

    expect(r.summary).toContain('### Shadowlap: 1 of 1 recording failed');
    expect(r.summary).toContain('### Shadowlap: 1 fix pull request opened');
    expect(r.summary).toMatch(/\| ✅ \| `refund-over-limit` \| \[Escalate refunds above the policy limit\]\(https:\/\/github\.com\/example\/agent\/pull\/7\) · verify: target 1 of 1 \| \$\d+\.\d\d of \$5\.00 \|/);
  });

  it('stops once the budget per failing golden is spent, and opens nothing', async () => {
    // Priced, so every live model call counts against the budget.
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ prices: { 'small-model': { input: 1000, output: 1000 } }, tests: { 'goldens/refund-over-limit': { expect: EXPECT } } }, null, 2));
    sh(project, 'git', ['commit', '-q', '-am', 'price the model']);
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '0.05', REPAIRER: 'anthropic', FAIL_ON_DIVERGENCE: 'false' });
    expect(r.code, r.out).toBe(0);
    expect(r.outputs).toMatchObject({ failed: '1', 'checks-failed': '1', fixes: '0', 'fix-prs': '' });
    expect(r.out).toContain('refund-over-limit: no fix pull request: the budget of $0.05 is spent');
    expect(r.summary).toMatch(/\| ❌ \| `refund-over-limit` \| no fix: the budget of \$0\.05 is spent \| \$\d+\.\d\d of \$0\.05 \|/);
    expect(sh(project, 'git', ['branch', '--list', 'shadowlap/fix-*'])).toBe('');
  });

  it('opens nothing from a detached HEAD, and says how to check out the branch', async () => {
    sh(project, 'git', ['checkout', '-q', '--detach']);
    const r = await action({ FIX_ON_FAILURE: 'true', REPAIRER: 'anthropic' });
    expect(r.outputs.fixes).toBe('0');
    expect(r.out).toContain('HEAD is detached, so there is no branch to open a fix against');
    expect(r.summary).toContain('ref: ${{ github.head_ref }}');
  });
});

describe('planning fixes from a test report', () => {
  const result = (over: Partial<ReportResult>): ReportResult => ({ name: 'refund-flow', golden: 'goldens/refund-flow', ok: false, failure: 'check', runId: '01K5CQ4V3H8M2XWQH6V3T9RB1D', runs: [{ runId: 'A', ok: false }, { runId: 'B', ok: true }, { runId: 'C', ok: false }], expect: { tools: { send_email: 0 } }, ...over });

  it('fixes failed checks only, with the failing attempts to fix and the passing ones to keep', () => {
    const plans = planFixes({ results: [result({}), result({ name: 'drift', failure: 'diverged' }), result({ name: 'crash', failure: 'exit' }), result({ name: 'unchecked', expect: null }), result({ name: 'fine', ok: true })] });
    expect(plans.map((p) => [p.result.name, p.skip])).toEqual([
      ['refund-flow', null],
      ['drift', 'diverged: never fixed automatically, because most divergences are intended. Update the golden or add a normalizer'],
      ['crash', 'the agent exited with an error, which is not an outcome check'],
      ['unchecked', 'its checks are not under "tests" in shadowlap.config.json'],
    ]);
    expect(plans[0]).toMatchObject({ fixes: ['A', 'C'], keeps: ['B'] });
    expect(branchName(result({}))).toBe('shadowlap/fix-refund-flow-t9rb1d');
    expect(repairArgs(plans[0], { db: '/tmp/ci.db', budget: 2, repairer: 'claude-code', expectFile: '/tmp/expect.json' })).toEqual(['--db', '/tmp/ci.db', 'repair', '--fixes', 'A', 'C', '--keeps', 'B', '--expect', '@/tmp/expect.json', '--budget', '2', '--repairer', 'claude-code', '--branch', 'shadowlap/fix-refund-flow-t9rb1d', '--pr', '--yes', '--json']);
  });

  it('writes the job summary', () => {
    const md = fixSummary([{ name: 'a|b', outcome: 'opened', pr: 'https://example.com/pr/1', title: 'Fix it', verify: 'target 1 of 1', spent: 0.84, why: null }, { name: 'drift', outcome: 'skipped', why: 'diverged: never fixed automatically', pr: null, spent: 0 }], 2);
    expect(md).toContain('### Shadowlap: 1 fix pull request opened');
    expect(md).toContain('| ✅ | `a\\|b` | [Fix it](https://example.com/pr/1) · verify: target 1 of 1 | $0.84 of $2.00 |');
    expect(md).toContain('| ➖ | `drift` | diverged: never fixed automatically |  |');
    expect(md).toContain('Nothing is merged');
    expect(fixSummary([], 2)).toBe('');
  });
});
