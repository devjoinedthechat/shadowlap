import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { judgeAnswer, judgeQuestion, message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { releaseLock, unifiedDiff } from '@shadowlap/engine';
import { applyAccepted, noDiagnosisWhy, recoverWorkingTree, startRepair } from '../src/repair.js';

/**
 * `shadowlap repair` through the CLI, on the support agent in a git repository of its own. The mock
 * plays the agent's model and the repairer. The agent's model refunds a $240 order against policy
 * while the runs are recorded; after that, asked again, it escalates every other time, and always
 * under a system prompt that says to escalate refunds above the limit. The repairer proposes three
 * rewrites: one that names the failing order, one that changes nothing the model reacts to, and the
 * one that works.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } });
const FIX = 'You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.';

let mock: MockServer;
let project: string;
let mode: 'refund' | 'alternate' | 'stubborn' = 'refund';
let decisions = 0;
let counter = 0;
/** What the repairer proposes instead of the three below, given the prompt it was sent (with its line breaks). */
let proposals: ((prompt: string) => Array<{ anchor: number; replace: string; strategy: string; why: string }>) | null = null;

/** A judge check that reads the run: it passes when no $240 refund was issued. */
const JUDGED = [{ name: 'no-big-refund', question: 'Did the agent avoid refunding $240?', of: 'run', model: 'claude-haiku-4-5' }];

function script(ctx: ScriptContext) {
  // The judge, for a check that reads the run: no when it holds a $240 refund.
  const q = judgeQuestion(ctx.request);
  if (q) return { message: judgeAnswer(/called issue_refund[^\n]*"amount":240/.test(q.material) ? { verdict: 'no', reason: 'it refunds $240' } : { verdict: 'yes', reason: 'no $240 refund' }, q.model) };
  const system = JSON.stringify(ctx.request.system ?? '');
  const usage = { input_tokens: Math.round(JSON.stringify(ctx.request).length / 4), output_tokens: 30 };
  if (system.includes('You improve AI agents')) {
    const user = JSON.stringify(ctx.request.messages);
    if (proposals) return { message: message([text(JSON.stringify({ diagnosis: 'The policy line says who decides, not what to do.', candidates: proposals(user.replace(/\\n/g, '\n')) }))], usage) };
    const anchor = (label: string) => Number(new RegExp(`\\[(\\d+)\\] ${label}, in [^:]+:`).exec(user.replace(/\\n/g, '\n'))?.[1]);
    const answer = {
      diagnosis: 'The system prompt says to follow the policy but not what the policy asks of large refunds.',
      candidates: [
        { anchor: anchor('system prompt'), replace: 'You are a support agent. Follow the refund policy, and never refund order A-1042.', strategy: 'Forbid the failing refund', why: 'It names the case.' },
        { anchor: anchor('tool issue_refund'), replace: 'Refund an order. Check the policy first.', strategy: 'Point the refund tool at the policy', why: 'The tool is where the choice is made.' },
        { anchor: anchor('system prompt'), replace: FIX, strategy: 'Escalate refunds above the policy limit', why: 'The policy sets a limit; saying what to do above it makes the right tool clear.' },
      ],
    };
    return { message: message([text(JSON.stringify(answer))], usage) };
  }
  const small = JSON.stringify(ctx.request.messages[0]?.content ?? '').includes('B-7');
  const order = small ? 'B-7' : 'A-1042';
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([toolUse('lookup_order', { order_id: order }, `toolu_lookup_${ctx.requestNo}`)], usage) };
    case 1:
      return { message: message([toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)], usage) };
    case 2: {
      if (small) return { message: message([toolUse('issue_refund', { order_id: order, amount: 40 }, `toolu_decide_${ctx.requestNo}`)], usage) };
      decisions++;
      const escalates = system.includes('escalate every refund above the limit') || ctx.request.model === 'big-model' || (mode === 'alternate' && decisions % 2 === 0);
      return {
        message: escalates
          ? message([text('Above the limit.'), toolUse('escalate', { reason: 'above the refund limit' }, `toolu_decide_${ctx.requestNo}`)], usage)
          : message([toolUse('issue_refund', { order_id: order, amount: 240 }, `toolu_decide_${ctx.requestNo}`)], usage),
      };
    }
    default:
      return { message: message([text('Done.')], { ...usage, stop_reason: 'end_turn' }) };
  }
}

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
});

const sh = (cwd: string, cmd: string, args: string[]) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

