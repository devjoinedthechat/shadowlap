import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyRun, Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

/**
 * Outcome checks in `shadowlap test`, through the CLI, on the committed golden of the reference
 * agent (11 model calls, ending in a send_email write). The mock plays the model: when the system
 * prompt says "Never send email." it finishes instead of emailing, so a prompt fix is something
 * a recording marked `fork` can prove. With FLAKY_EVERY set, only every other attempt obeys.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');

let mock: MockServer;
let work: string;
let attemptsSeen = 0;
let flaky = false;

beforeAll(async () => {
  mock = await startMockAnthropic({
    script: (ctx) => {
      if (ctx.assistantTurns === 0) attemptsSeen++;
      const obeys = JSON.stringify(ctx.request.system ?? '').includes('Never send email.') && (!flaky || attemptsSeen % 2 === 0);
      if (obeys && ctx.assistantTurns === 9) {
        return { message: { id: `msg_final_${ctx.requestNo}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Done. Summary kept here, not emailed.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } } as never };
      }
      return referenceScript(ctx);
    },
  });
  work = mkdtempSync(join(tmpdir(), 'fp-checks-'));
  cpSync(join(ROOT, 'testing', 'golden', 'reference-agent'), join(work, 'goldens', 'reference-agent'), { recursive: true });
});
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlapTest(tests: unknown, env: NodeJS.ProcessEnv = {}, db?: string): Promise<{ code: number | null; out: string; report: { results: Array<Record<string, unknown>> } }> {
  writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [], redact: [], tests }));
  const report = join(work, 'report.json');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...(db ? ['--db', db] : []), 'test', 'goldens/reference-agent', '--cwd', ROOT, '--json', report], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => {
      let parsed = { results: [] as Array<Record<string, unknown>> };
      try {
        parsed = JSON.parse(readFileSync(report, 'utf8'));
      } catch {
        // no report: the output says why
      }
      resolve({ code, out, report: parsed });
    });
  });
}

describe('shadowlap test with outcome checks', () => {
  it('passes a clean replay whose checks hold, and lists them in the report', async () => {
    const r = await shadowlapTest({
      'goldens/*': {
        expect: {
          tools: { send_email: { count: 1, args: { to: 'team@example.com' } }, search_web: '>= 1' },
          modelCalls: 11,
          output: { includes: 'Done. Summary' },
          answer: { includes: 'forks fence writes', excludes: 'sorry' },
        },
      },
    });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✓ reference-agent: 30/30 replayed, ');
    expect(r.out).toContain('6 checks passed');
    expect(r.report.results[0]).toMatchObject({ ok: true, attempts: null, checks: expect.arrayContaining([{ status: 'passed', ok: true, label: 'send_email with {"to":"team@example.com"} called 1 time', detail: null }]) });
  });

  it('fails a clean replay when a check does not hold, saying what the agent did, and keeps the checks with the run', async () => {
    const db = join(work, 'kept.db');
    const r = await shadowlapTest({ 'goldens/reference-agent': { expect: { tools: { send_email: 0 } } } }, {}, db);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ reference-agent: check failed: send_email called 0 times, but called 1 time');
    expect(r.out).toContain('✗ send_email called 0 times: called 1 time');
    const store = Store.open(db);
    const replay = store.allRuns().find((x) => x.mode === 'replay');
    store.close();
    expect(replay?.meta?.checks).toEqual([{ status: 'failed', ok: false, label: 'send_email called 0 times', detail: 'called 1 time' }]);
  });

  it('still fails an intended prompt change without `fork`', async () => {
    const r = await shadowlapTest({ 'goldens/reference-agent': { expect: { tools: { send_email: 0 } } } }, { AGENT_SYSTEM_SUFFIX: 'Never send email.' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ reference-agent: diverged at call 3');
  });

  it('passes a recording marked `fork` on its checks after the prompt fix, every attempt', async () => {
    const tests = { 'goldens/reference-agent': { fork: true, repeat: 2, expect: { tools: { send_email: 0 }, answer: { includes: 'not emailed' } } } };
    const before = await shadowlapTest(tests);
    expect(before.code, 'without the fix the recording still emails').toBe(1);
    expect(before.out).toContain('attempt 1  ✗ check failed: send_email called 0 times, but called 1 time');

    const r = await shadowlapTest(tests, { AGENT_SYSTEM_SUFFIX: 'Never send email.' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/✓ reference-agent: forked at call 3, \d+\/\d+ replayed, .* 2 checks passed, 2\/2 attempts passed/);
    expect(r.report.results[0]).toMatchObject({ ok: true, attempts: { total: 2, passed: 2, required: 2 }, divergence: { callNo: 3 } });
  });

  it('counts passing attempts against `passes`', async () => {
    flaky = true;
    try {
      const strict = await shadowlapTest({ 'goldens/reference-agent': { fork: true, repeat: 2, expect: { tools: { send_email: 0 } } } }, { AGENT_SYSTEM_SUFFIX: 'Never send email.' });
      expect(strict.code).toBe(1);
      expect(strict.out).toContain('✗ reference-agent: 1 of 2 attempts passed, 2 needed. Attempt ');
      expect(strict.report.results[0]).toMatchObject({ ok: false, attempts: { total: 2, passed: 1, required: 2 } });

      const lenient = await shadowlapTest({ 'goldens/reference-agent': { fork: true, repeat: 2, passes: 1, expect: { tools: { send_email: 0 } } } }, { AGENT_SYSTEM_SUFFIX: 'Never send email.' });
      expect(lenient.code, lenient.out).toBe(0);
      expect(lenient.out).toContain('1/2 attempts passed');
    } finally {
      flaky = false;
    }
  });

  it('files a golden’s attempts under the one its result shows, as one test run', async () => {
    flaky = true;
    try {
      const db = join(work, 'attempts.db');
      const r = await shadowlapTest({ 'goldens/reference-agent': { fork: true, repeat: 2, expect: { tools: { send_email: 0 } } } }, { AGENT_SYSTEM_SUFFIX: 'Never send email.' }, db);
      expect(r.code).toBe(1);
      // The result shows the attempt that failed: the run the Tests screen opens.
      const shown = r.report.results[0].runId as string;
      const store = Store.open(db);
      const tested = store.allRuns().filter((x) => x.meta?.test);
      store.close();
      expect(tested.map((x) => x.meta!.test!.attempt).sort()).toEqual([1, 2]);
      const head = tested.find((x) => x.runId === shown)!;
      const other = tested.find((x) => x.runId !== shown)!;
      expect(head.meta!.test!.of).toBeUndefined();
      expect(other.meta!.test).toMatchObject({ golden: 'goldens/reference-agent', session: head.meta!.test!.session, of: shown });
      expect(classifyRun(head)).toMatchObject({ kind: 'test', attemptOf: null, attemptKind: null });
      expect(classifyRun(other)).toMatchObject({ kind: 'test', attemptOf: shown, attemptKind: 'test' });
    } finally {
      flaky = false;
    }
  });

  it('refuses a config it cannot read before replaying anything', async () => {
    const r = await shadowlapTest({ 'goldens/reference-agent': { expect: { tool: { send_email: 0 } } } });
    expect(r.code).toBe(2);
    expect(r.out).toContain('tests["goldens/reference-agent"].expect has an unknown key "tool"');
  });
});
