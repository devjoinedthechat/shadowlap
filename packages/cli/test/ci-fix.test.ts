import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type ScriptContext, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { branchName, branchNote, cannotPush, fixSummary, forkPullRequest, goldenNote, groupFixes, planFixes, pushFix, pushLine, refreshGoldens, repairArgs, type ReportResult } from '../../../action/fix.mjs';
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
/** None of the AWS credentials of the machine running the tests reaches a job given this; nor does an instance role. */
const NO_AWS: NodeJS.ProcessEnv = {
  AWS_ACCESS_KEY_ID: undefined,
  AWS_SECRET_ACCESS_KEY: undefined,
  AWS_SESSION_TOKEN: undefined,
  AWS_PROFILE: undefined,
  AWS_DEFAULT_PROFILE: undefined,
  AWS_CONFIG_FILE: undefined,
  AWS_SHARED_CREDENTIALS_FILE: undefined,
  AWS_ROLE_ARN: undefined,
  AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
  AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
  AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
  AWS_EC2_METADATA_DISABLED: 'true',
};

let mock: MockServer;
let mode: 'refund' | 'alternate' | 'escalate' = 'refund';
/** An order the model refunds whatever its prompt says, so no prompt fix repairs a run about it. */
let stubborn: string | null = null;
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
      const refunds = stubborn !== null && JSON.stringify(ctx.request.messages).includes(stubborn);
      const escalates = !refunds && (system.includes('escalate every refund above the limit') || mode === 'escalate' || (mode === 'alternate' && decisions % 2 === 0));
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
  stubborn = null;
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
  // A stand-in for gh: records how it was last called, and that it was, and prints a pull request URL, as gh does.
  bin = mkdtempSync(join(tmpdir(), 'sl-gh-'));
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(bin, 'args')}"\necho "$1 $2" >> "${join(bin, 'calls')}"\necho https://github.com/example/agent/pull/7\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  mode = 'alternate';
}

