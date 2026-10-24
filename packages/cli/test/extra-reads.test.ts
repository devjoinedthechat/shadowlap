import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * An agent changed to log a timestamp makes a clock read, and a pure tool's call, that its
 * recording never held. Neither changes what it does to the world, so its golden still passes
 * offline: the reads are answered live, the replay goes on, and the summary says so.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./clock-agent.mjs', import.meta.url));

let mock: MockServer;
let project: string;
let recorded = '';

function shadowlap(args: string[]): Promise<{ code: number | null; out: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: project, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
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

beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('Ship the refund fix on Friday.')]) }) });
  project = mkdtempSync(join(tmpdir(), 'sl-extra-reads-'));
  const run = await shadowlap(['run', '--', process.execPath, AGENT]);
  expect(run.code, run.out).toBe(0);
  recorded = /recording run (\w{26})/.exec(run.out)![1]!;
  const packed = await shadowlap(['pack', recorded, 'goldens/notes']);
  expect(packed.code, packed.out).toBe(0);
  // From here on the agent logs the day first: a clock read and a pure tool call nobody recorded.
  writeFileSync(join(project, 'log-time'), '');
}, 60_000);

afterAll(async () => {
  await mock.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('a read the recording never held', () => {
  it('keeps shadowlap test offline and green, and says which reads went live', async () => {
    const before = mock.requests.length;
    const r = await shadowlap(['test', 'goldens/notes', '--json', 'report.json']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toMatch(/✓ notes: 2\/2 replayed, [\d.k]+ input tokens not re-spent, 2 extra reads answered live/);
    expect(r.stdout).toContain('1 passed, 0 failed · 0 upstream requests');
    expect(mock.requests.length).toBe(before);
    const report = JSON.parse(readFileSync(join(project, 'report.json'), 'utf8')) as { results: Array<{ ok: boolean; divergence: unknown; upstreamRequests: number }> };
    expect(report.results[0]).toMatchObject({ ok: true, divergence: null, upstreamRequests: 0 });
  }, 60_000);

  it('keeps a replay clean, its summary naming the reads answered live', async () => {
    const r = await shadowlap(['replay', recorded, '--', process.execPath, AGENT]);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Replay clean: 2/4 calls replayed (1 api, 2 tool, 1 clock/random), 0 upstream requests');
    expect(r.out).toContain('2 extra reads answered live, with no recorded counterpart: #1 clock now, #2 tool format_day');
    // The write was served from the recording, never run again.
    expect(r.out).toContain('saved: Ship the refund fix on Friday.');
  }, 60_000);
});
