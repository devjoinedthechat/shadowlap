import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
import { departures, type ShapeName } from './json-shapes.js';

/**
 * A gate in `shadowlap test`, through the CLI, on the committed golden of the reference agent. The
 * mock plays the model: with "Never send email." in the system prompt it finishes instead of
 * emailing, so the golden marked `fork` passes its check; with FLAKY set, only every other attempt
 * obeys; with "Be brief." alone the prompt still changes (the replay forks) but the agent emails.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const FIX = { AGENT_SYSTEM_SUFFIX: 'Never send email.' };
const FORKS_AND_EMAILS = { AGENT_SYSTEM_SUFFIX: 'Be brief.' };
const CHECKS = { tools: { send_email: 0 } };

/** The report's JSON held to docs/cli.md both ways: every field the shape lists is printed, every field printed is named there. */
function hold(values: Array<[ShapeName, unknown]>): void {
  expect(values.flatMap(([shape, value]) => {
    const d = departures(shape, value);
    return [...d.missing, ...d.extra];
  })).toEqual([]);
}

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
  work = mkdtempSync(join(tmpdir(), 'sl-gate-'));
  cpSync(join(ROOT, 'testing', 'golden', 'reference-agent'), join(work, 'goldens', 'reference-agent'), { recursive: true });
});
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface Ran {
  code: number | null;
  out: string;
  report: { passed: number; failed: number; inconclusive: number; results: Array<Record<string, any>> };
  junit: string;
  markdown: string;
}

function shadowlapTest(tests: unknown, env: NodeJS.ProcessEnv = {}, o: { db?: string; flags?: string[] } = {}): Promise<Ran> {
  writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [], redact: [], tests }));
  const report = join(work, 'report.json');
  const junit = join(work, 'junit.xml');
  const markdown = join(work, 'summary.md');
  for (const f of [report, junit, markdown]) rmSync(f, { force: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', o.db ?? ':memory:', 'test', 'goldens/reference-agent', '--cwd', ROOT, '--json', report, '--junit', junit, '--markdown', markdown, ...(o.flags ?? [])], {
      cwd: work,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => {
      const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
      let parsed: Ran['report'] = { passed: 0, failed: 0, inconclusive: 0, results: [] };
      try {
        parsed = JSON.parse(read(report));
      } catch {
        // no report: the output says why
      }
      resolve({ code, out, report: parsed, junit: read(junit), markdown: read(markdown) });
    });
  });
}

