import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * An agent that calls its model as Claude Code does, naming a new session (and its machine) in
 * every request's metadata.user_id, records, replays under --strict and passes shadowlap test on
 * another machine with no normalizer configured. An agent that puts a new UUID there diverges.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

/** One model call. USER_ID=claude-code names a fresh Claude Code session on DEVICE; anything else, a new UUID. */
const AGENT = `import { randomBytes, randomUUID } from 'node:crypto';
const device = process.env.DEVICE ?? randomBytes(32).toString('hex');
const userId = process.env.USER_ID === 'claude-code' ? JSON.stringify({ device_id: device, account_uuid: '', session_id: randomUUID() }) : randomUUID();
const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'anthropic-beta': 'claude-code-20250219', 'user-agent': 'claude-cli/2.1.309 (external, sdk-ts)', 'x-app': 'cli' },
  body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 64, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: 'Fix the failing test.' }], metadata: { user_id: userId } }),
});
console.log((await res.json()).content[0].text);
`;

let mock: MockServer;
let project: string;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('Fixed.')]) }) });
  project = mkdtempSync(join(tmpdir(), 'sl-claude-code-'));
  writeFileSync(join(project, 'agent.mjs'), AGENT);
});
afterAll(async () => {
  await mock.close();
  rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', join(project, 'store.db'), ...args], { cwd: project, env: { ...process.env, SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_HOME: join(project, 'home'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

describe('an agent that names its Claude Code session in metadata.user_id', () => {
  it('replays clean in a new session, and passes shadowlap test on another machine, with no normalizer', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs'], { USER_ID: 'claude-code' });
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1];
    const replayed = await shadowlap(['replay', runId, '--strict'], { USER_ID: 'claude-code' });
    expect(replayed.code, replayed.out).toBe(0);
    expect(replayed.out).toContain('Replay clean: 1/1 calls replayed');
    expect((await shadowlap(['pack', runId, 'goldens/claude-code'], {})).code).toBe(0);
    const tested = await shadowlap(['test', 'goldens/claude-code'], { USER_ID: 'claude-code', DEVICE: 'cd'.repeat(32) });
    expect(tested.code, tested.out).toBe(0);
    expect(tested.out).toContain('1 passed, 0 failed');
  }, 60_000);

  it('is no other agent: one that sends a new UUID there diverges on it', async () => {
    const recorded = await shadowlap(['run', '--', process.execPath, 'agent.mjs'], {});
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1];
    const replayed = await shadowlap(['replay', runId, '--strict'], {});
    expect(replayed.code, replayed.out).toBe(1);
    expect(replayed.out).toContain('$.metadata.user_id');
  }, 60_000);
});
