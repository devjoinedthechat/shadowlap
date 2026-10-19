import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { startFakeS3, type FakeS3 } from '../../remote/test/fakes/s3.js';
import { departures, type ShapeName } from './json-shapes.js';

/**
 * The JSON of the commands that print the dashboard's read models and the reports behind them:
 * blame, verify, repair and fix; test and bisect; tasks; and the team store's. Each is held to its
 * docs both ways (json-shapes.ts): every field the shape lists is printed, and every field printed
 * is named where its command's JSON is documented. The mock plays the agent's model and the
 * repairer, a scratch git repository holds the agent, and a stand-in bucket plays the team store.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const SUPPORT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const TRAINING = fileURLToPath(new URL('./training-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } });
const FIX = 'You are a support agent. Follow the refund policy: escalate every refund above the limit it sets.';

let mock: MockServer;
let alternate = false;
let decisions = 0;

/** The support agent refunds $240 against policy; asked again, it escalates every other time, and always under the fixed prompt or as claude-good. */
function script(ctx: ScriptContext) {
  const system = JSON.stringify(ctx.request.system ?? '');
  const usage = { input_tokens: Math.round(JSON.stringify(ctx.request).length / 4), output_tokens: 30 };
  if (system.includes('You improve AI agents')) {
    const user = JSON.stringify(ctx.request.messages).replace(/\\n/g, '\n');
    const anchor = Number(/\[(\d+)\] system prompt, in [^:]+:/.exec(user)?.[1]);
    return { message: message([text(JSON.stringify({ diagnosis: 'The prompt never says what to do above the limit.', candidates: [{ anchor, replace: FIX, strategy: 'Escalate refunds above the policy limit', why: 'The policy sets a limit.' }] }))], usage) };
  }
  if (system.includes('You summarize')) return { message: message([text(system.includes('Be brief') ? 'Short.' : 'Ticket summarized.')], usage) };
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
      const escalates = system.includes('escalate every refund above the limit') || ctx.request.model === 'claude-good' || (alternate && decisions % 2 === 0);
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

function cli(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'test-key', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', SHADOWLAP_HOME: join(cwd, '.home'), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out, stdout }));
  });
}
function json<T = Record<string, unknown>>(r: { stdout: string; out: string }): T {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new Error(`not JSON:\n${r.out}`);
  }
}
const sh = (cwd: string, cmd: string, args: string[]) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
function recorded(r: { out: string }): string {
  const id = /recording run (\w{26})/.exec(r.out)?.[1];
  if (!id) throw new Error(`no run recorded:\n${r.out}`);
  return id;
}

/** Each value against its shape: what it doesn't print, and what it prints that the docs don't name. */
function hold(values: Array<[ShapeName, unknown]>): void {
  const found = values.flatMap(([shape, value]) => {
    if (!value || typeof value !== 'object') return [`${shape}: nothing to check (${JSON.stringify(value)})`];
    const d = departures(shape, value);
    return [...d.missing, ...d.extra];
  });
  expect(found).toEqual([]);
}
const first = (list: unknown) => (list as unknown[])[0];

