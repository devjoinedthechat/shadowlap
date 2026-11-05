import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, toolUse, type MockServer, type ScriptContext } from '@shadowlap-testing/mock-anthropic';
import { REPAIR_CANDIDATES } from '@shadowlap/engine';
import { removeTempProject, tempProject } from '../../../testing/temp-project.mjs';

/**
 * `--candidates` is the most rewrites a repair tries, not only how many it asks for: a repairer that
 * answers with more has only its first that many tried, in its own order, before they are sorted
 * smallest first, and the repair says so. Run repair's estimate prices that many, each verified up to
 * twice (engine estimates/repair.ts), so the price and its words agree with what runs.
 *
 * The support agent refunds a $240 order against policy. Until the repairer answers, it escalates
 * every other time, so blame finds where the run was lost; after that it always refunds, so verify
 * rejects every candidate and tries each it may.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./support-agent.mjs', import.meta.url));
const ORACLE = JSON.stringify({ tools: { issue_refund: { count: 0, args: { amount: 240 } } } });
const PROMPT = 'You are a support agent. Follow the refund policy.';

/** Six rewrites of the system prompt, the larger first: sorted smallest first, the last three would be tried before them. */
const REWRITES = [
  'You are a support agent. Follow the refund policy, and read all of it before each refund.',
  'You are a support agent. Follow the refund policy, and check the order first.',
  'You are a support agent. Follow the refund policy, and be polite.',
  'You are a support agent. Follow the policy.',
  'You are an agent. Follow the refund policy.',
  'You are support. Follow the refund policy.',
];

let mock: MockServer;
let project: string;
let decisions = 0;
let repairerAnswered = false;

function script(ctx: ScriptContext) {
  const system = JSON.stringify(ctx.request.system ?? '');
  const usage = { input_tokens: Math.round(JSON.stringify(ctx.request).length / 4), output_tokens: 30 };
  if (system.includes('You improve AI agents')) {
    repairerAnswered = true;
    const user = JSON.stringify(ctx.request.messages).replace(/\\n/g, '\n');
    const anchor = Number(/\[(\d+)\] system prompt, in agent\.mjs:/.exec(user)?.[1]);
    const candidates = REWRITES.map((replace, i) => ({ anchor, replace, strategy: `Rewrite ${i + 1}`, why: 'It may help.' }));
    return { message: message([text(JSON.stringify({ diagnosis: 'The prompt does not say what to do above the limit.', candidates }))], usage) };
  }
  switch (ctx.assistantTurns) {
    case 0:
      return { message: message([toolUse('lookup_order', { order_id: 'A-1042' }, `toolu_lookup_${ctx.requestNo}`)], usage) };
    case 1:
      return { message: message([toolUse('read_policy', {}, `toolu_policy_${ctx.requestNo}`)], usage) };
    case 2: {
      decisions++;
      const escalates = !repairerAnswered && decisions % 2 === 0;
      return {
        message: escalates
          ? message([text('Above the limit.'), toolUse('escalate', { reason: 'above the refund limit' }, `toolu_decide_${ctx.requestNo}`)], usage)
          : message([toolUse('issue_refund', { order_id: 'A-1042', amount: 240 }, `toolu_decide_${ctx.requestNo}`)], usage),
      };
    }
    default:
      return { message: message([text('Done.')], { ...usage, stop_reason: 'end_turn' }) };
  }
}

/** How long the test may run before it counts as hung: the CLI runs blame and verify, the agent dozens of times. */
const HUNG_AFTER = 600_000;

beforeAll(async () => {
  mock = await startMockAnthropic({ script, eventDelayMs: () => 0 });
});
afterAll(async () => {
  await mock.close();
});

const sh = (cwd: string, cmd: string, args: string[]) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

beforeEach(() => {
  project = tempProject('sl-repair-candidates-');
  copyFileSync(AGENT, join(project, 'agent.mjs'));
  writeFileSync(join(project, '.gitignore'), '.shadowlap/\n');
  sh(project, 'git', ['init', '-q', '-b', 'main']);
  sh(project, 'git', ['config', 'user.name', 'Test']);
  sh(project, 'git', ['config', 'user.email', 'test@example.com']);
  sh(project, 'git', ['add', '.']);
  sh(project, 'git', ['commit', '-q', '-m', 'agent']);
  decisions = 0;
  repairerAnswered = false;
});
afterEach(() => {
  removeTempProject(project);
});

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: project,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'test-key', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' },
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

interface Report {
  outcome: string;
  candidates: Array<{ source: string; state: string; after: string; verify: unknown }>;
  warnings: string[];
}

describe('shadowlap repair, given more candidates than it asked for', { timeout: HUNG_AFTER }, () => {
  it('tries only the first --candidates of them, in the order the repairer gave them, and says so', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
    expect(recorded.code, recorded.out).toBe(0);
    const failed = /recording run (\w{26})/.exec(recorded.out)![1];
    const before = mock.requests.length;
    const r = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'anthropic', '--candidates', String(REPAIR_CANDIDATES), '--json']);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.outcome).toBe('not-fixed');

    // The first three, each verified and rejected; the smaller three after them never tried.
    const kept = REWRITES.slice(0, REPAIR_CANDIDATES);
    expect(report.candidates.map((c) => c.after)).toEqual(kept);
    for (const c of report.candidates) expect(c).toMatchObject({ source: 'repairer', state: 'rejected', verify: expect.anything() });
    expect(report.warnings).toContain(`the repairer gave ${REWRITES.length} candidates, and only its first ${REPAIR_CANDIDATES} were tried: raise --candidates to try more`);

    // Nothing ran under a rewrite it didn't try.
    const sent = mock.requests.slice(before).map((q) => JSON.stringify(q.body.system ?? ''));
    for (const rewrite of kept) expect(sent.some((s) => s.includes(rewrite))).toBe(true);
    for (const rewrite of REWRITES.slice(REPAIR_CANDIDATES)) expect(sent.some((s) => s.includes(rewrite))).toBe(false);
    expect(sent.some((s) => s.includes(PROMPT))).toBe(true);
  });

  it('says its first was tried when told to try one', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs']);
    expect(recorded.code, recorded.out).toBe(0);
    const failed = /recording run (\w{26})/.exec(recorded.out)![1];
    const r = await shadowlap(['repair', '--fixes', failed, '--expect', ORACLE, '--repairer', 'anthropic', '--candidates', '1', '--json']);
    expect(r.code, r.out).toBe(1);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.candidates.map((c) => c.after)).toEqual(REWRITES.slice(0, 1));
    expect(report.warnings).toContain(`the repairer gave ${REWRITES.length} candidates, and only its first was tried: raise --candidates to try more`);
  });
});
