import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * Verify while the provider is overloaded: every live model call is answered 529, so no attempt of
 * the change says anything about the agent. The run stops after three in a row, inconclusive, never
 * not fixed or broken, and verify ends inconclusive (3), as the exit-status contract has it, with
 * the provider named, never failed (1). blame-unavailable.test.ts holds blame to the same.
 */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'cli', 'bin', 'shadowlap.js');
const GOLDEN = join(ROOT, 'testing', 'golden', 'reference-agent');
const RUN = '01M4Y6TKYX';

let mock: MockServer;
let dir: string;
let db: string;

beforeAll(async () => {
  mock = await startMockAnthropic({
    script: () => ({ status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, headers: { 'retry-after-ms': '1', 'x-should-retry': 'false' } }),
  });
  dir = mkdtempSync(join(tmpdir(), 'sl-verify-unavailable-'));
  db = join(dir, 'store.db');
  const unpacked = spawnSync(process.execPath, [CLI, '--db', db, 'unpack', GOLDEN], { encoding: 'utf8' });
  expect(unpacked.status, unpacked.stderr).toBe(0);
});
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function verify(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    // A request field the change sets from the first model call on: every attempt forks there, live.
    const child = spawn(process.execPath, [CLI, '--db', db, 'verify', ...args, '--set', 'temperature=1', '--yes', '--json'], {
      cwd: ROOT,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => ((out += d.toString()), (stdout += d.toString())));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out, stdout }));
  });
}

interface Verified {
  verdict: string;
  reasons: string[];
  runs: Array<{ role: string; outcome: string; undecided: string | null; unavailable: number }>;
  cost: { unavailable: number };
  stopReason: string | null;
}

describe('shadowlap verify while the provider is unavailable', () => {
  it('leaves a failing run inconclusive, not unfixed, and ends inconclusive with the provider named', async () => {
    const r = await verify(['--fixes', RUN, '--expect', JSON.stringify({ tools: { send_email: 0 } })]);
    expect(r.out).toMatch(/provider unavailable/);
    expect(r.code, r.out).toBe(3);
    const report = JSON.parse(r.stdout) as Verified;
    expect(report.verdict).toBe('incomplete');
    expect(report.runs).toMatchObject([{ role: 'target', outcome: 'inconclusive', unavailable: 3, undecided: expect.stringMatching(/^provider unavailable: 3 attempts in a row ended on HTTP 529/) }]);
    expect(report.stopReason).toMatch(/^provider unavailable: /);
    expect(report.reasons[0]).toMatch(/^target run \w{10} inconclusive: provider unavailable: /);
    expect(report.cost.unavailable).toBe(3);
  }, 180_000);

  it('leaves a good run inconclusive, never broken, and pairs no baseline with what the provider never answered', async () => {
    const r = await verify(['--keeps', RUN]);
    expect(r.out).toMatch(/provider unavailable/);
    expect(r.code, r.out).toBe(3);
    const report = JSON.parse(r.stdout) as Verified & { runs: Array<{ baselineRuns?: unknown[] }> };
    expect(report.runs).toMatchObject([{ role: 'good', outcome: 'inconclusive', unavailable: 3 }]);
    expect(report.runs[0].baselineRuns).toBeUndefined();
    expect(report.stopReason).toMatch(/^provider unavailable: /);
  }, 180_000);
});
