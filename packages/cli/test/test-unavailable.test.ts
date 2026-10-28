import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trackInGit } from './tracked.js';
import { Store, type CallRecord } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';
import { unavailableIn } from '../src/golden-test.js';
import type { TestAttempt } from '../src/run-agent.js';

/**
 * A gated golden under `shadowlap test` while the provider is overloaded: the mock answers 529 to
 * the first model call of as many attempts as a test says (telling the SDK not to retry it, so the
 * agent fails at once). Those attempts are runs that say nothing about the agent: not counted, run
 * again, and three in a row make the golden inconclusive with the provider named, never failed.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const FIX = { AGENT_SYSTEM_SUFFIX: 'Never send email.' };
const CHECKS = { tools: { send_email: 0 } };

let mock: MockServer;
let work: string;
/** Attempts whose first model call the mock answers 529, from the next one on. */
let overloaded = 0;
/** Attempts whose fourth model call, after the model answered three, the mock answers 529. */
let cutShort = 0;

beforeAll(async () => {
  mock = await startMockAnthropic({
    script: (ctx) => {
      if (ctx.assistantTurns === 0 && overloaded > 0) {
        overloaded--;
        return { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, headers: { 'retry-after-ms': '1', 'x-should-retry': 'false' } };
      }
      if (ctx.assistantTurns === 3 && cutShort > 0) {
        cutShort--;
        return { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, headers: { 'retry-after-ms': '1', 'x-should-retry': 'false' } };
      }
      const obeys = JSON.stringify(ctx.request.system ?? '').includes('Never send email.');
      if (obeys && ctx.assistantTurns === 9) {
        return { message: { id: `msg_final_${ctx.requestNo}`, type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Done. Summary kept here, not emailed.' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } } as never };
      }
      return referenceScript(ctx);
    },
  });
  work = mkdtempSync(join(tmpdir(), 'sl-unavailable-'));
  cpSync(join(ROOT, 'testing', 'golden', 'reference-agent'), join(work, 'goldens', 'reference-agent'), { recursive: true });
  // Committed, as a checkout holds it.
  trackInGit(work, 'goldens');
});
afterAll(async () => {
  await mock.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface Ran {
  code: number | null;
  out: string;
  report: { passed: number; failed: number; inconclusive: number; results: Array<Record<string, any>> };
}

function shadowlapTest(tests: unknown, db: string, packs: string[] = ['goldens/reference-agent']): Promise<Ran> {
  writeFileSync(join(work, 'shadowlap.config.json'), JSON.stringify({ normalize: [], redact: [], tests }));
  const report = join(work, 'report.json');
  rmSync(report, { force: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, 'test', ...packs, '--cwd', ROOT, '--json', report], {
      cwd: work,
      env: { ...process.env, ...FIX, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => {
      let parsed: Ran['report'] = { passed: 0, failed: 0, inconclusive: 0, results: [] };
      try {
        parsed = JSON.parse(existsSync(report) ? readFileSync(report, 'utf8') : '');
      } catch {
        // no report: the output says why
      }
      resolve({ code, out, report: parsed });
    });
  });
}

describe('shadowlap test while the provider is unavailable', () => {
  const tests = { 'goldens/reference-agent': { fork: true, gate: { good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, expect: CHECKS } };

  it('runs again the attempts the provider was unavailable for, and passes on the 12 it counts', async () => {
    overloaded = 2;
    const db = join(work, 'retried.db');
    const r = await shadowlapTest(tests, db);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("the provider was unavailable (HTTP 529 from anthropic at call #3), so that attempt isn't counted; running it again in");
    const result = r.report.results[0];
    expect(result).toMatchObject({ verdict: 'passed', attempts: { total: 12, passed: 12, unavailable: 2 }, gate: { decision: 'pass', passes: 12, attempts: 12, unavailable: 2 } });
    // Every run is kept, the two the provider was unavailable for marked so.
    expect(result.runs).toHaveLength(14);
    expect(result.runs.slice(0, 2).map((x: { verdict: string }) => x.verdict)).toEqual(['unavailable', 'unavailable']);
    expect(result.runs.slice(2).every((x: { verdict: string }) => x.verdict === 'passed')).toBe(true);
    // Its verdict line counts them apart from the tally, once.
    expect(r.out).toContain('✓ reference-agent: passed · 12 of 12 (2 unavailable, not counted) · rate >= 0.73 (95%) · gate:');
    expect(result.gate.sentence).toMatch(/^passed · 12 of 12 \(2 unavailable, not counted\) · rate >= 0\.73 \(95%\) · gate: /);
    expect(r.out).not.toContain('2 attempts not counted');
    const store = Store.open(db);
    try {
      expect(store.listTestResults({ golden: 'goldens/reference-agent' })[0].data?.attempts).toMatchObject({ total: 12, passed: 12, unavailable: 2 });
    } finally {
      store.close();
    }
  }, 180_000);

  it('counts an attempt the provider cut short after the model answered against either verdict: a pass then takes the passes a failure would', async () => {
    cutShort = 1;
    try {
      const r = await shadowlapTest(tests, join(work, 'cut-short.db'));
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain('the provider cut that attempt short (HTTP 529 from anthropic at call #');
      expect(r.out).toContain('so it is counted against either verdict; running the next attempt in');
      const result = r.report.results[0];
      // A failure toward the pass: 17 passes of 18, where 12 of 12 would have done.
      expect(result).toMatchObject({ verdict: 'passed', attempts: { total: 18, passed: 17, cutShort: 1 }, gate: { decision: 'pass', passes: 17, attempts: 18, unavailableAt: [0], bound: { method: 'confidence-sequence' } } });
      expect(result.attempts.unavailable).toBeUndefined();
      expect(result.gate.sentence).toMatch(/^passed · 17 of 18 \(1 cut short by the provider, counted against either verdict\) · rate >= 0\.\d\d \(95%\) · gate: /);
      expect(result.runs[0].verdict).toBe('unavailable');
      const store = Store.open(join(work, 'cut-short.db'));
      try {
        expect(store.listTestResults({ golden: 'goldens/reference-agent' })[0].data?.attempts).toMatchObject({ total: 18, passed: 17, cutShort: 1 });
      } finally {
        store.close();
      }
    } finally {
      cutShort = 0;
    }
  }, 180_000);

  it('counts one against either verdict under a fixed count too: 3 of 3 needed, one cut short, leaves the count unsettled rather than run it again', async () => {
    cutShort = 1;
    try {
      const counted = { 'goldens/reference-agent': { fork: true, repeat: 3, passes: 3, expect: CHECKS } };
      const r = await shadowlapTest(counted, join(work, 'count-cut-short.db'));
      expect(r.code, r.out).toBe(3);
      const result = r.report.results[0];
      // 2 passed and 1 cut short: as a failure the count is lost, as a pass it is met.
      expect(result).toMatchObject({ verdict: 'inconclusive', failure: 'inconclusive', attempts: { total: 3, passed: 2, cutShort: 1 } });
      expect(result.message).toBe('inconclusive: 2 of 3 attempts passed, 1 of them cut short by the provider, 3 needed: counted as failures the count is lost, as passes it is met, so it rests on how they would have ended');
      // Needing 2 of 3, the same attempts pass it: the attempt cut short counted as a failure.
      cutShort = 1;
      const two = await shadowlapTest({ 'goldens/reference-agent': { fork: true, repeat: 3, passes: 2, expect: CHECKS } }, join(work, 'count-cut-short-2.db'));
      expect(two.code, two.out).toBe(0);
      expect(two.report.results[0]).toMatchObject({ verdict: 'passed', attempts: { total: 3, passed: 2, cutShort: 1 } });
    } finally {
      cutShort = 0;
    }
  }, 180_000);

  it('stops a session of five goldens once the provider fails 4 attempts in a row across them, each left inconclusive, never failed', async () => {
    const copies = [2, 3, 4, 5].map((i) => `goldens/reference-agent-${i}`);
    for (const c of copies) cpSync(join(work, 'goldens', 'reference-agent'), join(work, c), { recursive: true });
    overloaded = 1000;
    try {
      const entry = { fork: true, gate: { good: 0.9, bad: 0.7, risk: 0.05, max: 20 }, expect: CHECKS };
      const all = Object.fromEntries(['goldens/reference-agent', ...copies].map((g) => [g, entry]));
      const r = await shadowlapTest(all, join(work, 'session-down.db'), ['goldens/reference-agent', ...copies]);
      expect(r.code, r.out).toBe(3);
      const results = r.report.results;
      expect(results).toHaveLength(5);
      expect(results.every((x) => x.verdict === 'inconclusive')).toBe(true);
      // The first four ran an attempt each, in turn, and the provider failed all four: the session stopped there.
      expect(results.slice(0, 4).map((x) => x.message)).toEqual(Array(4).fill(expect.stringMatching(/^provider unavailable: 4 attempts in a row ended on HTTP 529 from anthropic at call #\d+, so none of them says anything about the agent/)));
      expect(results[4].message).toMatch(/^provider unavailable: 4 attempts in a row across the session ended on HTTP 529 from anthropic at call #\d+, so the session stopped before this golden ran/);
      expect(results.reduce((n, x) => n + (x.runs?.length ?? 0), 0)).toBe(4);
    } finally {
      overloaded = 0;
      for (const c of copies) rmSync(join(work, c), { recursive: true, force: true });
    }
  }, 180_000);

  it('is inconclusive after three in a row, with the provider named, and fails no attempt of the agent\'s', async () => {
    overloaded = 1000;
    try {
      const r = await shadowlapTest(tests, join(work, 'gave-up.db'));
      expect(r.code).not.toBe(0);
      const result = r.report.results[0];
      expect(result).toMatchObject({ verdict: 'inconclusive', failure: 'inconclusive', attempts: { total: 0, passed: 0, unavailable: 3 }, gate: { decision: 'continue', attempts: 0, unavailable: 3 } });
      expect(result.message).toMatch(/^provider unavailable: 3 attempts in a row ended on HTTP 529 from anthropic at call #3, so none of them says anything about the agent/);
      expect(result.runs.map((x: { verdict: string }) => x.verdict)).toEqual(['unavailable', 'unavailable', 'unavailable']);
      expect(r.report).toMatchObject({ inconclusive: 1 });
      expect(r.out).toContain('? reference-agent: provider unavailable: 3 attempts in a row');
    } finally {
      overloaded = 0;
    }
  }, 120_000);
});

describe('an attempt whose preload never loaded', () => {
  it("is the agent's failure, never the provider's, whatever its model calls ended on", () => {
    const overloaded = { kind: 'api', origin: 'live', callNo: 1, meta: { provider: 'anthropic' }, end: { outcome: 'error', at: 0, meta: { status: 529, provider: 'anthropic' } } } as unknown as CallRecord;
    const store = { getCalls: () => [overloaded] } as unknown as Store;
    const attempt = (kind: TestAttempt['kind']) => ({ failure: { message: 'failed', details: '' }, kind, interrupted: null, ended: { summary: { status: 'failed', runId: '01M5GUARD0000000000000000' } } }) as unknown as TestAttempt;
    // The same 529: the provider's when the agent exited non-zero, the guard's when no preload loaded.
    expect(unavailableIn(store, attempt('exit'))).toMatchObject({ status: 529, provider: 'anthropic' });
    expect(unavailableIn(store, attempt('guard'))).toBeNull();
  });
});