describe('shadowlap test with a gate', () => {
  it('passes an agent that always passes after the 12 attempts its gate states, and says so in one sentence', async () => {
    const r = await shadowlapTest({ 'goldens/reference-agent': { fork: true, gate: { good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, expect: CHECKS } }, FIX);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('✓ reference-agent: passed: at least 90% with 95% confidence after 12 attempts');
    expect(r.out).toContain('12 of 12 passed · pass rate ≥ 0.76 (95%, Wilson) · pass^5 1.00 · forked at call 3');
    expect(r.out).toContain('attempt 12 of up to 20');
    expect(r.out).not.toContain('attempt 13 of');
    const result = r.report.results[0]!;
    expect(result).toMatchObject({ ok: true, verdict: 'passed', failure: null, attempts: { total: 12, passed: 12, required: null } });
    expect(result.gate).toMatchObject({ kind: 'sprt', good: 0.9, bad: 0.7, risk: 0.05, max: 20, decision: 'pass', passes: 12, attempts: 12, clean: false, sentence: 'passed: at least 90% with 95% confidence after 12 attempts' });
    // The evidence path: the score after each attempt, crossing the upper bound at the twelfth.
    const e = result.gate.evidence;
    expect(e.scores).toHaveLength(12);
    expect(e.scores[10]).toBeLessThan(e.upper);
    expect(e.scores[11]).toBeGreaterThanOrEqual(e.upper);
    expect(result.gate.passK[0]).toEqual({ k: 1, value: 1 });
    expect(r.report).toMatchObject({ passed: 1, failed: 0, inconclusive: 0 });
    hold([['test', r.report], ['testResult', result], ['testGate', result.gate], ['testGateInterval', result.gate.interval], ['testGatePassK', result.gate.passK[0]], ['testGateSprtEvidence', e]]);
    // The reports say the same sentence.
    expect(r.markdown).toContain('| ✅ | `reference-agent` | passed: at least 90% with 95% confidence after 12 attempts · 12 of 12 passed · pass rate ≥ 0.76 (95%, Wilson) · pass^5 1.00 · forked at call 3, 1 check passed |');
    expect(r.junit).toContain('[shadowlap] passed: at least 90% with 95% confidence after 12 attempts');
  }, 120_000);

  it('fails an agent that always fails after 3 attempts', async () => {
    const r = await shadowlapTest({ 'goldens/reference-agent': { fork: true, gate: {}, expect: CHECKS } }, FORKS_AND_EMAILS);
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ reference-agent: failed: at most 70% with 95% confidence after 3 attempts. Attempt 1: check failed: send_email called 0 times, but called 1 time');
    expect(r.out).toContain('0 of 3 passed · pass rate ≥ 0.00 (95%, Wilson)');
    expect(r.report.results[0]).toMatchObject({ ok: false, verdict: 'failed', failure: 'check', gate: { decision: 'fail', attempts: 3, max: 40 } });
    expect(r.markdown).toContain('### Shadowlap: 1 of 1 recording failed');
  }, 120_000);

  it('settles a replay that forks nowhere with its one attempt, which would come out the same every time', async () => {
    const r = await shadowlapTest({ 'goldens/reference-agent': { fork: true, gate: {}, expect: CHECKS } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('✗ reference-agent: failed: a clean replay comes out the same every time, so its one attempt settles it');
    expect(r.report.results[0]).toMatchObject({ verdict: 'failed', gate: { decision: 'fail', attempts: 1, clean: true }, upstreamRequests: 0 });
  }, 60_000);

  it('is inconclusive when its attempts run out between the bounds, which fails CI unless it should only warn', async () => {
    flaky = true;
    try {
      // Every other attempt obeys: 2 of 4, a score of 0, between bounds of ±ln 4.
      const tests = { 'goldens/reference-agent': { fork: true, gate: { good: 0.6, bad: 0.4, risk: 0.2, max: 4 }, expect: CHECKS } };
      const failing = await shadowlapTest(tests, FIX);
      expect(failing.code).toBe(1);
      expect(failing.out).toContain('! reference-agent: inconclusive: neither at least 60% nor at most 40% with 80% confidence after 4 attempts, the most the gate runs');
      expect(failing.out).toContain('0 passed, 0 failed, 1 inconclusive (failing the run: --inconclusive warn lets them through)');
      expect(failing.report).toMatchObject({ passed: 0, failed: 1, inconclusive: 1 });
      expect(failing.report.results[0]).toMatchObject({ ok: false, verdict: 'inconclusive', failure: 'inconclusive', gate: { decision: 'inconclusive', passes: 2, attempts: 4 } });
      expect(failing.junit).toContain('<failure message="inconclusive: neither at least 60%');
      expect(failing.markdown).toContain('### Shadowlap: 1 of 1 recording is inconclusive');
      expect(failing.markdown).toContain('| 🟡 | `reference-agent` | inconclusive: neither at least 60% nor at most 40% with 80% confidence after 4 attempts, the most the gate runs · 2 of 4 passed');

      const warned = await shadowlapTest(tests, FIX, { flags: ['--inconclusive', 'warn', '--annotations'] });
      expect(warned.code, warned.out).toBe(0);
      expect(warned.out).toContain('1 inconclusive (let through: --inconclusive warn)');
      expect(warned.report).toMatchObject({ passed: 1, failed: 0, inconclusive: 1 });
      expect(warned.report.results[0]).toMatchObject({ ok: true, verdict: 'inconclusive' });
      expect(warned.junit).toContain('skipped="1"');
      expect(warned.junit).toContain('<skipped message="inconclusive: neither at least 60%');
      expect(warned.out).toMatch(/::warning file=goldens\/reference-agent\/run\.json,title=Shadowlap%3A reference-agent::inconclusive/);

      // More attempts for this session only: the gate's limit is raised, its figures kept.
      const more = await shadowlapTest(tests, FIX, { flags: ['--max-attempts', '6'] });
      expect(more.report.results[0]).toMatchObject({ verdict: 'inconclusive', gate: { max: 6, attempts: 6, passes: 3 } });
    } finally {
      flaky = false;
    }
  }, 180_000);
});

describe('shadowlap test with a gate against history', () => {
  it('passes an unchanged agent after its minimum of attempts and no more, and fails one whose pass rate dropped', async () => {
    const db = join(work, 'history.db');
    const tests = { 'goldens/reference-agent': { fork: true, gate: { baseline: 'history', min: 3 }, expect: CHECKS } };
    // No history yet: compared with a golden that always passes.
    const first = await shadowlapTest(tests, FIX, { db });
    expect(first.code, first.out).toBe(0);
    expect(first.report.results[0]).toMatchObject({ verdict: 'passed', gate: { kind: 'baseline', decision: 'pass', attempts: 3, evidence: { history: null, baseline: 1 } } });
    expect(first.out).toContain('✓ reference-agent: passed: no drop of 15 points or more from its baseline, a golden that always passes, since it has no history yet, with 95% confidence after 3 attempts');
    hold([['testGateHistory', first.report.results[0]!.gate], ['testGateHistoryEvidence', first.report.results[0]!.gate.evidence]]);

    // The same agent again: its own history is the baseline, and three attempts settle it.
    const again = await shadowlapTest(tests, FIX, { db });
    expect(again.code, again.out).toBe(0);
    expect(again.report.results[0]).toMatchObject({ verdict: 'passed', attempts: { total: 3, passed: 3 }, gate: { decision: 'pass', attempts: 3, evidence: { history: { passes: 3, attempts: 3, sessions: 1 } } } });
    expect(again.out).not.toContain('attempt 4 of');

    // A change that makes it email again: every attempt fails, against a history of passes.
    const broken = await shadowlapTest(tests, FORKS_AND_EMAILS, { db });
    expect(broken.code).toBe(1);
    expect(broken.report.results[0]).toMatchObject({ verdict: 'failed', gate: { decision: 'fail', attempts: 3, evidence: { history: { passes: 6, attempts: 6, sessions: 2 } } } });
    expect(broken.out).toContain('✗ reference-agent: failed: its pass rate dropped 15 points or more from its baseline, 1.00 over the last 2 sessions (6 of 6 attempts), with 95% confidence after 3 attempts');

    // The history keeps each session's attempts, passed and total, and the gate's result with them.
    const store = Store.open(db);
    try {
      const results = store.listTestResults({ golden: 'goldens/reference-agent' });
      expect(results.map((x) => [x.data?.verdict, x.data?.attempts?.passed, x.data?.attempts?.total])).toEqual([
        ['failed', 0, 3],
        ['passed', 3, 3],
        ['passed', 3, 3],
      ]);
      expect(results[0]!.data?.gate).toMatchObject({ kind: 'baseline', decision: 'fail' });
    } finally {
      store.close();
    }
  }, 240_000);
});
