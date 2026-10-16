import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type ScriptContext, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { branchName, cannotPush, fixSummary, goldenNote, planFixes, refreshGolden, repairArgs, type ReportResult } from '../../../action/fix.mjs';
import { startFakeS3 } from '../../remote/test/fakes/s3.js';

/**
 * Fix on failure in the GitHub Action, run as action.yml runs it, on the support agent in a git
 * repository of its own with a bare remote and a stand-in for gh. Its golden is a run that refunded
 * a $240 order against policy, and the config checks that no such refund happens, so the golden
 * fails a check on a clean replay. The mock plays the agent's model (which, asked again, escalates
 * every other time, and always under the fixed prompt) and the repairer. The pull request's own
 * checks are `shadowlap test` on its branch, which the tests run too.
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
let project = '';
let remote = '';
let bin = '';

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

async function action(inputs: Record<string, string>, extraEnv: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sl-cifix-'));
  const output = join(dir, 'output');
  const summary = join(dir, 'summary.md');
  writeFileSync(output, '');
  writeFileSync(summary, '');
  const vars: NodeJS.ProcessEnv = { SHADOWLAP_CLI: CLI, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: dir, INPUT_RECORDINGS: 'goldens/*', INPUT_WORKING_DIRECTORY: project, INPUT_GUARD: 'off', INPUT_STORE: join(dir, 'ci.db') };
  for (const [k, v] of Object.entries(inputs)) vars[`INPUT_${k}`] = v;
  const r = await run([RUN], { ...vars, ...extraEnv });
  const outputs = Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  // The fixes CI's store kept, as `fix ls --json` lists them: where each came from.
  const listed = await run([CLI, '--db', join(dir, 'ci.db'), 'fix', 'ls', '--json']);
  const fixes = listed.code === 0 ? (JSON.parse(listed.out.slice(listed.out.indexOf('{'))) as { fixes: Array<{ fixId: string; source: string | null; status: string }> }).fixes : [];
  // Every run CI's store holds: the replays, blame's probes, repair's and verify's runs.
  const ls = await run([CLI, '--db', join(dir, 'ci.db'), 'ls', '--json', '-n', '100000']);
  const runs = ls.code === 0 ? (JSON.parse(ls.out.slice(ls.out.indexOf('['))) as Array<{ runId: string }>).map((x) => x.runId) : [];
  const result = { ...r, outputs, summary: readFileSync(summary, 'utf8'), fixes, runs };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
});

/** The agent and its golden, committed, with a remote to push to and gh standing by. `agent` rewrites the agent's source. */
async function setUp(tests: Record<string, unknown>, agent: (source: string) => string = (x) => x): Promise<void> {
  // Outside this repository, so an interrupted run never leaves a nested one behind in it; the
  // agent's imports resolve through this repository's node_modules, linked in and ignored.
  project = mkdtempSync(join(tmpdir(), `sl-cifix-${counter++}-`));
  symlinkSync(join(ROOT, 'node_modules'), join(project, 'node_modules'), process.platform === 'win32' ? 'junction' : undefined);
  writeFileSync(join(project, 'agent.mjs'), agent(readFileSync(AGENT, 'utf8')));
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\nnode_modules\n');
  sh(project, 'git', ['init', '-q', '-b', 'main']);
  sh(project, 'git', ['config', 'user.name', 'Test']);
  sh(project, 'git', ['config', 'user.email', 'test@example.com']);
  mode = 'refund';
  decisions = 0;
  const recorded = await run([CLI, 'run', '--', process.execPath, 'agent.mjs']);
  expect(recorded.code, recorded.out).toBe(0);
  const runId = /recording run (\w{26})/.exec(recorded.out)![1]!;
  expect((await run([CLI, 'pack', runId, 'goldens/refund-over-limit'])).code).toBe(0);
  writeFileSync(join(project, 'goldens', 'refund-over-limit', 'README.md'), 'Refunds above the limit are escalated.\n');
  writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund-over-limit': tests } }, null, 2));
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
}

afterEach(() => {
  for (const d of [project, remote, bin]) if (d) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  project = remote = bin = '';
});

