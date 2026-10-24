import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext, type ScriptResult } from '@shadowlap-testing/mock-anthropic';

/**
 * `shadowlap verify` keeps a good run against its own baseline: the same run under the code before
 * the change, attempt for attempt. The project is a git repository whose agent reads its system
 * prompt from prompt.txt, so a change to the prompt is a change in the working tree, and HEAD (or the
 * commit --base names) is the code before it, checked out on its own for the baseline's attempts.
 *
 * The mock plays the model as in verify.test.ts: the original prompt refunds whatever it is asked;
 * the good fix escalates the $240 refund and still refunds the $40 one; the bad fix names a tool the
 * agent doesn't have, so the $40 refund crashes it. The oracle: never refund $240.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const SUPPORT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } });
const ORIGINAL = 'You are a support agent.';
const GOOD_FIX = 'You are a support agent. Escalate refunds above $100.';
const BAD_FIX = 'You are a support agent. Escalate refunds above $100; use refund_order for the rest.';

let mock: MockServer;
let work: string;
let db: string;

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
      if (small && system.includes('refund_order')) return { message: message([toolUse('refund_order', { order_id: order }, `toolu_decide_${ctx.requestNo}`)]) };
      if (!small && system.includes('Escalate refunds above $100')) return { message: message([text('Above the limit.'), toolUse('escalate', { reason: 'refund of $240 is above $100' }, `toolu_decide_${ctx.requestNo}`)]) };
      return { message: message([toolUse('issue_refund', { order_id: order, amount: small ? 40 : 240 }, `toolu_decide_${ctx.requestNo}`)]) };
    }
    default:
      return { message: message([text('Done.')], { stop_reason: 'end_turn' }) };
  }
}

const git = (...args: string[]) => execFileSync('git', args, { cwd: work, stdio: 'ignore' });

beforeAll(async () => {
  mock = await startMockAnthropic({ script: answer, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
beforeEach(() => {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  work = mkdtempSync(join(tmpdir(), 'fp-verify-base-'));
  db = join(work, 'store.db');
  // The agent reads its prompt from the file next to it, so the base's checkout reads the base's.
  writeFileSync(join(work, 'agent.mjs'), `import { readFileSync } from 'node:fs';\nprocess.env.AGENT_SYSTEM = readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8').trim();\nawait import(${JSON.stringify(SUPPORT)});\n`);
  writeFileSync(join(work, 'prompt.txt'), `${ORIGINAL}\n`);
  writeFileSync(join(work, '.gitignore'), 'store.db*\noutbox.jsonl\n');
  git('init', '-q');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'user.name', 'Dev');
  git('add', '.');
  git('commit', '-q', '-m', 'agent');
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd: work, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', AGENT_OUTBOX: join(work, 'outbox.jsonl'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const r = await shadowlap(['run', '--', process.execPath, join(work, 'agent.mjs'), ...(order ? [order] : [])]);
  expect(r.code, r.out).toBe(0);
  return /recording run (\w{26})/.exec(r.out)![1]!;
}

interface Json {
  verdict: string;
  warnings: string[];
  kept: { source: string; margin: number; risk: number; max: number; revision: string | null; label: string | null } | null;
  runs: Array<{ runId: string; role: string; outcome: string; passes: number; attempts: number; decision: string | null; rate: { decision: string; sentence: string } | null; baseline?: { passes: number; attempts: number; source: string; revision: string | null }; margin?: number; drop?: { lo: number | null; hi: number | null; confidence: number; method: string }; baselineRuns?: Array<{ runId: string; passed: boolean; forkedAt: number | null }>; noBaseline?: string }>;
  cost: { attempts: number };
}

const head = () => execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: work }).toString().trim();

describe('shadowlap verify against a baseline', () => {
  it('keeps a good run the change does not hurt, against the same run at HEAD, attempt for attempt', async () => {
    const failed = await record();
    const good = await record('B-7');
    writeFileSync(join(work, 'prompt.txt'), `${GOOD_FIX}\n`);
    // A wide margin keeps a run whose arms pass every attempt after 6 pairs, not the 38 the default's 10 points take.
    const r = await shadowlap(['verify', '--fixes', failed, '--keeps', good, '--expect', ORACLE, '--margin', '0.5', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.verdict).toBe('accepted');
    expect(report.warnings).toEqual(['no held-out runs: the change was only tried on the runs it was written for (--holdout)']);
    expect(report.kept).toMatchObject({ source: 'paired', margin: 0.5, risk: 0.05, max: 200, label: head() });
    const keptRun = report.runs.find((x) => x.runId === good)!;
    expect(keptRun).toMatchObject({ role: 'good', outcome: 'kept', decision: 'pass', passes: 6, attempts: 6, baseline: { passes: 6, attempts: 6, source: 'paired', revision: head() }, margin: 0.5 });
    expect(keptRun.drop!.hi).toBeLessThanOrEqual(0.5);
    expect(keptRun.rate!.sentence).toMatch(new RegExp(`^kept · 6 of 6 passed, baseline 6 of 6 · drop <= 0\\.\\d\\d \\(95%\\) · kept unless it drops 50\\+ points below its baseline at ${head()}, attempt for attempt, <= 5% risk, up to 200 pairs$`));
    // The target is fixed as before: it passes its gate on its own.
    expect(report.runs.find((x) => x.runId === failed)).toMatchObject({ outcome: 'fixed', passes: 12, attempts: 12 });
    expect(report.runs.find((x) => x.runId === failed)!.baseline).toBeUndefined();
    // Each baseline attempt forked where the change's did, the first model call, and ran under HEAD's prompt.
    expect(keptRun.baselineRuns).toHaveLength(6);
    expect(keptRun.baselineRuns!.every((b) => b.passed && b.forkedAt === 1)).toBe(true);
    expect(report.cost.attempts).toBe(12 + 6 + 6);
    const store = Store.open(db);
    try {
      const base = store.allRuns().filter((x) => x.meta?.verify?.arm === 'baseline');
      expect(base).toHaveLength(6);
      expect(base.every((x) => x.meta!.verify!.revision === head() && x.parentRunId === good)).toBe(true);
      // The baseline ran in a checkout of HEAD, which is gone once verify is done.
      expect(base.every((x) => x.command.cwd !== work && x.command.cwd.includes(`${join('.shadowlap', 'verify')}`))).toBe(true);
      const requests = mock.requests.filter((q) => q.body.messages?.[0] && JSON.stringify(q.body.messages[0].content).includes('B-7'));
      expect(requests.some((q) => JSON.stringify(q.body.system ?? '') === JSON.stringify(ORIGINAL))).toBe(true);
    } finally {
      store.close();
    }
    expect(existsSync(join(work, '.shadowlap', 'verify')) ? readdirSync(join(work, '.shadowlap', 'verify')) : []).toEqual([]);
    expect(execFileSync('git', ['worktree', 'list'], { cwd: work }).toString().trim().split('\n')).toHaveLength(1);
  });

  it('breaks a good run the change makes fail where its baseline passes, and says how far it dropped', async () => {
    const failed = await record();
    const good = await record('B-7');
    writeFileSync(join(work, 'prompt.txt'), `${BAD_FIX}\n`);
    const r = await shadowlap(['verify', '--fixes', failed, '--keeps', good, '--expect', ORACLE]);
    expect(r.code, r.out).toBe(1);
    expect(r.stdout).toContain('✗ Rejected: the change fixes 1 of 1 target run and keeps 0 of 1 good run');
    // Seven pairs where the change failed and its baseline passed: broken, its drop bounded below.
    expect(r.stdout).toMatch(/· good run \w{10} broken: 0 of 7 passed, baseline 7 of 7 · drop >= 0\.\d\d \(95%\) \(the agent exited with code 1\)/);
    expect(r.stdout).toContain(`A good run that forks is kept unless it drops 10+ points below its baseline at ${head()}, attempt for attempt, <= 5% risk, up to 200 pairs.`);
    expect(r.stdout).not.toMatch(/at least|of the time/);
  });

  it('runs the baseline at the commit --base names when the change is committed, and refuses one that is not a commit', async () => {
    const good = await record('B-7');
    const before = head();
    writeFileSync(join(work, 'prompt.txt'), `${BAD_FIX}\n`);
    git('commit', '-q', '-am', 'the change');
    const r = await shadowlap(['verify', '--keeps', good, '--expect', ORACLE, '--base', before, '--json']);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.kept).toMatchObject({ source: 'paired', label: before });
    expect(report.runs[0]).toMatchObject({ outcome: 'broken', baseline: { source: 'paired', revision: before } });
    // With nothing changed against HEAD and no --base, there is nothing to compare with: judged alone, and said so.
    const alone = await shadowlap(['verify', '--keeps', good, '--expect', ORACLE, '--json']);
    const aloneReport = JSON.parse(alone.stdout) as Json;
    expect(aloneReport.runs[0]).toMatchObject({ outcome: 'broken', noBaseline: expect.stringContaining('the working tree has no change against HEAD') });
    expect(aloneReport.runs[0]!.baseline).toBeUndefined();
    expect(aloneReport.warnings.some((w) => w.includes('judged by the gate on its own, not against the code before the change'))).toBe(true);
    const bad = await shadowlap(['verify', '--keeps', good, '--base', 'no-such-commit']);
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain('--base no-such-commit is not a commit in this repository');
  });

  it('settles a good run the change does not touch with one free replay, and needs no baseline for it', async () => {
    const good = await record('B-7');
    // A change that sends no request differently: the run replays clean.
    writeFileSync(join(work, 'README.md'), 'notes\n');
    git('add', 'README.md');
    const r = await shadowlap(['verify', '--keeps', good, '--expect', ORACLE, '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.runs[0]).toMatchObject({ outcome: 'kept', deterministic: true, attempts: 1 });
    expect(report.runs[0]!.baseline).toBeUndefined();
    expect(report.kept).toBeNull();
    expect(report.cost.attempts).toBe(1);
  });

  it('pairs no baseline with a replay that went around Shadowlap: its gate fails the run, as before', async () => {
    const good = await record('B-7');
    writeFileSync(join(work, 'prompt.txt'), `${GOOD_FIX}\n`);
    // The client fixes its base URL, and nothing tells Shadowlap that host is a model server: the agent
    // reaches the model directly. Such an attempt holds nothing the recording does, and forks nowhere.
    const around = { SHADOWLAP_UPSTREAM_ANTHROPIC: '', SHADOWLAP_CAPTURE: 'off', AGENT_BASE_URL: mock.url };
    const r = await shadowlap(['verify', '--keeps', good, '--expect', ORACLE, '--json'], around);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.runs[0]).toMatchObject({ outcome: 'broken', deterministic: false, attempts: 3 });
    expect(report.runs[0]!.baseline).toBeUndefined();
    expect(report.runs[0]!.baselineRuns).toBeUndefined();
    expect(report.warnings.join(' ')).toContain('the replay made no calls through Shadowlap');
  });

  it('says a good run with no test history was judged on its own under --baseline history', async () => {
    const failed = await record();
    const good = await record('B-7');
    writeFileSync(join(work, 'prompt.txt'), `${GOOD_FIX}\n`);
    const r = await shadowlap(['verify', '--fixes', failed, '--keeps', good, '--expect', ORACLE, '--baseline', 'history', '--json']);
    expect(r.code, r.out).toBe(0);
    const report = JSON.parse(r.stdout) as Json;
    expect(report.runs.find((x) => x.runId === good)).toMatchObject({ outcome: 'kept', noBaseline: expect.stringContaining("is no golden's run, so it has no test history") });
    const flags = await shadowlap(['verify', '--keeps', good, '--baseline', 'history', '--base', 'HEAD']);
    expect(flags.code).not.toBe(0);
    expect(flags.out).toContain('--base and --build check out the code a paired baseline runs at');
  });
});
