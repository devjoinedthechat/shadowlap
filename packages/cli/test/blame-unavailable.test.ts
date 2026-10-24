import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * Blame while the provider is overloaded: every live model call is answered 529, so no probe's
 * attempt says anything about the agent. The probe stops after three in a row, and blame ends
 * inconclusive (3), as the exit-status contract has it, with the provider named, never failed (1).
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
  dir = mkdtempSync(join(tmpdir(), 'sl-blame-unavailable-'));
  db = join(dir, 'store.db');
  const unpacked = spawnSync(process.execPath, [CLI, '--db', db, 'unpack', GOLDEN], { encoding: 'utf8' });
  expect(unpacked.status, unpacked.stderr).toBe(0);
});
afterAll(async () => {
  await mock.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function blame(): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, 'blame', RUN, '--yes', '--expect', JSON.stringify({ tools: { send_email: 0 } })], {
      cwd: ROOT,
      env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_GUARD: 'off', SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

describe('shadowlap blame while the provider is unavailable', () => {
  it('ends inconclusive, with the provider named, not failed', async () => {
    const r = await blame();
    expect(r.out).toMatch(/provider unavailable/);
    expect(r.code, r.out).toBe(3);
  }, 180_000);
});