describe('Fixes: blame, verify, repair and fix', () => {
  let project = '';
  beforeAll(() => {
    // Inside this repository, so the agent's imports resolve; a git repository of its own, for repair.
    project = join(fileURLToPath(new URL('.', import.meta.url)), `.tmp-json-contract-${process.pid}`);
    mkdirSync(project);
    copyFileSync(SUPPORT, join(project, 'agent.mjs'));
    writeFileSync(join(project, '.gitignore'), '.shadowlap/\n.home/\n');
    sh(project, 'git', ['init', '-q', '-b', 'main']);
    sh(project, 'git', ['config', 'user.name', 'Test']);
    sh(project, 'git', ['config', 'user.email', 'test@example.com']);
    sh(project, 'git', ['add', '.']);
    sh(project, 'git', ['commit', '-q', '-m', 'agent']);
  });
  afterAll(() => rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

  it('print what docs/blame.md, verify.md, repair.md and cli.md say, and fix apply leaves goldens whose test report does too', async () => {
    alternate = false;
    const failed = [recorded(await cli(project, ['run', '--', process.execPath, 'agent.mjs'])), recorded(await cli(project, ['run', '--', process.execPath, 'agent.mjs']))];
    const good = recorded(await cli(project, ['run', '--', process.execPath, 'agent.mjs', 'B-7']));
    expect((await cli(project, ['label', good, 'good'])).code).toBe(0);
    alternate = true;

    const blame = await cli(project, ['blame', failed[0]!, '--expect', ORACLE, '--attempts', '2', '--passes', '1', '--json']);
    expect(blame.code, blame.out).toBe(0);
    const b = json(blame);
    expect(b.outcome).toBe('blamed');
    hold([['blame', b], ['blameCall', b.blamed], ['blameCall', b.lost], ['blameContrast', b.contrast], ['blameProbe', first(b.probes)], ['blameFix', b.fix]]);

    const verify = await cli(project, ['verify', '--fixes', failed[0]!, '--keeps', 'label:good', '--expect', ORACLE, '--attempts', '2', '--json']);
    const v = json(verify);
    hold([['verify', v], ['verifyRun', first(v.runs)], ['verifySummary', v.summary]]);

    const repair = await cli(project, ['repair', '--fixes', ...failed, '--keeps', 'label:good', '--expect', ORACLE, '--repairer', 'anthropic', '--json']);
    expect(repair.code, repair.out).toBe(0);
    const r = json(repair);
    expect(r.outcome).toBe('fixed');
    hold([['repair', r], ['repairTarget', first(r.targets)], ['repairCandidate', first(r.candidates)], ['repairOutput', r.output]]);
    // Each candidate's verification is printed as verify --json prints one, the accepted one with the verdict it was kept as.
    const tried = (r.candidates as Array<{ id: number; verify: { runs: unknown[]; summary: unknown; verifyId: string | null } | null }>).filter((c) => c.verify);
    expect(tried.length).toBeGreaterThan(0);
    for (const c of tried) hold([['verify', c.verify], ['verifyRun', first(c.verify!.runs)], ['verifySummary', c.verify!.summary]]);
    expect(tried.find((c) => c.id === r.accepted)!.verify!.verifyId).toBe(r.verifyId);

    const ls = json(await cli(project, ['fix', 'ls', '--json']));
    hold([['fixList', ls], ['fixRow', first(ls.fixes)], ['fixCounts', ls.counts]]);
    const fixId = (first(ls.fixes) as { fixId: string }).fixId;
    hold([['fixShow', json(await cli(project, ['fix', 'show', fixId, '--json']))]]);
    const unknown = await cli(project, ['fix', 'show', 'fx-nosuch', '--json']);
    expect(unknown.code).toBe(1);
    hold([['fixError', json(unknown)]]);
    const apply = await cli(project, ['fix', 'apply', fixId, '--json']);
    expect(apply.code, apply.out).toBe(0);
    hold([['fixApply', json(apply)]]);
    // Recording a pull request asks GitHub nothing.
    const pr = await cli(project, ['fix', 'pr', fixId, 'https://github.com/acme/support-agent/pull/138', '--json']);
    expect(pr.code, pr.out).toBe(0);
    expect(json(pr).pr).toMatchObject({ number: 138, state: 'open' });
    hold([['fixPr', json(pr)]]);

    // The goldens fix apply copied, tested with the fixed agent.
    const test = await cli(project, ['test', 'goldens/*', '--json', 'report.json']);
    expect(test.code, test.out).toBe(0);
    const report = JSON.parse(readFileSync(join(project, 'report.json'), 'utf8')) as Record<string, unknown>;
    hold([['test', report], ['testResult', first(report.results)]]);
  }, 300_000);
});

describe('bisect', () => {
  // A tiny agent with one model call, its system prompt read from a file: no imports, so it runs in bisect's worktrees.
  const AGENT = `import { readFileSync } from 'node:fs';
const system = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8').trim();
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'small-model', max_tokens: 64, system, messages: [{ role: 'user', content: 'Summarize ticket T-1.' }] }) });
console.log((await res.json()).content.map((b) => b.text ?? '').join(''));
`;

  it('prints what docs/cli.md says', async () => {
    const project = mkdtempSync(join(tmpdir(), 'sl-json-bisect-'));
    try {
      sh(project, 'git', ['init', '-q', '-b', 'main']);
      sh(project, 'git', ['config', 'user.email', 'test@example.com']);
      sh(project, 'git', ['config', 'user.name', 'Test']);
      writeFileSync(join(project, '.gitignore'), '.shadowlap/\n.home/\n');
      writeFileSync(join(project, 'agent.mjs'), AGENT);
      writeFileSync(join(project, 'prompt.txt'), 'You summarize support tickets.\n');
      sh(project, 'git', ['add', '.']);
      sh(project, 'git', ['commit', '-q', '-m', 'Start']);
      const start = sh(project, 'git', ['rev-parse', '--short', 'HEAD']);
      const run = recorded(await cli(project, ['run', '--', process.execPath, 'agent.mjs']));
      expect((await cli(project, ['pack', run, 'goldens/summary'])).code).toBe(0);
      writeFileSync(join(project, 'prompt.txt'), 'You summarize support tickets. Be brief.\n');
      sh(project, 'git', ['commit', '-q', '-am', 'Ask for brevity']);
      const r = await cli(project, ['bisect', 'goldens/summary', '--good', start, '--json']);
      expect(r.code, r.out).toBe(0);
      const j = json(r);
      expect(j.outcome).toBe('found');
      hold([['bisect', j], ['bisectTarget', j.target], ['bisectCommit', j.good], ['bisectCommit', j.bad], ['bisectStep', first(j.steps)]]);
      // The first bad commit is a commit, with why it fails there.
      const { why, ...commit } = j.first as { why: string };
      expect(why).toContain('diverged at call 1');
      hold([['bisectCommit', commit]]);
    } finally {
      rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

describe('tasks', () => {
  it('lists, scores and the models to score print what docs/training.md says', async () => {
    const work = mkdtempSync(join(tmpdir(), 'sl-json-tasks-'));
    try {
      alternate = false;
      const run = recorded(await cli(work, ['run', '--', process.execPath, TRAINING]));
      expect((await cli(work, ['pack', run, 'goldens/refund'])).code).toBe(0);
      writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ tests: { 'goldens/refund': { expect: { tools: { issue_refund: 0, escalate: 1 } }, task: { takeover: 5, why: 'decides between refunding and escalating', rewards: 'escalate above the limit' } } } }));
      const ls = json(await cli(work, ['tasks', '--json']));
      hold([['tasks', ls], ['task', first(ls.tasks)], ['oneSided', ls.oneSided]]);
      const score = await cli(work, ['tasks', 'score', '--model', 'claude-good', '--attempts', '1', '--json']);
      expect(score.code, score.out).toBe(0);
      const s = json(score);
      const scored = first(s.tasks) as { attempts: unknown[] };
      hold([['tasksScore', s], ['tasksScoreTask', scored], ['tasksScoreAttempt', scored.attempts[0]]]);
      // No provider to list: their notes, and the models the recording and the score used.
      const models = await cli(work, ['tasks', 'models', '--json', '--timeout', '200'], { SHADOWLAP_UPSTREAM_ANTHROPIC: 'http://127.0.0.1:9', OLLAMA_HOST: '127.0.0.1:9', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' });
      expect(models.code, models.out).toBe(0);
      const m = json(models);
      hold([['tasksModels', m], ['modelChoice', first(m.choices)], ['modelNote', first(m.notes)]]);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});

describe('the team store', () => {
  let s3: FakeS3;
  beforeAll(async () => {
    s3 = await startFakeS3({ keys: { AKIDJSONCONTRACT: 'json/contract/secret' }, bucket: 'agent-runs', versioning: 'Enabled', encryption: 'aws:kms' });
  });
  afterAll(async () => {
    await s3.close();
  });

  it('push, pull, share and store print what docs/cli.md says', async () => {
    const work = mkdtempSync(join(tmpdir(), 'sl-json-team-'));
    try {
      const env = { AWS_ACCESS_KEY_ID: 'AKIDJSONCONTRACT', AWS_SECRET_ACCESS_KEY: 'json/contract/secret', AWS_EC2_METADATA_DISABLED: 'true', SHADOWLAP_AUTHOR: 'dana' };
      // --check first: a bucket these credentials can't find is refused and nothing is written, then the one they can is set.
      const refused = await cli(work, ['store', 'set', `s3://no-such-bucket/team?endpoint=${s3.url}`, '--check', '--json'], env);
      expect(refused.code, refused.out).toBe(1);
      expect(json(refused)).toMatchObject({ set: false });
      const checked = await cli(work, ['store', 'set', `s3://agent-runs/team?endpoint=${s3.url}`, '--check', '--json'], env);
      expect(checked.code, checked.out).toBe(0);
      expect(json(checked)).toMatchObject({ set: true, check: { ok: true, pullRequest: null } });
      const set = await cli(work, ['store', 'set', `s3://agent-runs/team?endpoint=${s3.url}`, '--json'], env);
      expect(set.code, set.out).toBe(0);
      const check = await cli(work, ['store', 'check', '--json'], env);
      expect(check.code, check.out).toBe(0);
      const run = recorded(await cli(work, ['run', '--', process.execPath, TRAINING], env));
      const push = await cli(work, ['push', run, '--json'], env);
      expect(push.code, push.out).toBe(0);
      const pull = await cli(work, ['pull', '--json'], env);
      expect(pull.code, pull.out).toBe(0);
      const share = await cli(work, ['share', run, '--json'], env);
      expect(share.code, share.out).toBe(0);
      hold([
        ['storeSet', json(set)],
        ['storeSetChecked', json(checked)],
        ['storeSetRefused', json(refused)],
        // What --check adds is the check as store check prints it.
        ['storeCheck', json(checked).check],
        ['storeCheck', json(refused).check],
        ['storeCheck', json(check)],
        ['push', json(push)],
        ['pushFixes', (json(push) as { fixes: unknown }).fixes],
        ['pull', json(pull)],
        ['pullFixes', (json(pull) as { fixes: unknown }).fixes],
        ['share', json(share)],
        ['storeShow', json(await cli(work, ['store', 'show', '--json'], env))],
        ['storePolicy', json(await cli(work, ['store', 'policy', '--json'], env))],
        ['storeCi', json(await cli(work, ['store', 'ci', '--provider', 'github', '--json'], env))],
        ['storePushFromCi', json(await cli(work, ['store', 'push-from-ci', 'off', '--json'], env))],
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);
});
