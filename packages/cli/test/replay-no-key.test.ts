import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';
import { startMockOpenAI, turn, type MockServer as OpenAIMock } from '@shadowlap-testing/mock-openai';

/**
 * A clean replay needs no real key, and CI no secrets: an agent recorded with its keys in the
 * environment replays with none there. Its SDKs read their keys from there, and refuse to send a
 * request without one, even one the recording answers, so the replay gives them a placeholder, here
 * for two providers in one run. Which keys a replay gets is placeholder-keys.test.ts's to show.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./keyless-agent.mjs', import.meta.url));

let anthropic: MockServer;
let openai: OpenAIMock;
let dir: string;
beforeAll(async () => {
  anthropic = await startMockAnthropic({ script: () => ({ message: message([text('It ships today.')]) }) });
  openai = await startMockOpenAI({ script: () => ({ turn: turn('It shipped yesterday.') }) });
  dir = mkdtempSync(join(tmpdir(), 'sl-no-key-'));
});
afterAll(async () => {
  await Promise.all([anthropic.close(), openai.close()]);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

/** The environment without any key, endpoint or shadowlap setting of this machine's, nor an Anthropic profile it signed in with. */
function bare(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(SHADOWLAP_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|AZURE_|AWS_|NODE_OPTIONS$)/.test(k)) delete env[k];
  return { ...env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(dir, 'home'), ANTHROPIC_CONFIG_DIR: join(dir, 'no-profile') };
}

function run(argv: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: dir, env: { ...bare(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}
const shadowlap = (args: string[], env: NodeJS.ProcessEnv = {}) => run([CLI, '--db', join(dir, 'store.db'), ...args], env);

describe('a replay with no key in the environment', () => {
  it('serves a recording made with keys, as shadowlap replay and shadowlap test run it', async () => {
    // Without a key, the agent can't so much as build its clients.
    const alone = await run([AGENT]);
    expect(alone.code).not.toBe(0);
    expect(alone.out).toMatch(/OPENAI_API_KEY/);

    const recorded = await shadowlap(['run', '--', process.execPath, AGENT], { ANTHROPIC_API_KEY: 'sk-ant-recording', OPENAI_API_KEY: 'sk-recording', SHADOWLAP_UPSTREAM_ANTHROPIC: anthropic.url, SHADOWLAP_UPSTREAM_OPENAI: openai.url });
    expect(recorded.code, recorded.out).toBe(0);
    const runId = /Recorded (\w{26})/.exec(recorded.out)?.[1] ?? '';
    expect(runId, recorded.out).not.toBe('');
    const sent = anthropic.requests.length + openai.requests.length;
    expect(sent).toBe(2);

    const replayed = await shadowlap(['replay', runId]);
    expect(replayed.code, replayed.out).toBe(0);
    expect(replayed.out).toContain('{"anthropic":"It ships today.","openai":"It shipped yesterday."}');
    expect(replayed.out).toContain('Replay clean');

    // CI: a golden packed from it, tested with no secrets.
    expect((await shadowlap(['pack', runId, join(dir, 'goldens', 'order')])).code).toBe(0);
    const tested = await shadowlap(['test', join(dir, 'goldens', 'order')]);
    expect(tested.code, tested.out).toBe(0);
    expect(tested.out).toMatch(/1 passed, 0 failed/);
    expect(anthropic.requests.length + openai.requests.length).toBe(sent);
  });

});
