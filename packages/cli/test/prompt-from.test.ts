import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockAnthropic, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { referenceScript } from '@shadowlap-testing/reference-agent';

/**
 * --prompt-from through the CLI, on the reference agent: a system prompt changed in the code forks at
 * the chosen model call instead of the first, and the model sees the new prompt from there.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('../../../testing/reference-agent/dist/main.js', import.meta.url));

let mock: MockServer;
let cwd: string;
let db: string;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: referenceScript });
  cwd = mkdtempSync(join(tmpdir(), 'fp-prompt-from-'));
  db = join(cwd, 'store.db');
});
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

describe('--prompt-from', () => {
  it('replays the model calls before the chosen one despite a changed system prompt, and goes live there with the new prompt', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, AGENT]);
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1];
    let store = Store.open(db);
    const models = store.getCalls(runId).filter((c) => c.kind === 'api').map((c) => c.callNo);
    store.close();
    const from = models[5];

    const plain = await shadowlap(['replay', runId], { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(plain.out).toMatch(new RegExp(`Diverged at call ${models[0]} `));

    const before = mock.requests.length;
    const fork = await shadowlap(['replay', runId, '--prompt-from', String(from)], { AGENT_SYSTEM_SUFFIX: 'Be brief.' });
    expect(fork.code, fork.out).toBe(0);
    expect(fork.out).toMatch(new RegExp(`Diverged at call ${from} \\(api POST /v1/messages\\): ${from - 1} calls replayed before divergence`));
    expect(fork.out).toContain(`forced live by --prompt-from ${from}`);
    // Live from the chosen call on: five model calls are left, each with the new prompt.
    const live = mock.requests.slice(before);
    expect(live).toHaveLength(models.length - 5);
    expect(live.every((r) => JSON.stringify((r.body as { system?: unknown }).system).includes('Be brief.'))).toBe(true);

    const bad = await shadowlap(['replay', runId, '--prompt-from', String(models[0] + 1)]);
    expect(bad.code).toBe(2);
    expect(bad.out).toMatch(/is not a model call/);
  });
});
