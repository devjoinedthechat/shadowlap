import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A project that sets OPENAI_BASE_URL to a server whose API root doesn't end in /v1, laid out like
 * GitHub Models: `shadowlap run` records through it as the agent would reach it without Shadowlap.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./openai-base-agent.mjs', import.meta.url));

let server: Server;
let base: string;
let cwd: string;
const paths: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    req.resume();
    req.on('end', () => {
      if (req.url !== '/inference/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: `no route ${req.url}` } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-5', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/inference`;
  cwd = mkdtempSync(join(tmpdir(), 'sl-openai-base-'));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const clean = { ...process.env };
    // Every SHADOWLAP_ variable but the run's own home for this machine's files (testing/no-stray-stores.mjs).
    for (const k of Object.keys(clean)) if ((k.startsWith('SHADOWLAP_') && k !== 'SHADOWLAP_HOME') || k === 'OPENAI_BASE_URL') delete clean[k];
    const child = spawn(process.execPath, args, { cwd, env: { ...clean, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

describe('OPENAI_BASE_URL with an API root that has no /v1', () => {
  it('is reached at the path the SDK sends there, and the recording replays', async () => {
    paths.length = 0;
    const alone = await run([AGENT], { OPENAI_BASE_URL: base });
    expect(alone.out.trim()).toBe('{"ok":"hello"}');
    expect(paths).toEqual(['POST /inference/chat/completions']);

    const recorded = await run([CLI, '--db', join(cwd, 'store.db'), 'run', '--', process.execPath, AGENT], { OPENAI_BASE_URL: base });
    expect(recorded.code, recorded.out).toBe(0);
    expect(recorded.out).toContain('{"ok":"hello"}');
    expect(paths).toEqual(['POST /inference/chat/completions', 'POST /inference/chat/completions']);

    // Offline, from the recording, under the call's usual name: no OPENAI_BASE_URL needed.
    const runId = /recording run (\w{26})/.exec(recorded.out)![1];
    const replay = await run([CLI, '--db', join(cwd, 'store.db'), 'replay', runId, '--strict'], {});
    expect(replay.code, replay.out).toBe(0);
    expect(replay.out).toMatch(/Replay clean: 1\/1 calls replayed/);
    expect(paths).toHaveLength(2);
  });
});