// The stand-in for gh is a shell script, which Windows won't run by name.
describe.skipIf(process.platform === 'win32')('fix on failure in the GitHub Action', () => {
  it('opens a pull request with the fix verify accepted and the golden re-recorded under it, whose own checks pass, and merges nothing', async () => {
    await setUp({ expect: EXPECT });
    const head = sh(project, 'git', ['rev-parse', 'HEAD']);
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic' });
    expect(r.code, r.out).toBe(1);
    expect(r.outputs).toMatchObject({ passed: '0', failed: '1', diverged: '0', 'checks-failed': '1', fixes: '1', 'fix-prs': 'https://github.com/example/agent/pull/7' });
    expect(r.out).toContain('::notice title=Shadowlap::refund-over-limit: opened https://github.com/example/agent/pull/7');
    // The fix in CI's store names the pull request it went to, as Fixes shows it.
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes[0]).toMatchObject({ status: 'verified' });
    expect(r.fixes[0]!.source).toMatch(/PR #7$/);

    // The branch has the fix and is on the remote; HEAD, the working tree and main are as they were.
    const branch = sh(project, 'git', ['branch', '--list', 'shadowlap/fix-*', '--format=%(refname:short)']);
    expect(branch).toMatch(/^shadowlap\/fix-refund-over-limit-[0-9a-z]{6}$/);
    expect(sh(project, 'git', ['show', `${branch}:agent.mjs`])).toContain(FIX);
    expect(sh(remote, 'git', ['rev-parse', branch])).toBe(sh(project, 'git', ['rev-parse', branch]));
    expect(sh(project, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(readFileSync(join(project, 'agent.mjs'), 'utf8')).not.toContain(FIX);
    expect(sh(project, 'git', ['status', '--porcelain'])).toBe('');
    // One commit: the fix, with the golden re-recorded under it; the golden's own README stays.
    expect(sh(project, 'git', ['rev-list', '--count', `main..${branch}`])).toBe('1');
    const changed = sh(project, 'git', ['diff', '--name-only', 'main', branch]).split('\n');
    expect(changed).toEqual(expect.arrayContaining(['agent.mjs', 'goldens/refund-over-limit/run.json', 'goldens/refund-over-limit/calls.jsonl']));
    expect(changed.every((f) => f === 'agent.mjs' || /^goldens\/refund-over-limit\/(run\.json|calls\.jsonl|blobs\/[0-9a-f]{64})$/.test(f)), changed.join('\n')).toBe(true);
    expect(sh(project, 'git', ['show', `${branch}:goldens/refund-over-limit/README.md`])).toBe('Refunds above the limit are escalated.');
    expect(sh(project, 'git', ['log', '-1', '--format=%B', branch])).toContain('goldens/refund-over-limit is re-recorded under the fix, from the run verify accepted');
    const args = readFileSync(join(bin, 'args'), 'utf8').split('\n');
    expect(args.slice(0, 8)).toEqual(['pr', 'create', '--head', branch, '--base', 'main', '--title', 'Escalate refunds above the policy limit']);
    const body = readFileSync(args[9]!, 'utf8');
    expect(body).toContain('## Escalate refunds above the policy limit');
    expect(body).toContain("`goldens/refund-over-limit` is re-recorded under the fix: the recording verify accepted replaces its pack in this branch, and it replays clean here, so this pull request's own checks pass.");

    expect(r.summary).toContain('### Shadowlap: 1 of 1 recording failed');
    expect(r.summary).toContain('### Shadowlap: 1 fix pull request opened');
    expect(r.summary).toMatch(/\| ✅ \| `refund-over-limit` \| \[Escalate refunds above the policy limit\]\(https:\/\/github\.com\/example\/agent\/pull\/7\) · verify: target 1 of 1 · golden re-recorded \| \$\d+\.\d\d of \$5\.00 \|/);

    // The pull request's own checks: shadowlap test on its branch, offline, passes.
    sh(project, 'git', ['checkout', '-q', branch]);
    const hits = mock.requests.length;
    const onBranch = await run([CLI, '--db', ':memory:', 'test', 'goldens/*']);
    expect(onBranch.code, onBranch.out).toBe(0);
    expect(onBranch.out).toMatch(/✓ refund-over-limit: \d+\/\d+ replayed/);
    expect(mock.requests.length).toBe(hits);
  });

  it('with push, sends the test runs and the fix with every run it made to the team store, for teammates to pull', async () => {
    const key = 'AKIDCIFIXEXAMPLE';
    const s3 = await startFakeS3({ keys: { [key]: 'ci/secret' }, bucket: 'northwind-agent-runs', versioning: 'Enabled' });
    try {
      await setUp({ expect: EXPECT });
      // The team store, as shadowlap store set writes it, committed for CI to see.
      const config = JSON.parse(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ ...config, store: `s3://northwind-agent-runs/team?endpoint=${s3.url}` }, null, 2));
      sh(project, 'git', ['commit', '-qam', 'Keep the runs in the team store']);
      const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic', PUSH: 'true' }, { AWS_ACCESS_KEY_ID: key, AWS_SECRET_ACCESS_KEY: 'ci/secret', GITHUB_ACTIONS: 'true' });
      expect(r.outputs).toMatchObject({ failed: '1', fixes: '1' });
      expect(r.out).toContain('the fix was sent to the team store');
      expect(r.summary).toMatch(/golden re-recorded · in the team store \|/);
      const keys = [...s3.objects.keys()];
      // test --push sent the session's report; push --all every run the job made, the fix's among them.
      expect(keys.some((k) => k.startsWith('team/tests/'))).toBe(true);
      expect(r.runs.length).toBeGreaterThan(1);
      for (const runId of r.runs) expect(keys, runId).toContain(`team/runs/${runId}/run.json`);
    } finally {
      await s3.close();
    }
  });

  it('says why a fix stays in the job when no team store is set, or the team turned pushing from CI off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-cifix-push-'));
    try {
      expect(cannotPush(dir)).toBe('no team store is set in shadowlap.config.json (shadowlap store set <url>)');
      writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ store: 's3://northwind-agent-runs/team', ciPush: false }));
      expect(cannotPush(dir)).toBe('Push from CI is off ("ciPush": false in shadowlap.config.json)');
      writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify({ store: 's3://northwind-agent-runs/team' }));
      expect(cannotPush(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a golden that may fork as it is: on the branch it passes on its checks', async () => {
    await setUp({ fork: true, expect: EXPECT });
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic' });
    expect(r.outputs).toMatchObject({ failed: '1', 'checks-failed': '1', fixes: '1' });
    const branch = sh(project, 'git', ['branch', '--list', 'shadowlap/fix-*', '--format=%(refname:short)']);
    expect(sh(project, 'git', ['diff', '--name-only', 'main', branch])).toBe('agent.mjs');
    const body = readFileSync(readFileSync(join(bin, 'args'), 'utf8').split('\n')[9]!, 'utf8');
    expect(body).toContain('`goldens/refund-over-limit` may fork, so it passes on its checks with the fix as it is.');
    expect(r.summary).not.toContain('· golden');
    sh(project, 'git', ['checkout', '-q', branch]);
    // Live from the fork, where this agent escalates: its writes are stubbed, as such a project's CI sets them.
    const onBranch = await run([CLI, '--db', ':memory:', 'test', 'goldens/*', '--writes', 'stub']);
    expect(onBranch.code, onBranch.out).toBe(0);
    expect(onBranch.out).toMatch(/✓ refund-over-limit: forked at call 1/);
  });

  it('opens the pull request with the golden as it was when the fixed agent\'s recording won\'t replay clean, and says how to update it', async () => {
    // Once fixed, this agent sends a fresh value on every run, so the recording verify accepted diverges offline.
    const askLine = 'const ask = (request) => (simulated ? scope(\'agent\', () => client.messages.create(request)) : client.messages.create(request));';
    await setUp({ expect: EXPECT }, (source) => {
      expect(source).toContain(askLine);
      return source.replace(askLine, 'const ask = (request) => client.messages.create(/escalate every refund/.test(request.system) ? { ...request, metadata: { user_id: Math.random().toString(36).slice(2) } } : request);');
    });
    const golden = readFileSync(join(project, 'goldens', 'refund-over-limit', 'run.json'), 'utf8');
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic' });
    expect(r.outputs).toMatchObject({ failed: '1', fixes: '1', 'fix-prs': 'https://github.com/example/agent/pull/7' });
    expect(r.out).toContain('goldens/refund-over-limit not re-recorded on shadowlap/fix-');
    const branch = sh(project, 'git', ['branch', '--list', 'shadowlap/fix-*', '--format=%(refname:short)']);
    expect(sh(project, 'git', ['diff', '--name-only', 'main', branch])).toBe('agent.mjs');
    const body = readFileSync(readFileSync(join(bin, 'args'), 'utf8').split('\n')[9]!, 'utf8');
    expect(body).toContain('`goldens/refund-over-limit` still holds the recording made before the fix, which sends the old prompt, so it diverges on this branch.');
    expect(body).toContain('shadowlap test goldens/refund-over-limit --update');
    expect(body).toMatch(/It was not re-recorded automatically: the recording verify accepted does not replay clean on the branch \(refund-over-limit: diverged at call 1/);
    expect(r.summary).toContain('· golden not re-recorded: run `shadowlap test goldens/refund-over-limit --update` on the branch');
    // The check ran in the working tree and left it as it was: the old golden, without the fix.
    expect(sh(project, 'git', ['status', '--porcelain'])).toBe('');
    expect(readFileSync(join(project, 'goldens', 'refund-over-limit', 'run.json'), 'utf8')).toBe(golden);
    expect(readFileSync(join(project, 'agent.mjs'), 'utf8')).not.toContain(FIX);
  });

  it('stops once the budget per failing golden is spent, and opens nothing', async () => {
    await setUp({ expect: EXPECT });
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
    await setUp({ expect: EXPECT });
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
    // The branch is pushed and the pull request opened once the golden is re-recorded on it, not by repair.
    expect(repairArgs(plans[0], { db: '/tmp/ci.db', budget: 2, repairer: 'claude-code', expectFile: '/tmp/expect.json' })).toEqual(['--db', '/tmp/ci.db', 'repair', '--fixes', 'A', 'C', '--keeps', 'B', '--expect', '@/tmp/expect.json', '--budget', '2', '--repairer', 'claude-code', '--branch', 'shadowlap/fix-refund-flow-t9rb1d', '--yes', '--json']);
  });

  it('writes the job summary', () => {
    const md = fixSummary([
      { name: 'a|b', outcome: 'opened', pr: 'https://example.com/pr/1', title: 'Fix it', verify: 'target 1 of 1', spent: 0.84, why: null, goldenState: { state: 'recorded', golden: 'goldens/a', why: null } },
      { name: 'c', outcome: 'opened', pr: 'https://example.com/pr/2', title: 'Fix c', verify: null, spent: 0.5, why: null, goldenState: { state: 'stale', golden: 'goldens/c', why: 'the fix does not apply to the working tree' } },
      { name: 'drift', outcome: 'skipped', why: 'diverged: never fixed automatically', pr: null, spent: 0 },
    ], 2);
    expect(md).toContain('### Shadowlap: 2 fix pull requests opened');
    expect(md).toContain('| ✅ | `a\\|b` | [Fix it](https://example.com/pr/1) · verify: target 1 of 1 · golden re-recorded | $0.84 of $2.00 |');
    expect(md).toContain('| ✅ | `c` | [Fix c](https://example.com/pr/2) · golden not re-recorded: run `shadowlap test goldens/c --update` on the branch | $0.50 of $2.00 |');
    expect(md).toContain('| ➖ | `drift` | diverged: never fixed automatically |  |');
    expect(md).toContain('Nothing is merged');
    expect(fixSummary([], 2)).toBe('');
  });

  it('re-records only a golden that must replay exactly, and only from a recording repair kept', () => {
    const base = { cli: CLI, workdir: tmpdir(), env: process.env, scratch: tmpdir() };
    expect(refreshGolden({ ...base, result: { name: 'x', dir: 'goldens/x', mode: 'fork', ok: false }, repair: { output: { goldens: ['g'], patch: 'p', branch: 'b' } } })).toEqual({ state: 'fork', golden: 'goldens/x', why: null });
    expect(refreshGolden({ ...base, result: { name: 'x', dir: 'goldens\\x\\', mode: 'replay', ok: false }, repair: { output: { goldens: [], patch: 'p', branch: 'b' } } })).toEqual({ state: 'stale', golden: 'goldens/x', why: 'repair kept no recording of the fixed run' });
  });

  it('tells the pull request how to update a golden it could not re-record', () => {
    const note = goldenNote({ state: 'stale', golden: 'goldens/refund-flow', why: 'the recording verify accepted does not replay clean on the branch (refund-flow: diverged at call 4)' });
    expect(note).toContain('`goldens/refund-flow` still holds the recording made before the fix, which sends the old prompt, so it diverges on this branch.');
    expect(note).toContain('shadowlap test goldens/refund-flow --update');
    expect(note).toContain('It was not re-recorded automatically: the recording verify accepted does not replay clean on the branch (refund-flow: diverged at call 4).');
  });
});