beforeEach(() => {
  // Inside this repository, so the agent's imports resolve; a git repository of its own.
  project = join(fileURLToPath(new URL('.', import.meta.url)), `.tmp-repair-${process.pid}-${counter++}`);
  mkdirSync(project);
  copyFileSync(AGENT, join(project, 'agent.mjs'));
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n');
  sh(project, 'git', ['init', '-q', '-b', 'main']);
  sh(project, 'git', ['config', 'user.name', 'Test']);
  sh(project, 'git', ['config', 'user.email', 'test@example.com']);
  sh(project, 'git', ['add', '.']);
  sh(project, 'git', ['commit', '-q', '-m', 'agent']);
  mode = 'refund';
  decisions = 0;
  proposals = null;
});
afterEach(() => {
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'test-key', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
  const r = await shadowlap(['run', '--', process.execPath, 'agent.mjs', ...(order ? [order] : [])]);
  expect(r.code, r.out).toBe(0);
  return /recording run (\w{26})/.exec(r.out)![1]!;
}

async function runs(): Promise<{ failed: string[]; good: string }> {
  const failed = [await record(), await record()];
  const good = await record('B-7');
  expect((await shadowlap(['label', good, 'good'])).code).toBe(0);
  return { failed, good };
}

interface Report {
  outcome: string;
  why: string | null;
  targets: Array<{ runId: string; outcome: string; callNo: number | null; rescuedBy: string | null }>;
  holdout: string[];
  heldOutAutomatically: boolean;
  repairer: { served: string } | null;
  candidates: Array<{ id: number; source: string; state: string; reason: string | null; after: string }>;
  accepted: number | null;
  patch: string | null;
  output: { dir: string; patch: string | null; report: string; goldens: string[]; applied: boolean; branch: string | null; pr: string | null };
  warnings: string[];
}

const agentText = () => readFileSync(join(project, 'agent.mjs'), 'utf8');

// Verify decides each candidate's runs by its gate, a dozen attempts each where it used to take four: more time on a busy machine.
describe('shadowlap repair', { timeout: 120_000 }, () => {
  it('blames, asks the repairer, keeps the fix the gate accepts, and leaves the working tree as it was', async () => {
    const { failed, good } = await runs();
    const before = agentText();
    mode = 'alternate';
    const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report;

    // Every other failing run is held out from the repairer, and it is shown one case, not two.
    expect(report.heldOutAutomatically).toBe(true);
    expect(report.targets.map((t) => t.runId)).toEqual([failed[0]]);
    expect(report.holdout).toEqual([failed[1]]);
    const asked = mock.requests.filter((q) => JSON.stringify(q.body.system).includes('You improve AI agents'));
    expect(asked).toHaveLength(1);
    const prompt = JSON.stringify(asked[0]!.body.messages);
    expect(prompt).toContain('Failed run 1 of 1');
    expect(asked[0]!.body.model).toBe('claude-opus-5-5');

    expect(report.outcome).toBe('fixed');
    expect(report.candidates.map((c) => [c.id, c.state])).toEqual([
      [1, 'invalid'],
      [2, 'rejected'],
      [3, 'accepted'],
    ]);
    expect(report.candidates[0]!.reason).toContain('mentions A-1042, which only the failing runs contain');
    expect(report.candidates[1]!.reason).toMatch(/target run \w{10} not fixed/);
    expect(report.accepted).toBe(3);

    // Candidates were tried in place and put back; nothing is left half-applied.
    expect(agentText()).toBe(before);
    expect(existsSync(join(project, '.shadowlap', 'repair-journal.json'))).toBe(false);

    // The patch applies, and the recording of a fixed run replays clean only with it.
    const golden = report.output.goldens.find((g) => g.endsWith(failed[0]!.slice(0, 10)))!;
    expect(golden).toBeDefined();
    const stale = await shadowlap(['test', golden]);
    expect(stale.code, stale.out).toBe(1);
    sh(project, 'git', ['apply', report.output.patch!]);
    expect(agentText()).toContain(FIX);
    const tested = await shadowlap(['test', golden]);
    expect(tested.code, tested.out).toBe(0);

    const md = readFileSync(join(project, report.output.report), 'utf8');
    expect(md).toContain('## Escalate refunds above the policy limit');
    expect(md).toContain(`+ ${FIX}`);
    expect(md).toContain('The held-out runs were never shown to the repairer.');
    expect(md).toContain('Writes were stubbed in every replay.');
    expect(md).toMatch(/\| good \| `\w{10}` \| kept \| 12 of 12 passed · rate >= 0\.76 \(95%\) · pass\^5 1\.00 \|/);
    expect(md).toContain('each by its gate, which tells 90%+ from 70%- at <= 5% risk');
    expect(md).not.toMatch(/at least|at most|of the time/);
    expect(md).toContain(good.slice(0, 10));
  });

  // The stand-in for gh is a shell script, which Windows won't run by name.
  it.skipIf(process.platform === 'win32')('commits the fix to a branch without checking it out, and opens a pull request', async () => {
    const { failed } = await runs();
    mode = 'alternate';
    const remote = mkdtempSync(join(tmpdir(), 'fp-remote-'));
    const bin = mkdtempSync(join(tmpdir(), 'fp-gh-'));
    try {
      sh(remote, 'git', ['init', '-q', '--bare']);
      sh(project, 'git', ['remote', 'add', 'origin', remote]);
      // A stand-in for gh: records how it was called and prints a pull request URL, as gh does.
      writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(bin, 'args')}"\necho https://github.com/example/agent/pull/7\n`);
      chmodSync(join(bin, 'gh'), 0o755);
      const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--branch', 'shadowlap/escalate-refunds', '--pr', '--goldens', 'goldens', '--json'], { PATH: `${bin}${delimiter}${process.env.PATH}` });
      expect(r.code, r.out).toBe(0);
      const report = JSON.parse(r.stdout) as Report;
      expect(report.output).toMatchObject({ branch: 'shadowlap/escalate-refunds', pr: 'https://github.com/example/agent/pull/7', applied: false });

      // The branch has the fix and the recordings; HEAD and the working tree do not.
      expect(sh(project, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
      expect(sh(project, 'git', ['show', 'shadowlap/escalate-refunds:agent.mjs'])).toContain(FIX);
      expect(agentText()).not.toContain(FIX);
      expect(sh(project, 'git', ['status', '--porcelain']).trim()).toBe('');
      const files = sh(project, 'git', ['ls-tree', '-r', '--name-only', 'shadowlap/escalate-refunds']).split('\n');
      expect(files.some((f) => f.startsWith(`goldens/${failed[0]!.slice(0, 10)}/`) && f.endsWith('run.json'))).toBe(true);
      const msg = sh(project, 'git', ['log', '-1', '--format=%B', 'shadowlap/escalate-refunds']);
      expect(msg.split('\n')[0]).toBe('Escalate refunds above the policy limit');
      expect(msg).toContain('fixes 1 of 1 target and 1 of 1 held-out failing runs, keeps 1 of 1 good runs');
      expect(msg).not.toMatch(/Co-Authored-By/i);

      expect(sh(remote, 'git', ['rev-parse', 'shadowlap/escalate-refunds']).trim()).toBe(sh(project, 'git', ['rev-parse', 'shadowlap/escalate-refunds']).trim());
      const args = readFileSync(join(bin, 'args'), 'utf8').split('\n');
      expect(args.slice(0, 8)).toEqual(['pr', 'create', '--head', 'shadowlap/escalate-refunds', '--base', 'main', '--title', 'Escalate refunds above the policy limit']);
      expect(args[8]).toBe('--body-file');
      expect(readFileSync(args[9]!, 'utf8')).toContain('## Escalate refunds above the policy limit');
    } finally {
      rmSync(remote, { recursive: true, force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('says when the branch leaves out uncommitted changes that verify replayed', async () => {
    writeFileSync(join(project, 'notes.txt'), 'committed\n');
    sh(project, 'git', ['add', 'notes.txt']);
    sh(project, 'git', ['commit', '-q', '-m', 'notes']);
    const failed = await record();
    mode = 'alternate';
    // A change in the working tree that verify replays with, and that HEAD, so the branch, lacks.
    writeFileSync(join(project, 'notes.txt'), 'changed, not committed\n');
    const r = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'anthropic', '--branch', 'fix/escalate', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report & { uncommitted?: string[] };
    expect(report.outcome).toBe('fixed');
    expect(report.uncommitted).toEqual(['notes.txt']);
    expect(report.warnings).toContain('the working tree has uncommitted changes to notes.txt, which verify replayed and the branch fix/escalate does not hold: it is HEAD with the fix. Commit them and repair again, or check that the branch passes without them');
    expect(sh(project, 'git', ['log', '-1', '--format=%B', 'fix/escalate'])).toContain('uncommitted changes to notes.txt, which this commit does not hold');
    expect(readFileSync(join(project, report.output.report), 'utf8')).toContain('uncommitted changes to `notes.txt`. The branch holds HEAD with the fix, without them');
    // The branch is HEAD with the fix; the working tree keeps its change.
    expect(sh(project, 'git', ['show', 'fix/escalate:notes.txt'])).toBe('committed\n');
    expect(readFileSync(join(project, 'notes.txt'), 'utf8')).toBe('changed, not committed\n');
  });

  // On Windows the stand-in is a batch file, as an npm-installed claude is there, so it runs through cmd.exe.
  it('asks the user\'s own Claude Code, in print mode, outside the project and outside this session', async () => {
    const { failed } = await runs();
    mode = 'alternate';
    const bin = mkdtempSync(join(tmpdir(), 'fp-claude-'));
    try {
      // A stand-in for claude -p: records how it was run, and answers as Claude Code does, the
      // candidates in structured_output, with the same three the mock repairer proposes.
      const log = join(bin, 'call.json');
      const script = `const { readFileSync, writeFileSync } = require('node:fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const system = readFileSync(args[args.indexOf('--system-prompt-file') + 1], 'utf8');
  writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args, system, cwd: process.cwd(), claudecode: process.env.CLAUDECODE ?? null, input }));
  const at = input.indexOf('] system prompt, in ');
  const anchor = Number(input.slice(input.lastIndexOf('[', at) + 1, at));
  const candidates = [{ anchor, replace: ${JSON.stringify(FIX)}, strategy: 'Escalate refunds above the policy limit', why: 'The policy sets a limit.' }];
  const report = JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { diagnosis: 'd', candidates }, modelUsage: { 'claude-opus-5-5': {} }, usage: { input_tokens: 900, output_tokens: 120 }, total_cost_usd: 0.0061 });
  process.stdout.write(report.slice(0, 20));
  // The rest arrives after this process has exited, from one that holds its stdout on, as the last
  // of a batch file's output can after cmd.exe has exited: the report is read once stdout closes.
  // On Windows a child that isn't detached shares this process's job, and dies with it.
  require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(process.argv[1]), 300)', report.slice(20)], { stdio: ['ignore', 'inherit', 'inherit'], detached: process.platform === 'win32', windowsHide: true }).unref();
});
`;
      if (process.platform === 'win32') {
        // As npm's own shims are: the batch file hands its arguments to node with %*.
        writeFileSync(join(bin, 'claude.js'), script);
        writeFileSync(join(bin, 'claude.cmd'), `@"${process.execPath}" "%~dp0claude.js" %*\r\n`);
      } else {
        writeFileSync(join(bin, 'claude'), `#!${process.execPath}\n${script}`);
        chmodSync(join(bin, 'claude'), 0o755);
      }
      const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'claude-code:claude-opus-5-5', '--json'], { SHADOWLAP_CLAUDE: join(bin, 'claude'), CLAUDECODE: '1' });
      expect(r.code, r.out).toBe(0);
      const report = JSON.parse(r.stdout) as Report & { repairer: { served: string; cost: number } };
      expect(report.outcome).toBe('fixed');
      expect(report.repairer).toMatchObject({ served: 'claude-opus-5-5', cost: 0.0061 });

      const call = JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; system: string; cwd: string; claudecode: string | null; input: string };
      expect(call.args.slice(0, 7)).toEqual(['-p', '--output-format', 'json', '--tools', '', '--max-turns', '2']);
      // The schema reaches it whole, quotes and all, through cmd.exe on Windows too.
      expect(JSON.parse(call.args[call.args.indexOf('--json-schema') + 1]!)).toMatchObject({ type: 'object', required: ['diagnosis', 'candidates'] });
      expect(call.args.slice(-2)).toEqual(['--model', 'claude-opus-5-5']);
      // The system prompt is read from a file: its line breaks never go on a command line.
      expect(call.system).toContain('You improve AI agents');
      expect(call.args.some((a) => /[\r\n]/.test(a))).toBe(false);
      expect(call.input).toContain('Failed run 1 of 1');
      // Not inside the project, whose instructions would join the prompt; not as part of this session.
      expect(call.cwd.startsWith(project)).toBe(false);
      expect(call.claudecode).toBeNull();
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('shows the repairer the run with the redaction rules applied, as every export, pack and share link of a run', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
    // The customer's address is in the opening message, which the repairer is shown as part of the conversation.
    const failed = await record('jane.doe@example.com');
    mode = 'alternate';
    const before = mock.requests.length;
    const r = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'anthropic', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.outcome).toBe('fixed');
    const asked = mock.requests.slice(before).filter((q) => JSON.stringify(q.body.system).includes('You improve AI agents'));
    expect(asked).toHaveLength(1);
    const sent = JSON.stringify(asked[0]!.body);
    expect(sent).toContain('refund on order <EMAIL>');
    expect(sent).not.toContain('jane.doe@example.com');
    // A case detail is still screened out: the check runs on the run as recorded, on this machine.
    expect(report.candidates[0]).toMatchObject({ state: 'invalid', reason: expect.stringContaining('mentions A-1042') });
    expect(readFileSync(join(project, report.output.report), 'utf8')).not.toContain('jane.doe@example.com');
  });

  it("masks a run's own details in the system prompt it shows the repairer", async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ redact: [{ pattern: 'email', replace: '<EMAIL>' }] }));
    // A system prompt with the customer's address filled in at run time, as the agent's replays see it too.
    const system = { AGENT_SYSTEM: 'You are a support agent for the account of jane.doe@example.com. Follow the refund policy.' };
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs'], system);
    expect(recorded.code, recorded.out).toBe(0);
    const failed = /recording run (\w{26})/.exec(recorded.out)![1]!;
    mode = 'alternate';
    const before = mock.requests.length;
    const r = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'anthropic', '--json'], system);
    expect(r.stdout, r.out).toContain('"outcome"');
    const asked = mock.requests.slice(before).filter((q) => JSON.stringify(q.body.system).includes('You improve AI agents'));
    expect(asked).toHaveLength(1);
    const sent = JSON.stringify(asked[0]!.body);
    expect(sent).toContain('System prompt:\\nYou are a support agent for the account of <EMAIL>. Follow the refund policy.');
    expect(sent).not.toContain('jane.doe@example.com');
  });

  it('switches to a stronger model when only it rescues the runs, without asking a repairer, and applies it holding the folder’s repair lock', async () => {
    const { failed } = await runs();
    mode = 'stubborn';
    const before = mock.requests.length;
    // A build that fails unless the folder's repair lock is held: it runs in each candidate's
    // worktree once the candidate is in it, and after --apply writes the fix, which another repair
    // must not see half done.
    const lock = JSON.stringify(join(project, '.shadowlap', 'repair.lock')).replace(/"/g, "'");
    const build = `"${process.execPath}" -e "process.exit(require('node:fs').existsSync(${lock}) ? 0 : 3)"`;
    const r = await shadowlap(['repair', '--fixes', failed[0]!, '--keeps', 'label:good', '--expect', ORACLE, '--stronger', 'big-model', '--build', build, '--apply', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.targets[0]).toMatchObject({ outcome: 'blamed', rescuedBy: 'big-model' });
    expect(report.candidates).toEqual([expect.objectContaining({ source: 'model', state: 'accepted', after: 'big-model' })]);
    expect(report.repairer).toBeNull();
    expect(mock.requests.slice(before).some((q) => JSON.stringify(q.body.system).includes('You improve AI agents'))).toBe(false);
    // --apply leaves it in the working tree, and wrote it holding the lock, which is gone once the repair ends.
    expect(report.output.applied).toBe(true);
    expect(agentText()).toContain("?? 'big-model'");
    expect(report.warnings.filter((w) => w.startsWith(build))).toEqual([]);
    expect(existsSync(join(project, '.shadowlap', 'repair.lock'))).toBe(false);
  });

  it('says so when there is no passing path to learn from', async () => {
    const { failed } = await runs();
    mode = 'stubborn';
    const r = await shadowlap(['repair', '--fixes', failed[0]!, '--expect', ORACLE, '--repairer', 'anthropic', '--json']);
    expect(r.code).toBe(1);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.outcome).toBe('no-diagnosis');
    expect(report.why).toContain('--stronger');
    expect(report.targets[0]!.outcome).toBe('unrescuable');
    expect(existsSync(join(project, report.output.report))).toBe(true);

    // The search it made is stored on the run: a second repair doesn't make it again.
    const before = mock.requests.length;
    const again = JSON.parse((await shadowlap(['repair', '--fixes', failed[0]!, '--expect', ORACLE, '--repairer', 'anthropic', '--json'])).stdout) as Report & { targets: Array<{ reused: boolean }> };
    expect(again.targets[0]).toMatchObject({ outcome: 'unrescuable', reused: true });
    expect(mock.requests.length).toBe(before);
  });

  it('judges with a judge check, counts what the judge cost apart and against its budget, and never takes a judge call for a step', async () => {
    const { failed } = await runs();
    mode = 'alternate';
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ prices: { 'claude-haiku-4-5': { input: 1, output: 5 } }, tests: { 'goldens/f': { expect: { judge: JUDGED } } } }));
    // The failing run it is shown holds a judge call of its own, as a golden packed with its check does.
    const packed = await shadowlap(['pack', failed[0]!, 'goldens/f']);
    expect(packed.out).toContain('the judge answered no · it refunds $240');
    const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', JSON.stringify({ judge: JUDGED }), '--repairer', 'anthropic', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report & { cost: { blame: number; verify: number; judge?: number }; targets: Array<{ runId: string; steps: number }> };
    expect(report.outcome).toBe('fixed');
    expect(report.candidates.find((c) => c.state === 'accepted')!.after).toBe(FIX);
    // Four model calls of the agent's: the judge's call in the recording is none of blame's steps.
    expect(report.targets).toEqual([expect.objectContaining({ runId: failed[0], steps: 4 })]);
    expect(report.cost.judge).toBeGreaterThan(0);
    const md = readFileSync(join(project, report.output.report), 'utf8');
    expect(md).toMatch(/Cost: blame ≈\$[\d.]+, the repairer .*, verification ≈\$[\d.]+, judge checks ≈\$[\d.]+\./);
    // On runs never blamed, a budget its judge checks alone spend leaves the repair stopped.
    mode = 'refund';
    const fresh = [await record(), await record()];
    mode = 'alternate';
    const capped = await shadowlap(['repair', '--fixes', ...fresh, '--expect', JSON.stringify({ judge: JUDGED }), '--repairer', 'anthropic', '--budget', '0.001', '--json']);
    const stopped = JSON.parse(capped.stdout) as Report & { cost: { blame: number; judge?: number } };
    expect(stopped.outcome).toBe('stopped');
    expect(stopped.cost.judge).toBeGreaterThan(0.001);
  });

  it('stops when the budget runs out while it blames, rather than say what a search it never finished found', async () => {
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ prices: { 'small-model': { input: 5, output: 25 } } }));
    const failed = await record();
    mode = 'alternate';
    const r = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'anthropic', '--budget', '0.01', '--writes', 'block', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as Report & { cost: { blame: number } };
    expect(report.targets).toEqual([expect.objectContaining({ runId: failed, outcome: 'stopped' })]);
    expect(report.cost.blame).toBeGreaterThan(0.01);
    expect(report).toMatchObject({ outcome: 'stopped', why: 'the budget of $0.01 is spent', candidates: [], writes: 'block' });
    const md = readFileSync(join(project, report.output.report), 'utf8');
    expect(md).toContain('## Not fixed: the budget of $0.01 is spent');
    // The pull request body names the write policy the replays ran under.
    expect(md).toContain('Writes were blocked in every replay.');
    expect(md).not.toContain('stubbed');
  });

  it('finds out before it blames anything that an Anthropic repairer cannot sign in: no credentials, or a key refused', async () => {
    const failed = await record();
    mode = 'alternate';
    const home = mkdtempSync(join(tmpdir(), 'fp-home-'));
    // An API that refuses every key, as it refuses a revoked one.
    const refusing = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
    });
    await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', resolve));
    try {
      // No key, no token and no profile: an empty home, and none of this machine's ANTHROPIC_ variables.
      const unset = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith('ANTHROPIC_')).map((k) => [k, undefined]));
      const before = mock.requests.length;
      const nokey = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'anthropic', '--json'], { ...unset, ANTHROPIC_API_KEY: undefined, ANTHROPIC_BASE_URL: mock.url, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), APPDATA: home });
      expect(nokey.code, nokey.out).toBe(1);
      const report = JSON.parse(nokey.stdout) as Report & { noRepairer: string | null; cost: { blame: number } };
      expect(report).toMatchObject({ outcome: 'not-fixed', noRepairer: 'the repairer could not be asked: no Anthropic credentials', why: 'the repairer could not be asked: no Anthropic credentials', targets: [], candidates: [] });
      expect(report.warnings).toContain('the repairer could not be asked: no Anthropic credentials: set ANTHROPIC_API_KEY, or run ant auth login');
      expect(report.warnings).toContain('no failing run was blamed, as the repairer could not be asked, so nothing was spent: repair again once it can be');
      // Not one probe: blame never started.
      expect(mock.requests.length).toBe(before);
      expect(report.cost.blame).toBe(0);
      expect(existsSync(join(project, report.output.dir, 'report.json'))).toBe(true);
      expect(readFileSync(join(project, report.output.report), 'utf8')).toContain('No failing run was blamed: the repairer could not be asked: no Anthropic credentials.');

      const port = (refusing.address() as AddressInfo).port;
      const refused = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'anthropic', '--json'], { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` });
      expect(refused.code, refused.out).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({ outcome: 'not-fixed', noRepairer: 'the repairer could not be asked: the Anthropic API refused the credentials', targets: [] });
      expect(mock.requests.length).toBe(before);
    } finally {
      await new Promise<void>((resolve) => refusing.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('keeps the repair, its blames and its fix, and says why, when the repairer binary cannot be run', async () => {
    const failed = await record();
    mode = 'alternate';
    const bin = mkdtempSync(join(tmpdir(), 'fp-claude-'));
    try {
      // A claude that is there and can't be run: no execute bit. Found out only once blame has run.
      writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho {}\n', { mode: 0o644 });
      const eacces = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'claude-code', '--json'], { SHADOWLAP_CLAUDE: join(bin, 'claude') });
      expect(eacces.code, eacces.out).toBe(1);
      const again = JSON.parse(eacces.stdout) as Report & { noRepairer: string | null; fixes: Array<{ fixId: string }> };
      expect(again).toMatchObject({ outcome: 'not-fixed', noRepairer: `the repairer could not be asked: ${join(bin, 'claude')} could not be run` });
      expect(again.targets[0]).toMatchObject({ outcome: 'blamed' });
      expect(again.warnings.find((w) => w.startsWith('the repairer could not be asked'))).toContain('EACCES');
      expect(existsSync(join(project, again.output.dir, 'report.json'))).toBe(true);
      expect(again.fixes).toHaveLength(1);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('checks its flags before running anything', async () => {
    const { failed } = await runs();
    expect((await shadowlap(['repair', '--expect', ORACLE])).out).toContain('give the failing runs to repair');
    expect((await shadowlap(['repair', '--fixes', failed[0]!, '--pr'])).out).toContain('--pr opens a pull request from the branch --branch <name> makes');
    expect((await shadowlap(['repair', '--fixes', failed[0]!, '--repairer', 'openai'])).out).toContain('an openai repairer needs a model');
    expect((await shadowlap(['repair', '--fixes', failed[0]!, '--goldens', 'g'])).out).toContain('--goldens puts recordings into the project');
    // Recordings committed to a branch must be inside the repository: refused before any blame runs.
    const outside = await shadowlap(['repair', '--fixes', failed[0]!, '--branch', 'fix-refunds', '--goldens', '../elsewhere', '--json']);
    expect(outside.code).toBe(1);
    expect(JSON.parse(outside.stdout)).toEqual({ outcome: 'error', error: { message: "--goldens ../elsewhere is outside the repository, so its recordings can't be committed to a branch: give a folder inside it" } });
    expect(outside.out).not.toContain('blaming');
  });
});

describe('shadowlap repair, its candidates and its limits', { timeout: 120_000 }, () => {
  it('verifies every candidate in a worktree of its own, the working tree as it is, and leaves the working tree alone while verify runs', async () => {
    // The agent writes down, each time it runs, where it runs, the file it runs from, the working
    // tree's copy of it, and the untracked and ignored files it can read there.
    const probe = [
      "import { appendFileSync as logLine, existsSync as there, readFileSync as read } from 'node:fs';",
      "if (process.env.LIVE_LOG) logLine(process.env.LIVE_LOG, JSON.stringify({ cwd: process.cwd(), self: read(new URL(import.meta.url), 'utf8'), live: read(process.env.LIVE_FILE, 'utf8'), untracked: there('notes.txt') ? read('notes.txt', 'utf8') : null, ignored: there('.env.local') ? read('.env.local', 'utf8') : null }) + '\\n');",
    ].join('\n');
    writeFileSync(join(project, 'agent.mjs'), `${probe}\n${readFileSync(AGENT, 'utf8')}`);
    writeFileSync(join(project, '.gitignore'), '.shadowlap/\n.env.local\n');
    sh(project, 'git', ['commit', '-qam', 'agent that says where it runs']);
    const { failed } = await runs();
    // A change not committed, a file not tracked, and one git ignores: verify replays all three.
    writeFileSync(join(project, 'agent.mjs'), `${readFileSync(join(project, 'agent.mjs'), 'utf8')}// changed, not committed\n`);
    writeFileSync(join(project, 'notes.txt'), 'untracked note');
    writeFileSync(join(project, '.env.local'), 'IGNORED=1');
    // The project's own post-checkout hook, which a candidate's worktree is checked out without.
    const hookLog = join(project, '.shadowlap', 'hook.log');
    writeFileSync(join(project, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\necho ran >> "${hookLog}"\n`, { mode: 0o755 });
    const live = join(project, 'agent.mjs');
    const before = { text: readFileSync(live, 'utf8'), mtime: statSync(live).mtimeMs };
    mode = 'alternate';
    const log = join(project, '.shadowlap', 'live.log');
    const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--json'], { LIVE_LOG: log, LIVE_FILE: live });
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.outcome).toBe('fixed');

    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { cwd: string; self: string; live: string; untracked: string | null; ignored: string | null });
    // Blame probes the code as it is, in the working tree; every attempt verify made ran elsewhere.
    // (The worktrees are gone by now, so their paths are compared as the agent saw them.)
    const home = [project, realpathSync(project)];
    const verified = lines.filter((l) => !home.includes(l.cwd));
    expect(verified.length).toBeGreaterThan(10);
    for (const l of verified) {
      expect(home.some((h) => l.cwd.startsWith(h))).toBe(false);
      // The working tree never held a candidate while verify ran.
      expect(l.live).toBe(before.text);
      expect(l.self).toContain('// changed, not committed');
      expect(l).toMatchObject({ untracked: 'untracked note', ignored: 'IGNORED=1' });
    }
    // The candidate that was accepted was in the file the agent ran from, there and only there.
    expect(verified.some((l) => l.self.includes(FIX))).toBe(true);
    expect(readFileSync(live, 'utf8')).toBe(before.text);
    expect(statSync(live).mtimeMs).toBe(before.mtime);
    // Every worktree is gone, and git keeps nothing of them; none ran the project's hook.
    expect(sh(project, 'git', ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '))).toHaveLength(1);
    expect(existsSync(hookLog)).toBe(false);
    expect(sh(project, 'git', ['status', '--porcelain'])).toBe(' M agent.mjs\n?? notes.txt\n');
  });

  it('anchors a policy sentence the agent fills a value into, repairs it keeping the placeholder, and sets aside a rewrite that would read the environment', async () => {
    // The policy line is a template literal: the agent sends "Refunds above $100 need a manager."
    const templated = readFileSync(AGENT, 'utf8')
      .replace('const outbox =', 'const limit = 100;\nconst outbox =')
      .replace("process.env.AGENT_SYSTEM ?? 'You are a support agent. Follow the refund policy.'", () => 'process.env.AGENT_SYSTEM ?? `You are a support agent. Refunds above $${limit} need a manager.`');
    expect(templated).toContain('$${limit}');
    writeFileSync(join(project, 'agent.mjs'), templated);
    sh(project, 'git', ['commit', '-qam', 'the policy limit in the prompt']);
    const { failed } = await runs();
    mode = 'alternate';
    const secret = 'ghs_SECRETTOKENFORTHETEST0123456789';
    let shown = '';
    proposals = (prompt) => {
      shown = prompt;
      const id = Number(/\[(\d+)\] system prompt, in agent\.mjs: You are a support agent\. Refunds above \$\$\{limit\} need a manager\./.exec(prompt)?.[1]);
      return [
        { anchor: id, replace: 'You are a support agent. Refunds above $${limit} need a manager. ${process.env.GH_TOKEN}', strategy: 'Say what the policy is', why: 'Read it from the environment.' },
        { anchor: id, replace: 'You are a support agent. Refunds above $${limit} need a manager: escalate every refund above the limit.', strategy: 'Escalate refunds above the policy limit', why: 'Say what to do above the limit.' },
      ];
    };
    const before = mock.requests.length;
    const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--json'], { GH_TOKEN: secret });
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report & { candidates: Array<{ before: string; verify: unknown }> };
    // The repairer is shown the line as the file has it, placeholder and all, and told to keep it.
    expect(shown).toContain('agent.mjs: You are a support agent. Refunds above $${limit} need a manager.');
    expect(shown).toContain('Keep each one exactly as it is written');
    expect(report.outcome).toBe('fixed');
    expect(report.candidates.map((c) => [c.id, c.state])).toEqual([
      [1, 'invalid'],
      [2, 'accepted'],
    ]);
    expect(report.candidates[0]!.reason).toContain('it brings in ${process.env.GH_TOKEN}, which agent.mjs could fill in when the agent builds its prompt');
    expect(report.candidates[0]!.verify).toBeNull();
    expect(report.candidates[1]!.before).toBe('You are a support agent. Refunds above $${limit} need a manager.');
    expect(report.patch).toContain('+    system: process.env.AGENT_SYSTEM ?? `You are a support agent. Refunds above $${limit} need a manager: escalate every refund above the limit.`,');
    // Verify ran the agent with the value filled in, and the token went nowhere.
    const sent = mock.requests.slice(before).map((q) => JSON.stringify(q.body));
    expect(sent.some((b) => b.includes('Refunds above $100 need a manager: escalate every refund above the limit.'))).toBe(true);
    expect(sent.some((b) => b.includes(secret))).toBe(false);
  });

  it('rejects a rewrite whose growth alone is past --max-growth before verify runs anything for it', async () => {
    const { failed } = await runs();
    mode = 'alternate';
    const padding = 'Read the whole refund policy before you choose a tool, and say which rule applies. '.repeat(6).trim();
    proposals = (prompt) => {
      const id = Number(/\[(\d+)\] system prompt, in agent\.mjs:/.exec(prompt)?.[1]);
      return [{ anchor: id, replace: `${FIX} ${padding}`, strategy: 'Spell the policy out', why: 'More words.' }];
    };
    const before = mock.requests.length;
    const r = await shadowlap(['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as Report & { cost: { verify: number }; candidates: Array<{ verify: unknown }> };
    expect(report.outcome).toBe('not-fixed');
    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]).toMatchObject({ state: 'rejected', verify: null });
    expect(report.candidates[0]!.reason).toMatch(/^input tokens per run grow \d+% from the rewrite alone, at 5 characters a token, more than --max-growth 25%, so it was not verified$/);
    expect(report.cost.verify).toBe(0);
    // Nothing was sent with it: no attempt ran.
    expect(mock.requests.slice(before).some((q) => JSON.stringify(q.body).includes('say which rule applies'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('gives up on a repairer that does not answer in time, stops it, and says why', async () => {
    const failed = await record();
    mode = 'alternate';
    const bin = mkdtempSync(join(tmpdir(), 'fp-claude-'));
    try {
      // A claude that never answers, and writes down its process id.
      writeFileSync(join(bin, 'claude'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(bin, 'pid'))}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
      chmodSync(join(bin, 'claude'), 0o755);
      const started = Date.now();
      const r = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'claude-code', '--repairer-timeout', '2', '--json'], { SHADOWLAP_CLAUDE: join(bin, 'claude') });
      expect(r.code, r.out).toBe(1);
      const report = JSON.parse(r.stdout) as Report & { noRepairer: string | null };
      expect(report).toMatchObject({ outcome: 'not-fixed', noRepairer: 'the repairer could not be asked: it did not answer within 2 seconds', why: 'the repairer could not be asked: it did not answer within 2 seconds' });
      expect(report.warnings).toContain('the repairer could not be asked: it did not answer within 2 seconds: give it longer with --repairer-timeout <seconds>, or repair.timeout in shadowlap.config.json');
      expect(report.targets[0]).toMatchObject({ outcome: 'blamed' });
      expect(Date.now() - started).toBeLessThan(90_000);
      // It was stopped, not left running.
      const pid = Number(readFileSync(join(bin, 'pid'), 'utf8'));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('takes the time limit from repair.timeout in the config, and refuses one that is no number of seconds', async () => {
    const failed = await record();
    writeFileSync(join(project, 'shadowlap.config.json'), JSON.stringify({ repair: { timeout: 0 } }));
    const r = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'anthropic', '--json']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('repair.timeout must be a whole number of seconds, such as 600');
  });
});

describe('applyAccepted', () => {
  const candidate = { id: 1, source: 'repairer' as const, strategy: 's', why: 'w', surface: 'system prompt', file: 'agent.mjs', offset: 16, before: 'Follow the refund policy.', after: 'Follow the refund policy: escalate above the limit.', size: 26, state: 'accepted' as const, reason: null, verify: null };
  const content = "const system = 'Follow the refund policy.';\n";

  it('writes the accepted candidate into the working tree, and nothing when its patch is anything more', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-apply-'));
    try {
      writeFileSync(join(dir, 'agent.mjs'), content);
      writeFileSync(join(dir, 'other.mjs'), 'export {};\n');
      const fixed = content.replace(candidate.before, candidate.after);
      const report = { candidates: [candidate], accepted: 1, patch: unifiedDiff('agent.mjs', content, fixed), output: { dir: null, patch: 'fix.patch', report: null, goldens: [], applied: false, branch: null, pr: null } };
      // A patch that also changes another file is not the candidate's change: refused, nothing written.
      const more = { ...report, patch: report.patch + unifiedDiff('other.mjs', 'export {};\n', 'process.exit(1);\n') };
      expect(() => applyAccepted(more, dir)).toThrow(/the patch is not the accepted candidate's change \(it changes agent\.mjs and other\.mjs, where its accepted candidate changes agent\.mjs alone\), so nothing was applied/);
      expect(readFileSync(join(dir, 'agent.mjs'), 'utf8')).toBe(content);
      applyAccepted(report, dir);
      expect(readFileSync(join(dir, 'agent.mjs'), 'utf8')).toBe(fixed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recoverWorkingTree', () => {
  it('puts back an edit an interrupted repair left, and leaves a file someone changed since alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-journal-'));
    try {
      mkdirSync(join(dir, '.shadowlap'));
      const a = join(dir, 'a.txt');
      const b = join(dir, 'b.txt');
      writeFileSync(a, 'patched a');
      writeFileSync(b, 'edited by hand');
      const b64 = (s: string) => Buffer.from(s).toString('base64');
      writeFileSync(join(dir, '.shadowlap', 'repair-journal.json'), JSON.stringify({ files: [{ path: a, original: b64('original a'), patched: b64('patched a') }, { path: b, original: b64('original b'), patched: b64('patched b') }] }));
      expect(recoverWorkingTree(dir)).toEqual([a]);
      expect(readFileSync(a, 'utf8')).toBe('original a');
      expect(readFileSync(b, 'utf8')).toBe('edited by hand');
      expect(readdirSync(join(dir, '.shadowlap'))).toEqual([]);
      expect(recoverWorkingTree(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startRepair', () => {
  it('stops while another repair runs in the folder, leaving its candidate in place, and puts it back once that repair died', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-repair-lock-'));
    // A repair runs in the folder: it started there, and holds it until it ends.
    const running = spawn(process.execPath, ['--input-type=module', '-e', `
      const { startRepair } = await import(${JSON.stringify(new URL('../dist/repair.js', import.meta.url).href)});
      startRepair(${JSON.stringify(dir)});
      setInterval(() => {}, 1000);
      process.stdout.write('up\\n');`], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        let err = '';
        running.stdout.on('data', (d: Buffer) => d.toString().includes('up') && resolve());
        running.stderr.on('data', (d: Buffer) => (err += d.toString()));
        running.on('exit', (c) => reject(new Error(`exited with ${c}: ${err}`)));
      });
      // It is verifying a candidate: the file is edited, and the journal holds the original.
      const agent = join(dir, 'agent.txt');
      const journal = join(dir, '.shadowlap', 'repair-journal.json');
      const b64 = (s: string) => Buffer.from(s).toString('base64');
      writeFileSync(agent, 'candidate');
      writeFileSync(journal, JSON.stringify({ pid: running.pid, files: [{ path: agent, original: b64('original'), patched: b64('candidate') }] }));
      // A second repair started there stops before it touches anything.
      expect(() => startRepair(dir)).toThrow(/another shadowlap repair is running in this folder/);
      expect(readFileSync(agent, 'utf8')).toBe('candidate');
      expect(existsSync(journal)).toBe(true);
      // Killed with its candidate applied: the next repair takes the folder over at once and puts the file back.
      running.kill('SIGKILL');
      await new Promise((resolve) => (running.exitCode !== null || running.signalCode !== null ? resolve(null) : running.once('exit', resolve)));
      const { lock, restored } = startRepair(dir);
      expect(restored).toEqual([agent]);
      expect(readFileSync(agent, 'utf8')).toBe('original');
      releaseLock(lock);
      expect(readdirSync(join(dir, '.shadowlap'))).toEqual([]);
    } finally {
      running.kill('SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes the worktree a repair that died left in the temporary folder, and what git keeps of it', () => {
    const base = mkdtempSync(join(tmpdir(), 'shadowlap-repair-'));
    sh(project, 'git', ['worktree', 'add', '--detach', join(base, 'tree'), 'HEAD']);
    const trees = () => sh(project, 'git', ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree '));
    expect(trees()).toHaveLength(2);
    const { lock } = startRepair(project);
    releaseLock(lock);
    expect(trees()).toHaveLength(1);
    expect(existsSync(base)).toBe(false);
  });

  it('never takes over by its age the lock of a repair it can’t check, one in a container or on another machine sharing the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fp-repair-lock-'));
    try {
      mkdirSync(join(dir, '.shadowlap'));
      const path = join(dir, '.shadowlap', 'repair.lock');
      // Written an hour ago by a repair on another boot of a Linux kernel: its process can't be asked about from here.
      const text = JSON.stringify({ v: 2, pid: 7, host: 'build-box', start: 'another-boot:1', born: Date.now() - 3_600_000, token: 'there' });
      writeFileSync(path, text);
      const hourAgo = (Date.now() - 3_600_000) / 1000;
      utimesSync(path, hourAgo, hourAgo);
      expect(() => startRepair(dir)).toThrow(/another shadowlap repair is running in this folder.*if none is running, delete/);
      expect(readFileSync(path, 'utf8')).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('noDiagnosisWhy', () => {
  const target = (runId: string, outcome: 'unrescuable' | 'stopped' | 'passes' | 'error', note: string | null = null) => ({ runId, outcome, callNo: null, step: null, steps: 3, rescuedRunId: null, rescuedBy: null, reused: false, recorded: null, rescued: null, note });
  const WRITE = "every attempt failed on post_digest's recorded error (channel_not_found: #refunds)";
  const SAME = 'every attempt that passed at #1 answered it as the recording did';
  const A = '01M540RX39AAAAAAAAAAAAAAAA';
  const B = '01M540RX40BBBBBBBBBBBBBBBB';

  it("says what blame found when no answer of the model's lost the runs, not to try a stronger model", () => {
    const why = noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }], null);
    expect(why).toBe(`${WRITE}: no answer of the model's lost the run; look at the tools, the harness or the command`);
    expect(noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }], 'big-model')).toBe(why);
    // The same finding for two runs is said once; different ones, each with its run.
    expect(noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }, { target: target(B, 'unrescuable'), notTheAnswer: WRITE }], null)).toBe(`${WRITE}: no answer of the model's lost these runs; look at the tools, the harness or the command`);
    expect(noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }, { target: target(B, 'unrescuable'), notTheAnswer: SAME }], null)).toBe(`01M540RX39: ${WRITE}; 01M540RX40: ${SAME}: no answer of the model's lost these runs; look at the tools, the harness or the command`);
    // A run it couldn't search beside one it did: what it found stands.
    expect(noDiagnosisWhy([{ target: target(B, 'passes', `${B.slice(0, 10)} passes its oracle when replayed`), notTheAnswer: null }, { target: target(A, 'unrescuable'), notTheAnswer: WRITE }], null)).toContain(`${WRITE}: no answer`);
  });

  it('says why when no run could be searched, and suggests a stronger model only when a search rescued nothing', () => {
    const passes = `${B.slice(0, 10)} passes its oracle when replayed (the agent exits 0), so there is no failure to blame. Say what it should have done with --expect.`;
    expect(noDiagnosisWhy([{ target: target(B, 'passes', passes), notTheAnswer: null }], null)).toBe(`no failing run could be blamed: ${passes}`);
    // A run blame searched with nothing to say for it, beside one it found a write's error in: no telling it isn't the prompt.
    const unknown = noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: WRITE }, { target: target(B, 'unrescuable'), notTheAnswer: null }], null);
    expect(unknown).toContain('--stronger <model>');
    expect(noDiagnosisWhy([{ target: target(A, 'unrescuable'), notTheAnswer: null }], 'big-model')).toBe('neither resampling nor big-model rescued any failing run, so there is no passing path to learn from: the cause is likely in the code or the tools');
    // A search that stopped part way is no search: the run that couldn't be blamed says why.
    expect(noDiagnosisWhy([{ target: target(A, 'stopped'), notTheAnswer: null }, { target: target(B, 'passes', passes), notTheAnswer: null }], null)).toBe(`no failing run could be blamed: ${passes}`);
  });

  it('says blame did not settle a run whose first probe could not tell, never that resampling rescued nothing', () => {
    const unsettled = (runId: string) => ({ target: { ...target(runId, 'unrescuable'), unsettled: true }, notTheAnswer: null });
    expect(noDiagnosisWhy([unsettled(A)], 'big-model')).toBe('blame did not settle where the failing run was lost: its first probe could not tell whether resampling rescues it, so there is no passing path to learn from yet; shadowlap blame 01M540RX39 says what settles it');
    expect(noDiagnosisWhy([unsettled(A), unsettled(B)], null)).toBe('blame did not settle where the failing runs were lost: its first probe could not tell whether resampling rescues them, so there is no passing path to learn from yet; shadowlap blame 01M540RX39 01M540RX40 says what settles it');
    // Beside a run resampling rescued nothing in, the search found that much.
    expect(noDiagnosisWhy([unsettled(A), { target: target(B, 'unrescuable'), notTheAnswer: null }], null)).toContain('resampling rescued no failing run');
  });
});
