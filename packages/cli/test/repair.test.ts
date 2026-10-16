import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { recoverWorkingTree } from '../src/repair.js';

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

function script(ctx: ScriptContext) {
  const system = JSON.stringify(ctx.request.system ?? '');
  const usage = { input_tokens: Math.round(JSON.stringify(ctx.request).length / 4), output_tokens: 30 };
  if (system.includes('You improve AI agents')) {
    const user = JSON.stringify(ctx.request.messages);
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

describe('shadowlap repair', () => {
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
    expect(md).toMatch(/\| good \| `\w{10}` \| kept \| 4 of 4 passed \|/);
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
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { diagnosis: 'd', candidates }, modelUsage: { 'claude-opus-5-5': {} }, usage: { input_tokens: 900, output_tokens: 120 }, total_cost_usd: 0.0061 }));
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

  it('switches to a stronger model when only it rescues the runs, without asking a repairer', async () => {
    const { failed } = await runs();
    mode = 'stubborn';
    const before = mock.requests.length;
    const r = await shadowlap(['repair', '--fixes', failed[0]!, '--keeps', 'label:good', '--expect', ORACLE, '--stronger', 'big-model', '--apply', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.targets[0]).toMatchObject({ outcome: 'blamed', rescuedBy: 'big-model' });
    expect(report.candidates).toEqual([expect.objectContaining({ source: 'model', state: 'accepted', after: 'big-model' })]);
    expect(report.repairer).toBeNull();
    expect(mock.requests.slice(before).some((q) => JSON.stringify(q.body.system).includes('You improve AI agents'))).toBe(false);
    // --apply leaves it in the working tree.
    expect(report.output.applied).toBe(true);
    expect(agentText()).toContain("?? 'big-model'");
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