/** Another golden beside the first: recorded with the model refunding or escalating, its checks under `tests` when given, committed. */
async function addGolden(name: string, order: string, as: 'refund' | 'escalate', tests?: Record<string, unknown>): Promise<void> {
  const was = mode;
  mode = as;
  const recorded = await run([CLI, 'run', '--', process.execPath, 'agent.mjs', order]);
  mode = was;
  expect(recorded.code, recorded.out).toBe(0);
  expect((await run([CLI, 'pack', /recording run (\w{26})/.exec(recorded.out)![1]!, `goldens/${name}`])).code).toBe(0);
  if (tests) {
    const config = JSON.parse(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')) as { tests: Record<string, unknown> };
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ ...config, tests: { ...config.tests, [`goldens/${name}`]: tests } }, null, 2));
  }
  sh(project, 'git', ['add', '.']);
  sh(project, 'git', ['commit', '-q', '-m', `golden ${name}`]);
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
    expect(body).toContain('`goldens/refund-over-limit` is re-recorded under the fix: the recording verify accepted replaces its pack in this branch, and it replays clean here.');
    expect(body).toContain("Every golden this job tested replays clean on this branch, so this pull request's own checks pass.");

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

  it('replays every other golden under the fix, and says which ones diverge on the branch rather than that its checks pass', async () => {
    await setUp({ expect: EXPECT });
    // A golden that passes as a plain replay: the fix changes the prompt every request carries, so it diverges under it.
    await addGolden('escalates', 'A-3001', 'escalate');
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic' });
    expect(r.outputs).toMatchObject({ passed: '1', failed: '1', fixes: '1' });
    expect(r.out).toContain('goldens/refund-over-limit re-recorded on shadowlap/fix-');
    expect(r.out).toMatch(/goldens\/escalates diverges on shadowlap\/fix-\S+ under the fix/);
    const body = readFileSync(readFileSync(join(bin, 'args'), 'utf8').split('\n')[9]!, 'utf8');
    expect(body).toContain('`goldens/refund-over-limit` is re-recorded under the fix');
    expect(body).toContain('another golden, which passed before it, diverges on this branch: `goldens/escalates`');
    expect(body).toContain('shadowlap test goldens/escalates --update');
    expect(body).not.toContain("this pull request's own checks pass");
    expect(r.summary).toContain('· golden re-recorded · 1 other golden diverges: run `shadowlap test goldens/escalates --update` on the branch');
    // As the pull request's own checks find it: the fixed golden replays clean, the other diverges.
    const branch = sh(project, 'git', ['branch', '--list', 'shadowlap/fix-*', '--format=%(refname:short)']);
    sh(project, 'git', ['checkout', '-q', branch]);
    const onBranch = await run([CLI, '--db', ':memory:', 'test', 'goldens/*']);
    expect(onBranch.code).toBe(1);
    expect(onBranch.out).toMatch(/✓ refund-over-limit: /);
    expect(onBranch.out).toMatch(/✗ escalates: diverged at call 1/);
  });

  it('repairs goldens that fail the same check together, in one pull request that re-records each of them', async () => {
    await setUp({ expect: EXPECT });
    // A second golden that refunds against the same policy, under the same check: the same failure, so the same fix.
    // goldens/* lists it first.
    await addGolden('refund-again', 'A-2077', 'refund', { expect: EXPECT });
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic' });
    expect(r.outputs).toMatchObject({ passed: '0', failed: '2', 'checks-failed': '2', fixes: '1', 'fix-prs': 'https://github.com/example/agent/pull/7' });
    expect(r.out).toContain('shadowlap repair for goldens/refund-again and goldens/refund-over-limit, which fail the same check: blame, repair and verify, within $10.00');
    expect(r.out).toContain('::notice title=Shadowlap::refund-again, refund-over-limit: opened https://github.com/example/agent/pull/7');
    // One branch, pushed once; the one fix in CI's store holds both failures and names the pull request.
    const branch = sh(project, 'git', ['branch', '--list', 'shadowlap/fix-*', '--format=%(refname:short)']);
    expect(branch.split('\n')).toHaveLength(1);
    expect(sh(remote, 'git', ['branch', '--list', 'shadowlap/fix-*', '--format=%(refname:short)'])).toBe(branch);
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes[0]!.source).toMatch(/PR #7$/);
    // Both goldens are re-recorded in the fix's one commit, and the pull request's own checks pass on both.
    expect(sh(project, 'git', ['rev-list', '--count', `main..${branch}`])).toBe('1');
    const changed = sh(project, 'git', ['diff', '--name-only', 'main', branch]).split('\n');
    expect(changed).toEqual(expect.arrayContaining(['agent.mjs', 'goldens/refund-over-limit/run.json', 'goldens/refund-again/run.json']));
    expect(sh(project, 'git', ['log', '-1', '--format=%B', branch])).toContain('goldens/refund-again and goldens/refund-over-limit are re-recorded under the fix, from the runs verify accepted');
    const body = readFileSync(readFileSync(join(bin, 'args'), 'utf8').split('\n')[9]!, 'utf8');
    expect(body).toContain('### The goldens');
    expect(body).toContain('`goldens/refund-over-limit` is re-recorded under the fix');
    expect(body).toContain('`goldens/refund-again` is re-recorded under the fix');
    expect(body).toContain("Every golden this job tested replays clean on this branch, so this pull request's own checks pass.");
    expect(r.summary).toMatch(/\| ✅ \| `refund-again, refund-over-limit` \| .* · goldens re-recorded \| \$\d+\.\d\d of \$10\.00 \|/);
    sh(project, 'git', ['checkout', '-q', branch]);
    const onBranch = await run([CLI, '--db', ':memory:', 'test', 'goldens/*']);
    expect(onBranch.code, onBranch.out).toBe(0);
    expect(onBranch.out).toContain('2 passed');
  });

  it('when no fix repairs every golden that fails the same check, opens the one pull request for the golden one fix repairs, and names the other', async () => {
    await setUp({ expect: EXPECT });
    // A second golden under the same check, about an order the model refunds whatever the prompt says:
    // no prompt fix repairs it, so no patch fixes both. goldens/* lists it second.
    await addGolden('refund-vip', 'A-2077', 'refund', { expect: EXPECT });
    stubborn = 'A-2077';
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic' });
    expect(r.outputs).toMatchObject({ passed: '0', failed: '2', 'checks-failed': '2', fixes: '1', 'fix-prs': 'https://github.com/example/agent/pull/7' });
    expect(r.out).toContain('shadowlap repair for goldens/refund-over-limit and goldens/refund-vip, which fail the same check: blame, repair and verify, within $10.00');
    // Then each on its own, in order, within what is left, until one fix is accepted.
    expect(r.out).toMatch(/no fix was accepted for goldens\/refund-over-limit and goldens\/refund-vip together \(.+\), so each is repaired on its own, until a fix is accepted for one\n/);
    expect(r.out).toMatch(/shadowlap repair for goldens\/refund-over-limit on its own: blame, repair and verify, within the \$\d+\.\d\d left/);
    expect(r.out).not.toContain('shadowlap repair for goldens/refund-vip on its own');
    expect(r.out).toContain('::notice title=Shadowlap::refund-over-limit, refund-vip: opened https://github.com/example/agent/pull/7');
    // One pull request, from one branch, and the fix in CI's store names it.
    expect(readFileSync(join(bin, 'calls'), 'utf8').trim().split('\n')).toEqual(['pr create']);
    const branch = sh(project, 'git', ['branch', '--list', 'shadowlap/fix-*', '--format=%(refname:short)']);
    expect(branch).toMatch(/^shadowlap\/fix-refund-over-limit-[0-9a-z]{6}$/);
    expect(r.fixes).toHaveLength(1);
    expect(r.fixes[0]).toMatchObject({ status: 'verified' });
    expect(r.fixes[0]!.source).toMatch(/PR #7$/);
    // The branch re-records the golden the fix was verified for, and leaves the other as it was.
    const changed = sh(project, 'git', ['diff', '--name-only', 'main', branch]).split('\n');
    expect(changed).toEqual(expect.arrayContaining(['agent.mjs', 'goldens/refund-over-limit/run.json']));
    expect(changed.some((f) => f.startsWith('goldens/refund-vip/'))).toBe(false);
    const body = readFileSync(readFileSync(join(bin, 'args'), 'utf8').split('\n')[9]!, 'utf8');
    expect(body).toContain('`goldens/refund-over-limit` is re-recorded under the fix');
    expect(body).toMatch(/`goldens\/refund-vip` fails the same check, but this fix is not verified for it: no fix was accepted for `goldens\/refund-over-limit` and `goldens\/refund-vip` together \(.+\), and this one was verified for `goldens\/refund-over-limit` alone\./);
    expect(body).toContain('shadowlap test goldens/refund-vip --update');
    expect(body).not.toContain("this pull request's own checks pass");
    expect(r.out).toContain('goldens/refund-vip fails the same check, and the fix on shadowlap/fix-');
    expect(r.summary).toMatch(/\| ✅ \| `refund-over-limit, refund-vip` \| .* · goldens\/refund-over-limit re-recorded · goldens\/refund-vip fails the same check, not verified under the fix: run `shadowlap test goldens\/refund-vip --update` on the branch, which keeps a recording only when it passes \| \$\d+\.\d\d of \$10\.00 \|/);
    // As the pull request's own checks find it: the fixed golden replays clean, the other still fails.
    sh(project, 'git', ['checkout', '-q', branch]);
    const onBranch = await run([CLI, '--db', ':memory:', 'test', 'goldens/*']);
    expect(onBranch.code).toBe(1);
    expect(onBranch.out).toMatch(/✓ refund-over-limit: /);
    expect(onBranch.out).toMatch(/✗ refund-vip: /);
  });

  it('says, when no fix repairs goldens that fail the same check either together or one at a time, how each try ended', async () => {
    await setUp({ expect: EXPECT });
    await addGolden('refund-vip', 'A-2077', 'refund', { expect: EXPECT });
    // The model refunds every order whatever the prompt says: no failing run is rescued, so there is nothing to learn from.
    stubborn = 'refund on order';
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic' });
    expect(r.outputs).toMatchObject({ failed: '2', fixes: '0', 'fix-prs': '' });
    expect(r.out).toContain('shadowlap repair for goldens/refund-over-limit on its own');
    expect(r.out).toContain('shadowlap repair for goldens/refund-vip on its own');
    expect(r.out).toContain('refund-over-limit, refund-vip: no fix pull request: together and each on its own: resampling rescued no failing run, so there is no passing path to learn from');
    expect(r.summary).toMatch(/\| ❌ \| `refund-over-limit, refund-vip` \| no fix: together and each on its own: resampling rescued no failing run/);
    expect(existsSync(join(bin, 'calls'))).toBe(false);
    expect(sh(project, 'git', ['branch', '--list', 'shadowlap/fix-*'])).toBe('');
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
      // The fix itself goes with those runs, verified, with the blame, verdict and repair behind it,
      // for a teammate's pull to bring to their Fixes page.
      const fixes = keys.filter((k) => /^team\/fixes\/fx-[0-9A-Z]{26}\.json$/.test(k));
      expect(fixes).toHaveLength(1);
      const doc = JSON.parse(s3.objects.get(fixes[0]!)!.body.toString('utf8')) as { fix: { status: string }; blames: unknown[]; verdicts: unknown[]; repairs: unknown[] };
      expect(doc.fix.status).toBe('verified');
      expect([doc.blames.length, doc.verdicts.length, doc.repairs.length].every((n) => n > 0)).toBe(true);
    } finally {
      await s3.close();
    }
  });

  it('with push and no credentials for the bucket, opens the pull request all the same and warns in the job summary and the log', async () => {
    await setUp({ expect: EXPECT });
    const config = JSON.parse(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ ...config, store: 's3://northwind-agent-runs/team?region=eu-central-1' }, null, 2));
    sh(project, 'git', ['commit', '-qam', 'Keep the runs in the team store']);
    const home = mkdtempSync(join(tmpdir(), 'sl-cifix-home-'));
    try {
      // A job without the credentials step: no keys, no profile, no instance role to ask.
      const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic', PUSH: 'true', FAIL_ON_DIVERGENCE: 'false' }, { ...NO_AWS, HOME: home, GITHUB_ACTIONS: 'true' });
      // The pull request opened, and the push that couldn't happen failed nothing: the job's result is the tests'.
      expect(r.code, r.out).toBe(0);
      expect(r.outputs).toMatchObject({ failed: '1', 'checks-failed': '1', fixes: '1', 'fix-prs': 'https://github.com/example/agent/pull/7' });
      expect(readFileSync(join(bin, 'args'), 'utf8').split('\n').slice(0, 2)).toEqual(['pr', 'create']);
      // Said in the log as a warning, with why...
      expect(r.out).toContain("::warning title=Shadowlap::refund-over-limit: the fix is not in the team store, so teammates won't see it on their Fixes page: No AWS credentials found.");
      expect(r.out).toContain('Its pull request is open all the same.');
      // ...and in the job summary: beside the fix, and why under the table.
      expect(r.summary).toMatch(/golden re-recorded · ⚠️ not in the team store \|/);
      expect(r.summary).toContain("⚠️ A fix couldn't go to the team store, so teammates won't see it on their Fixes page. Its pull request is open all the same.");
      expect(r.summary).toContain('- `refund-over-limit`: No AWS credentials found.');
      // The fix is still in the job's own store, with the pull request it went to.
      expect(r.fixes[0]).toMatchObject({ status: 'verified' });
      expect(r.fixes[0]!.source).toMatch(/PR #7$/);
      // The test runs' push is as it always was: a warning of its own, and the tests decide the job.
      expect(r.out).toContain('::warning title=shadowlap test --push::no credentials for s3://northwind-agent-runs/team');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("from a pull request's job, keeps every run to the pull request's own folder and says the fix stays off the team's Fixes page", async () => {
    const key = 'AKIDCIFIXPREXAMPLE';
    const s3 = await startFakeS3({ keys: { [key]: 'ci/pr/secret' }, bucket: 'northwind-agent-runs', versioning: 'Enabled' });
    try {
      await setUp({ expect: EXPECT });
      const config = JSON.parse(readFileSync(join(project, 'shadowlap.config.json'), 'utf8')) as Record<string, unknown>;
      writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ ...config, store: `s3://northwind-agent-runs/team?endpoint=${s3.url}` }, null, 2));
      sh(project, 'git', ['commit', '-qam', 'Keep the runs in the team store']);
      // GitHub's pull_request event, for pull request 12, with the branch checked out.
      const r = await action(
        { FIX_ON_FAILURE: 'true', FIX_BUDGET: '5', REPAIRER: 'anthropic', PUSH: 'true', FAIL_ON_DIVERGENCE: 'false' },
        { ...NO_AWS, AWS_ACCESS_KEY_ID: key, AWS_SECRET_ACCESS_KEY: 'ci/pr/secret', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/pull/12/merge' },
      );
      expect(r.code, r.out).toBe(0);
      expect(r.outputs).toMatchObject({ failed: '1', fixes: '1' });
      expect(r.out).toContain("the fix's runs went to pull request 12's own folder in the team store; a pull request's job sends no fixes, so this one stays off the team's Fixes page");
      expect(r.out).not.toContain('::warning title=Shadowlap::');
      expect(r.summary).toContain("golden re-recorded · not on the team's Fixes page: a pull request's job writes only to its own folder, `pr/12/` |");
      expect(r.summary).not.toContain('⚠️');
      // Everything the job wrote is in pr/12/: its test runs and report, and every run the fix's job made; no fix.
      const keys = [...s3.objects.keys()];
      expect(keys.some((k) => k.startsWith('team/pr/12/tests/'))).toBe(true);
      for (const runId of r.runs) expect(keys, runId).toContain(`team/pr/12/runs/${runId}/run.json`);
      expect(keys.filter((k) => !k.startsWith('team/pr/12/'))).toEqual([]);
      expect(keys.some((k) => k.includes('/fixes/'))).toBe(false);
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

  it('says why there is no fix when the repairer can’t be asked, as when claude isn’t on the runner', async () => {
    await setUp({ expect: EXPECT });
    const r = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '1.00', REPAIRER: 'claude-code', FAIL_ON_DIVERGENCE: 'false' }, { SHADOWLAP_CLAUDE: '/nonexistent/claude' });
    expect(r.code, r.out).toBe(0);
    expect(r.outputs).toMatchObject({ failed: '1', 'checks-failed': '1', fixes: '0', 'fix-prs': '' });
    // Not "there was no candidate to try": what kept the repairer from proposing one.
    expect(r.out).toContain('refund-over-limit: no fix pull request: the repairer could not be asked: /nonexistent/claude was not found');
    expect(r.summary).toMatch(/\| ❌ \| `refund-over-limit` \| no fix: the repairer could not be asked: \/nonexistent\/claude was not found \|/);

    // An anthropic repairer whose key the job lacks, as when the secret isn't set: found out before any blame, so nothing is spent.
    const home = mkdtempSync(join(tmpdir(), 'sl-home-'));
    try {
      const unset = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith('ANTHROPIC_')).map((k) => [k, undefined]));
      const hits = mock.requests.length;
      const nokey = await action({ FIX_ON_FAILURE: 'true', FIX_BUDGET: '1.00', REPAIRER: 'anthropic', FAIL_ON_DIVERGENCE: 'false' }, { ...unset, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: mock.url, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: home });
      expect(nokey.outputs).toMatchObject({ failed: '1', fixes: '0' });
      expect(nokey.out).toContain('refund-over-limit: no fix pull request: the repairer could not be asked: no Anthropic credentials');
      expect(nokey.summary).toMatch(/\| ❌ \| `refund-over-limit` \| no fix: the repairer could not be asked: no Anthropic credentials \| \$0\.00 of \$1\.00 \|/);
      expect(mock.requests.length).toBe(hits);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
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
    const unpriced = { ok: false, label: 'cost at most $1.00', detail: 'no price for small-model; add it under "prices" in shadowlap.config.json' };
    const plans = planFixes({
      results: [
        result({}),
        result({ name: 'drift', failure: 'diverged' }),
        result({ name: 'crash', failure: 'exit' }),
        result({ name: 'unchecked', expect: null }),
        result({ name: 'fine', ok: true }),
        result({ name: 'unpriced', checks: [{ ok: true, label: 'issue_refund called 0 times', detail: null }, unpriced] }),
        result({ name: 'refunds-too', checks: [{ ok: false, label: 'issue_refund called 0 times', detail: 'called 1 time' }, unpriced] }),
        result({ name: 'unsure', failure: 'inconclusive' }),
      ],
    });
    expect(plans.map((p) => [p.result.name, p.skip])).toEqual([
      ['refund-flow', null],
      ['drift', 'diverged: never fixed automatically, because most divergences are intended. Update the golden or add a normalizer'],
      ['crash', 'the agent exited with an error, which is not an outcome check'],
      ['unchecked', 'its checks are not under "tests" in shadowlap.config.json'],
      // A cost check that fails for want of a price fails whatever the model answers: no prompt fix changes it.
      ['unpriced', 'it fails only because small-model has no price, which no prompt fix changes: add it under "prices" in shadowlap.config.json'],
      ['refunds-too', null],
      // A gate that ran out of attempts between its bounds: more attempts settle it, not a repair.
      ['unsure', 'its verdict is inconclusive, neither passed nor failed: more attempts settle it, not a fix'],
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
    // Without push, nothing about the team store.
    expect(md).not.toContain('team store');
    expect(fixSummary([], 2)).toBe('');
  });

  it('says in the job summary where each fix went with push, and why one couldn\'t go', () => {
    const opened = (name: string, pushed: { state: 'sent' | 'pr' | 'off' | 'failed'; why: string | null; pr: string | null }) => ({ name, outcome: 'opened' as const, pr: `https://example.com/pr/${name}`, title: `Fix ${name}`, verify: null, spent: 0.5, why: null, goldenState: null, pushed });
    const md = fixSummary(
      [
        opened('sent', { state: 'sent', why: null, pr: null }),
        opened('in-pr', { state: 'pr', why: null, pr: '12' }),
        opened('off', { state: 'off', why: 'Push from CI is off ("ciPush": false in shadowlap.config.json)', pr: null }),
        opened('no-keys', { state: 'failed', why: 'No AWS credentials found. Set AWS_ACCESS_KEY_ID\nand AWS_SECRET_ACCESS_KEY', pr: null }),
        opened('unreachable', { state: 'failed', why: "The S3-compatible store: couldn't reach 127.0.0.1:9000", pr: null }),
      ],
      2,
    );
    expect(md).toContain('| ✅ | `sent` | [Fix sent](https://example.com/pr/sent) · in the team store | $0.50 of $2.00 |');
    expect(md).toContain("| ✅ | `in-pr` | [Fix in-pr](https://example.com/pr/in-pr) · not on the team's Fixes page: a pull request's job writes only to its own folder, `pr/12/` | $0.50 of $2.00 |");
    expect(md).toContain('| ✅ | `off` | [Fix off](https://example.com/pr/off) · not in the team store: Push from CI is off ("ciPush": false in shadowlap.config.json) | $0.50 of $2.00 |');
    expect(md).toContain('| ✅ | `no-keys` | [Fix no-keys](https://example.com/pr/no-keys) · ⚠️ not in the team store | $0.50 of $2.00 |');
    // Each that couldn't go, with why, under the table; the pull requests are open all the same.
    expect(md).toContain("⚠️ 2 fixes couldn't go to the team store, so teammates won't see them on their Fixes page. Their pull requests are open all the same.\n\n- `no-keys`: No AWS credentials found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY\n- `unreachable`: The S3-compatible store: couldn't reach 127.0.0.1:9000\n");
    expect(md.indexOf('⚠️ 2 fixes')).toBeLessThan(md.indexOf('Nothing is merged'));
  });

  it('repairs goldens that fail the same check as one fix, with every failing replay a target', () => {
    const plans = planFixes({
      results: [
        result({ name: 'a', golden: 'goldens/a', runs: [{ runId: 'A1', ok: false }, { runId: 'A2', ok: true }], expect: { tools: { send_email: 0 }, cost: '<= 1.00' } }),
        result({ name: 'b', golden: 'goldens/b', runs: [{ runId: 'B1', ok: false }], expect: { tools: { refund: 0 } } }),
        result({ name: 'drift', golden: 'goldens/drift', failure: 'diverged' }),
        // The same check as a's, written in another order.
        result({ name: 'c', golden: 'goldens/c', runs: [{ runId: 'C1', ok: false }, { runId: 'C2', ok: true }], expect: { cost: '<= 1.00', tools: { send_email: 0 } } }),
      ],
    });
    const groups = groupFixes(plans);
    expect(groups.map((g) => g.members.map((m) => m.result.name))).toEqual([['a', 'c'], ['b']]);
    expect(groups[0]).toMatchObject({ result: { name: 'a' }, skip: null, fixes: ['A1', 'C1'], keeps: ['A2', 'C2'] });
    expect(repairArgs(groups[0]!, { db: null, budget: 4, repairer: '', expectFile: '/tmp/expect.json' })).toEqual(['repair', '--fixes', 'A1', 'C1', '--keeps', 'A2', 'C2', '--expect', '@/tmp/expect.json', '--budget', '4', '--branch', branchName(plans[0]!.result), '--yes', '--json']);
    // The plans themselves are left as they were.
    expect(plans[0]).toMatchObject({ fixes: ['A1'], keeps: ['A2'] });
  });

  it('re-records only a golden that must replay exactly, and only from a recording repair kept', () => {
    const base = { cli: CLI, workdir: tmpdir(), env: process.env, scratch: tmpdir() };
    const member = (result: ReportResult) => ({ result, skip: null, fixes: ['01K5CQ4V3H8M2XWQH6V3T9RB1D'], keeps: [] });
    expect(refreshGoldens({ ...base, members: [member({ name: 'x', dir: 'goldens/x', mode: 'fork', ok: false })], repair: { output: { goldens: ['g'], patch: 'p', branch: 'b' } } }).goldens).toEqual([{ state: 'fork', golden: 'goldens/x', why: null }]);
    expect(refreshGoldens({ ...base, members: [member({ name: 'x', dir: 'goldens\\x\\', mode: 'replay', ok: false })], repair: { output: { goldens: [], patch: 'p', branch: 'b' } } }).goldens).toEqual([{ state: 'stale', golden: 'goldens/x', why: 'repair kept no recording of the fixed run' }]);
    // Of goldens repaired together, each takes the recording of one of its own failing replays, which repair names by its run.
    const two = refreshGoldens({ ...base, members: [member({ name: 'x', dir: 'goldens/x', mode: 'fork', ok: false }), { ...member({ name: 'y', dir: 'goldens/y', mode: 'replay', ok: false }), fixes: ['01K5CQ9ZZZ0000000000000000'] }], repair: { output: { goldens: ['.shadowlap/repairs/r/goldens/01K5CQ4V3H'], patch: 'p', branch: 'b' } } });
    expect(two.goldens).toEqual([{ state: 'fork', golden: 'goldens/x', why: null }, { state: 'stale', golden: 'goldens/y', why: 'repair kept no recording of the fixed run' }]);
    // A golden of the group the fix was verified without is named as it is, never re-recorded, and is none of the others.
    const without = refreshGoldens({ ...base, members: [member({ name: 'x', dir: 'goldens/x', mode: 'fork', ok: false })], unfixed: [member({ name: 'y', dir: 'goldens/y', mode: 'replay', ok: false }), member({ name: 'z', dir: 'goldens/z', mode: 'fork', ok: false })], unfixedWhy: 'w', results: [{ name: 'y', dir: 'goldens/y', mode: 'replay', ok: false }], repair: { output: { goldens: ['g'], patch: 'p', branch: 'b' } } });
    expect(without.goldens).toEqual([{ state: 'fork', golden: 'goldens/x', why: null }, { state: 'unfixed', golden: 'goldens/y', why: 'w' }, { state: 'unfixed', golden: 'goldens/z', why: 'w', fork: true }]);
    expect(without.others).toMatchObject({ diverging: [], failing: [], unreplayed: [], replayed: 0 });
  });

  it('says the pull request\'s checks pass only when every golden replayed on the branch is clean', () => {
    const recorded = { state: 'recorded' as const, golden: 'goldens/a', why: null };
    const none = { diverging: [], failing: [], unreplayed: [], replayed: 0 };
    expect(branchNote({ goldens: [recorded], others: { ...none, replayed: 2 }, checked: true })).toContain("Every golden this job tested replays clean on this branch, so this pull request's own checks pass.");
    const diverging = branchNote({ goldens: [recorded], others: { ...none, diverging: ['goldens/b', 'goldens/c'], replayed: 2 }, checked: true });
    expect(diverging).toContain('2 other goldens, which passed before it, diverge on this branch: `goldens/b` and `goldens/c`');
    expect(diverging).toContain('shadowlap test goldens/b goldens/c --update');
    expect(diverging).not.toContain('checks pass');
    expect(branchNote({ goldens: [recorded], others: { ...none, failing: ['goldens/d'], replayed: 1 }, checked: true })).toContain('`goldens/d` failed before the fix too, and fails on this branch as well.');
    // One that may fork runs live from where it diverges, so it isn't replayed, and nothing is said of the checks it decides.
    const forks = branchNote({ goldens: [recorded], others: { ...none, unreplayed: ['goldens/e'], replayed: 1 }, checked: true });
    expect(forks).toContain('Every golden this job replayed exactly replays clean on this branch.');
    expect(forks).not.toContain('checks pass');
    // Nothing replayed, or a replay that could not run: no word on the checks.
    expect(branchNote({ goldens: [{ state: 'fork', golden: 'goldens/a', why: null }], others: none, checked: true })).not.toContain('replays clean on this branch');
    expect(branchNote({ goldens: [recorded], others: none, checked: false })).not.toContain('checks pass');
    // A replay that could not run leaves the others unknown, and says so.
    const unknown = branchNote({ goldens: [{ state: 'stale', golden: 'goldens/a', why: 'x' }], others: { ...none, unchecked: ['goldens/f'] }, checked: false, why: 'the fix does not apply to the working tree' });
    expect(unknown).toContain('`goldens/f` could not be replayed under the fix here (the fix does not apply to the working tree), so whether it diverges on this branch is not known: run `shadowlap test goldens/f` on it to see.');
    expect(unknown).not.toContain('checks pass');
    // A golden that fails the same check, which the fix was not verified for: the others' replay says nothing of it.
    const unfixed = branchNote({ goldens: [recorded, { state: 'unfixed', golden: 'goldens/g', why: 'no fix was accepted for both together' }], others: { ...none, replayed: 2 }, checked: true });
    expect(unfixed).toContain('`goldens/g` fails the same check, but this fix is not verified for it: no fix was accepted for both together. It still holds the recording made before the fix');
    expect(unfixed).toContain('shadowlap test goldens/g --update');
    expect(unfixed).not.toContain('replays clean on this branch');
    const forking = goldenNote({ state: 'unfixed', golden: 'goldens/h', why: null, fork: true });
    expect(forking).toBe('`goldens/h` fails the same check, but this fix is not verified for it. It may fork, so on this branch it runs live from where it diverges, and its checks say whether the fix repairs it too.\n');
  });

  it('tells the pull request how to update a golden it could not re-record', () => {
    const note = goldenNote({ state: 'stale', golden: 'goldens/refund-flow', why: 'the recording verify accepted does not replay clean on the branch (refund-flow: diverged at call 4)' });
    expect(note).toContain('`goldens/refund-flow` still holds the recording made before the fix, which sends the old prompt, so it diverges on this branch.');
    expect(note).toContain('shadowlap test goldens/refund-flow --update');
    expect(note).toContain('It was not re-recorded automatically: the recording verify accepted does not replay clean on the branch (refund-flow: diverged at call 4).');
  });
});

