import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * A run built from a capture has no command. Through the CLI: it is recognisable from `ls --json`
 * alone, and every command that would have to start the agent refuses with the way forward instead
 * of spawning the placeholder and recording a failed run.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));

let cwd: string;
let db: string;
let runId: string;

function shadowlap(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, '--db', db, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const har = {
  log: {
    version: '1.2',
    entries: [
      {
        startedDateTime: '2026-09-18T10:00:00.000Z',
        time: 420,
        request: {
          method: 'POST',
          url: 'https://api.anthropic.com/v1/messages',
          headers: [{ name: 'content-type', value: 'application/json' }],
          postData: { mimeType: 'application/json', text: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }) },
        },
        response: {
          status: 200,
          headers: [{ name: 'content-type', value: 'application/json' }],
          content: { mimeType: 'application/json', text: JSON.stringify({ id: 'msg_1', model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 12, output_tokens: 3 } }) },
        },
      },
    ],
  },
};

beforeAll(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'fp-capture-'));
  db = join(cwd, 'store.db');
  writeFileSync(join(cwd, 'session.har'), JSON.stringify(har));
  const imported = await shadowlap(['import', 'har', 'session.har', '--json']);
  expect(imported.code).toBe(0);
  runId = (JSON.parse(imported.out) as { runId: string }).runId;
});
afterAll(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('a run imported from a capture', () => {
  it('says in ls --json that it has no command and covers model calls only', async () => {
    const { code, out } = await shadowlap(['ls', '--json']);
    expect(code).toBe(0);
    const [run] = JSON.parse(out) as Array<Record<string, unknown>>;
    expect(run).toMatchObject({ runId, hasCommand: false, partial: ['api'], repeat: null, checks: null, forkedAt: null });
    expect((run!.imported as { from: string }).from).toContain('session.har');
  });

  it('shows its cost as captured, not spent', async () => {
    const { out } = await shadowlap(['show', runId]);
    expect(out).toContain('of traffic captured');
  });

  it('refuses a replay without a command, naming the way forward, and records nothing', async () => {
    const { code, out } = await shadowlap(['replay', runId]);
    expect(code).not.toBe(0);
    expect(out).toContain('was imported from a capture');
    expect(out).toContain(`shadowlap replay ${runId.slice(0, 10)} -- python agent.py`);
    const runs = JSON.parse((await shadowlap(['ls', '--json'])).out) as unknown[];
    expect(runs).toHaveLength(1);
  });

  it('fails as a golden with the reason, instead of spawning its placeholder', async () => {
    expect((await shadowlap(['pack', runId, 'golden'])).code).toBe(0);
    const { code, out } = await shadowlap(['test', 'golden']);
    expect(code).toBe(1);
    expect(out).toContain('has no command to run');
  });

  it('is deleted by rm, which names each run it deleted', async () => {
    const { code, out } = await shadowlap(['rm', runId]);
    expect(code).toBe(0);
    expect(out).toContain(`deleted 1 run (${runId.slice(0, 10)})`);
  });
});
