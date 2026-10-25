import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { startMockOpenAI, turn, type MockServer } from '@shadowlap-testing/mock-openai';
import { captureConfig } from '../src/run-agent.js';
import { loadConfig } from '../src/config.js';

/**
 * A host the config declares (`providers`) is captured and recorded like a built-in provider: an
 * agent whose OpenAI client is set in code to an OpenRouter-style gateway is recorded through it,
 * as OpenAI's calls, and replays offline.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./gateway-agent.mjs', import.meta.url));
const CONFIG = { providers: [{ host: 'openrouter.test', format: 'openai', root: '/api/v1' }] };

let mock: MockServer;
let cwd: string;
beforeAll(async () => {
  mock = await startMockOpenAI({ script: () => ({ turn: turn('Hello from the gateway.') }), root: '/api' });
  cwd = mkdtempSync(join(tmpdir(), 'sl-declared-'));
  writeFileSync(join(cwd, 'shadowlap.config.json'), JSON.stringify(CONFIG));
});
afterAll(async () => {
  await mock.close();
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const clean = { ...process.env };
    for (const k of Object.keys(clean)) if (k.startsWith('SHADOWLAP_') || k.startsWith('OPENAI_')) delete clean[k];
    const child = spawn(process.execPath, args, { cwd, env: { ...clean, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

describe('a host the config declares', () => {
  it('is in what capture routes to the sidecar, and only while the config declares it', () => {
    const config = loadConfig(cwd);
    expect(config.providers).toEqual(CONFIG.providers);
    const routes = (JSON.parse(captureConfig({})) as { routes: Array<[string, string]> }).routes;
    expect(routes).toContainEqual(['^openrouter\\.test$', 'openrouter.test']);
    // OpenAI's SDK on Bedrock is captured under Bedrock's own route.
    expect(new RegExp(routes.find(([, id]) => id === 'bedrock')![0]).test('bedrock-mantle.us-west-2.api.aws')).toBe(true);
    loadConfig(join(cwd, 'nowhere'));
    expect((JSON.parse(captureConfig({})) as { routes: Array<[string, string]> }).routes.map(([, id]) => id)).not.toContain('openrouter.test');
  });

  it('records an agent whose client is set in code to it, as OpenAI calls through it, and replays them offline', async () => {
    const db = join(cwd, 'store.db');
    const recorded = await run([CLI, '--db', db, 'run', '--', process.execPath, AGENT], { SHADOWLAP_UPSTREAM_OPENROUTER_TEST: mock.url });
    expect(recorded.code, recorded.out).toBe(0);
    expect(recorded.out).toContain('{"text":"Hello from the gateway."}');
    expect(mock.requests).toHaveLength(1);
    const runId = /recording run (\w{26})/.exec(recorded.out)![1];
    const store = Store.open(db);
    try {
      const [call] = store.getCalls(runId);
      expect(call).toMatchObject({ kind: 'api', name: 'POST /api/v1/chat/completions', meta: { provider: 'openai', via: 'openrouter.test' } });
      expect(call.end!.meta.usage?.inputTokens).toBeGreaterThan(0);
    } finally {
      store.close();
    }

    // Nothing upstream now: the recording answers.
    const replay = await run([CLI, '--db', db, 'replay', runId, '--strict'], { SHADOWLAP_UPSTREAM_OPENROUTER_TEST: 'http://127.0.0.1:9' });
    expect(replay.code, replay.out).toBe(0);
    expect(replay.out).toContain('{"text":"Hello from the gateway."}');
    expect(replay.out).toMatch(/Replay clean: 1\/1 calls replayed/);
    expect(mock.requests).toHaveLength(1);
  });
});