describe('pushing a fix CI opened to the team store', () => {
  /** The newest job's folder; every one made is removed after each test. */
  let dir = '';
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    dir = '';
  });

  /** A CI job's checkout: the config, a store with a finished run to push, and an environment with no credentials. */
  function job(config: Record<string, unknown>, extra: NodeJS.ProcessEnv = {}): { workdir: string; db: string; env: NodeJS.ProcessEnv } {
    dir = mkdtempSync(join(tmpdir(), 'sl-cifix-push-'));
    made.push(dir);
    mkdirSync(join(dir, 'home'));
    writeFileSync(join(dir, 'shadowlap.config.json'), JSON.stringify(config));
    const db = join(dir, 'ci.db');
    const store = Store.open(db);
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: dir } });
    store.endRun(run.runId, 'completed');
    store.close();
    return { workdir: dir, db, env: { PATH: process.env.PATH ?? '', HOME: join(dir, 'home'), NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', AWS_EC2_METADATA_DISABLED: 'true', ...extra } };
  }

  /** A port on this machine nothing listens on. */
  async function closedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  /** A GitHub event naming pull request 12 from `head` into northwind/agent, as GITHUB_EVENT_PATH holds it, in the job's folder. */
  function event(name: string, head: string | null): string {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ number: 12, pull_request: { number: 12, head: { ref: 'feature', repo: head === null ? null : { full_name: head } }, base: { ref: 'main', repo: { full_name: 'northwind/agent' } } } }));
    return path;
  }

  it('says why the fix stays out of the store, never throwing: no store set, Push from CI off, no credentials', () => {
    expect(pushFix({ cli: CLI, ...job({}) })).toEqual({ state: 'failed', why: 'no team store is set in shadowlap.config.json (shadowlap store set <url>)', pr: null });
    // The team's own choice, which is no failure.
    expect(pushFix({ cli: CLI, ...job({ store: 's3://northwind-agent-runs/team', ciPush: false }) })).toEqual({ state: 'off', why: 'Push from CI is off ("ciPush": false in shadowlap.config.json)', pr: null });
    // What push said, rather than its last line of advice.
    const none = pushFix({ cli: CLI, ...job({ store: 's3://northwind-agent-runs/team?region=eu-central-1' }) });
    expect(none).toMatchObject({ state: 'failed', pr: null });
    expect(none.why).toMatch(/^No AWS credentials found\. /);
  });

  /** A stand-in for the CLI whose push prints `report` as `push --all --json` prints its result, and succeeds. */
  function pushing(report: unknown): string {
    const path = join(dir, 'push-says.mjs');
    writeFileSync(path, `process.stdout.write(${JSON.stringify(JSON.stringify(report, null, 2))});\n`);
    return path;
  }

  it("puts the fix in the team store only on push's word: its report names the fix as sent, now or earlier in the job", () => {
    const checkout = job({ store: 's3://northwind-agent-runs/team?region=eu-central-1' });
    const report = (extra: Record<string, unknown>) => ({ store: 's3://northwind-agent-runs/team', pullRequest: null, pushed: ['01JOBRUN'], updated: [], unchanged: [], queued: [], repaired: [], refused: [], blobs: { uploaded: 3, present: 0, bytes: 2048 }, segment: 'seg-1', onlyLocal: 0, ...extra });
    const fixes = (sent: string[], failed: Array<{ fixId: string; reason: string }> = []) => ({ fixes: { sent, failed, repairs: [] } });
    const said = (r: unknown, o: { fixIds?: string[]; sentInJob?: Set<string> } = {}) => pushFix({ ...checkout, cli: pushing(r), fixIds: ['fx-A'], ...o });
    expect(said(report(fixes(['fx-A'])))).toEqual({ state: 'sent', why: null, pr: null });
    // A report without its list of fixes, as when push changes what it prints, says nothing about this one.
    expect(said(report({}))).toEqual({ state: 'failed', why: "shadowlap push didn't say which fixes it sent", pr: null });
    expect(said(report({ fixes: { sent: 'fx-A' } }))).toEqual({ state: 'failed', why: "shadowlap push didn't say which fixes it sent", pr: null });
    // One the report leaves out, with every run gone, isn't taken to be there.
    expect(said(report(fixes(['fx-OTHER'])))).toEqual({ state: 'failed', why: "shadowlap push didn't report sending it", pr: null });
    // ...unless an earlier push in the same job sent it: the store has it, and nothing since changed it.
    const sentInJob = new Set<string>();
    expect(said(report(fixes(['fx-A'])), { sentInJob })).toMatchObject({ state: 'sent' });
    expect([...sentInJob]).toEqual(['fx-A']);
    expect(said(report(fixes([])), { sentInJob })).toMatchObject({ state: 'sent' });
    // Repair named no fix: whatever push sent, it can't have been this one.
    expect(said(report(fixes(['fx-B'])), { fixIds: [] })).toEqual({ state: 'failed', why: 'repair named no fix, so there was none for push to send', pr: null });
    // The store refused it, or runs it went with stayed in the job.
    expect(said(report(fixes([], [{ fixId: 'fx-A', reason: 'it would be 17000001 bytes, over the 16777216 a pull reads, so it stays on this machine' }])))).toEqual({ state: 'failed', why: "the store didn't take the fix: it would be 17000001 bytes, over the 16777216 a pull reads, so it stays on this machine", pr: null });
    expect(said(report({ refused: [{ runId: '01JOBRUN2', reason: 'a blob it needs is missing here' }], ...fixes([]) }))).toEqual({ state: 'failed', why: 'runs stayed in the job, so the fix may have too: a blob it needs is missing here', pr: null });
    // A pull request's job: its folder, and no fixes.
    expect(said(report({ pullRequest: '12', ...fixes([]) }))).toEqual({ state: 'pr', why: null, pr: '12' });
  });

  it('says so when the store is out of reach', async () => {
    const port = await closedPort();
    const r = pushFix({ cli: CLI, ...job({ store: `s3://northwind-agent-runs/team?endpoint=http://127.0.0.1:${port}` }, { AWS_ACCESS_KEY_ID: 'AKIDCIFIXEXAMPLE', AWS_SECRET_ACCESS_KEY: 'ci/secret' }) });
    expect(r.state).toBe('failed');
    expect(r.why).toContain(`couldn't reach 127.0.0.1:${port}`);
  }, 30_000);

  it('names a pull request from a fork, whose job GitHub gives no secrets', () => {
    const checkout = job({ store: 's3://northwind-agent-runs/team?region=eu-central-1' });
    const github = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event('fork', 'someone/agent'), GITHUB_REF: 'refs/pull/12/merge' };
    const r = pushFix({ cli: CLI, ...checkout, env: { ...checkout.env, ...github } });
    expect(r.state).toBe('failed');
    expect(r.why).toMatch(/^a pull request from a fork, whose job GitHub gives no secrets: No AWS credentials found\. /);
    expect(forkPullRequest(github)).toBe(true);
    // The repository's own pull request (names compared as GitHub does, in any case), one whose fork
    // is gone, pull_request_target (it runs with the base's secrets), and jobs for no pull request.
    expect(forkPullRequest({ ...github, GITHUB_EVENT_PATH: event('same', 'northwind/agent') })).toBe(false);
    expect(forkPullRequest({ ...github, GITHUB_EVENT_PATH: event('case', 'Northwind/Agent') })).toBe(false);
    expect(forkPullRequest({ ...github, GITHUB_EVENT_PATH: event('gone', null) })).toBe(true);
    expect(forkPullRequest({ ...github, GITHUB_EVENT_NAME: 'pull_request_target' })).toBe(false);
    expect(forkPullRequest({ ...github, GITHUB_EVENT_NAME: 'push' })).toBe(false);
    expect(forkPullRequest({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: github.GITHUB_EVENT_PATH })).toBe(false);
    expect(forkPullRequest({ ...github, GITHUB_EVENT_PATH: join(dir, 'no-such-event.json') })).toBe(false);
  });

  it('says in the log how each went: a warning, on one line, only when it couldn\'t go', () => {
    expect(pushLine('refund-flow', { state: 'sent', why: null, pr: null })).toBe('the fix was sent to the team store');
    expect(pushLine('refund-flow', { state: 'pr', why: null, pr: '12' })).toBe("the fix's runs went to pull request 12's own folder in the team store; a pull request's job sends no fixes, so this one stays off the team's Fixes page");
    expect(pushLine('refund-flow', { state: 'off', why: 'Push from CI is off', pr: null })).toBe('the fix was not sent to the team store: Push from CI is off');
    expect(pushLine('refund-flow', { state: 'failed', why: '100% gone\nfor now', pr: null })).toBe("::warning title=Shadowlap::refund-flow: the fix is not in the team store, so teammates won't see it on their Fixes page: 100%25 gone%0Afor now. Its pull request is open all the same.");
    expect(pushLine('refund-flow', { state: 'failed', why: 'No AWS credentials found.', pr: null })).toMatch(/: No AWS credentials found\. Its pull request is open all the same\.$/);
  });
});
