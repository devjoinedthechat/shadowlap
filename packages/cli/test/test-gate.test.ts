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
    expect(r.out).toContain('0 of 3 passed · pass rate ≤ 0.56 (95%, Wilson)');
    expect(r.report.results[0]).toMatchObject({ ok: false, verdict: 'failed', failure: 'check', gate: { decision: 'fail', attempts: 3, max: 80, outcomes: [false, false, false] } });
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

  it('continues an inconclusive gate with --continue, carrying its attempts over, and counts it apart in the history', async () => {
    flaky = true;
    try {
      const db = join(work, 'continue.db');
      const tests = { 'goldens/reference-agent': { fork: true, gate: { good: 0.6, bad: 0.4, risk: 0.2, max: 4 }, expect: CHECKS } };
      const first = await shadowlapTest(tests, FIX, { db });
      expect(first.report.results[0]).toMatchObject({ verdict: 'inconclusive', gate: { passes: 2, attempts: 4 } });
      const seen = attemptsSeen;
      // Two more, to 6: the four it has carry over, so only attempts 5 and 6 run.
      const more = await shadowlapTest(tests, FIX, { db, flags: ['--max-attempts', '6', '--continue'] });
      expect(attemptsSeen - seen).toBe(2);
      expect(more.out).toContain('continues its last result: 4 attempts carried over, 2 passed, up to 6');
      expect(more.out).toContain('attempt 5 of up to 6');
      expect(more.out).not.toContain('attempt 1 of up to 6');
      const result = more.report.results[0]!;
      expect(result).toMatchObject({ verdict: 'inconclusive', attempts: { total: 2, passed: 1 }, gate: { max: 6, attempts: 6, passes: 3, carried: 4 } });
      expect(result.gate.outcomes).toHaveLength(6);
      expect(result.gate.sentence).toBe('inconclusive: neither at least 60% nor at most 40% with 80% confidence after 6 attempts (4 carried over), the most the gate runs');
      // Nothing to continue once a verdict is settled, or when nothing was inconclusive: it runs afresh, and says why.
      const fresh = await shadowlapTest({ 'goldens/reference-agent': { fork: true, gate: {}, expect: CHECKS } }, FIX, { db, flags: ['--continue'] });
      expect(fresh.out).toContain('nothing to continue (its gate changed since its last result): it ran afresh');

      const store = Store.open(db);
      try {
        const [latest, continued, earliest] = store.listTestResults({ golden: 'goldens/reference-agent' });
        // The history keeps this session's own attempts, so a baseline pools each once, and which sessions it carried.
        expect(continued!.data).toMatchObject({ verdict: 'inconclusive', attempts: { total: 2, passed: 1 }, continued: { sessions: [earliest!.sessionId], attempts: 4 }, gate: { attempts: 6, carried: 4 } });
        expect(latest!.data?.continued).toBeUndefined();
        // An inconclusive golden is neither passed nor failed: the session counts it apart, and its event says how many.
        expect(store.getTestSession(continued!.sessionId)).toMatchObject({ passed: 0, failed: 0 });
        const event = store.listEvents({ kinds: ['test.session'] }).find((e) => e.ref === continued!.sessionId);
        expect(event?.data).toMatchObject({ passed: 0, failed: 0, inconclusive: 1 });
      } finally {
        store.close();
      }
    } finally {
      flaky = false;
    }
  }, 240_000);
});

describe('shadowlap test with a gate against history', () => {
  it('passes an unchanged agent after its minimum of attempts and no more, runs more when its attempts look like a drop, and fails one whose pass rate dropped', async () => {
    const db = join(work, 'history.db');
    // The gate as the docs give it: every figure its default, so it decides from 5 attempts on, up to 40.
    const tests = { 'goldens/reference-agent': { fork: true, gate: { baseline: 'history' }, expect: CHECKS } };
    // No history yet: compared with its recording, the one attempt it was packed from, and it says so.
    const first = await shadowlapTest(tests, FIX, { db });
    expect(first.code, first.out).toBe(0);
    expect(first.report.results[0]).toMatchObject({ verdict: 'passed', gate: { kind: 'baseline', drop: 0.15, risk: 0.05, window: 10, min: 5, max: 40, decision: 'pass', attempts: 5, evidence: { history: null, baseline: 1, passAt: 0.5 } } });
    expect(first.out).toContain('✓ reference-agent: passed: no sign of a drop of 15 points or more from its baseline, its recording, the one attempt it was packed from, since it has no history yet, after 5 attempts');
    expect(first.out).toContain('no test history for it yet, so its gate compared with its recording');
    hold([['testGateHistory', first.report.results[0]!.gate], ['testGateHistoryEvidence', first.report.results[0]!.gate.evidence]]);

    // The same agent again: its own history is the baseline, and its 5 attempts settle it, no more.
    const again = await shadowlapTest(tests, FIX, { db });
    expect(again.code, again.out).toBe(0);
    expect(again.report.results[0]).toMatchObject({ verdict: 'passed', attempts: { total: 5, passed: 5 }, gate: { decision: 'pass', attempts: 5, evidence: { history: { passes: 5, attempts: 5, sessions: 1 } } } });
    expect(again.out).toContain('passed: no sign of a drop of 15 points or more from its baseline, 1.00 over its last session (5 of 5 attempts), after 5 attempts');
    expect(again.out).toContain('attempt 5 of up to 40');
    expect(again.out).not.toContain('attempt 6 of');
    expect(again.out).not.toContain('no test history');

    // An agent that now passes every other attempt, starting with a pass: 3 of 5 could be bad luck,
    // so it runs on, and fails once the drop is clear, after 10.
    flaky = true;
    attemptsSeen = 1;
    let halved: Ran;
    try {
      halved = await shadowlapTest(tests, FIX, { db });
    } finally {
      flaky = false;
    }
    expect(halved.code).toBe(1);
    expect(halved.report.results[0]).toMatchObject({ verdict: 'failed', attempts: { total: 10, passed: 5 }, gate: { decision: 'fail', attempts: 10, evidence: { history: { passes: 10, attempts: 10, sessions: 2 } } } });
    expect(halved.out).toContain('failed: its pass rate dropped 15 points or more from its baseline, 1.00 over the last 2 sessions (10 of 10 attempts), with 95% confidence after 10 attempts');
    expect(halved.out).toContain('attempt 10 of up to 40');
    expect(halved.out).not.toContain('attempt 11 of');
    const path = halved.report.results[0]!.gate.evidence.probabilities as Array<number | null>;
    expect(path.slice(0, 4)).toEqual([null, null, null, null]);
    expect(path.slice(4, 9).every((q) => q !== null && q > 0.5 && q <= 0.95)).toBe(true);
    expect(path[9]).toBeGreaterThan(0.95);

    // A change that makes it email again: every attempt fails, against its history.
    const broken = await shadowlapTest(tests, FORKS_AND_EMAILS, { db });
    expect(broken.code).toBe(1);
    expect(broken.report.results[0]).toMatchObject({ verdict: 'failed', gate: { decision: 'fail', attempts: 5, evidence: { history: { passes: 15, attempts: 20, sessions: 3 } } } });
    expect(broken.out).toContain('✗ reference-agent: failed: its pass rate dropped 15 points or more from its baseline, 0.75 over the last 3 sessions (15 of 20 attempts), with 95% confidence after 5 attempts');

    // The history keeps each session's attempts, passed and total, and the gate's result with them.
    const store = Store.open(db);
    try {
      const results = store.listTestResults({ golden: 'goldens/reference-agent' });
      expect(results.map((x) => [x.data?.verdict, x.data?.attempts?.passed, x.data?.attempts?.total])).toEqual([
        ['failed', 0, 5],
        ['failed', 5, 10],
        ['passed', 5, 5],
        ['passed', 5, 5],
      ]);
      expect(results[0]!.data?.gate).toMatchObject({ kind: 'baseline', decision: 'fail' });
    } finally {
      store.close();
    }
  }, 300_000);
});
