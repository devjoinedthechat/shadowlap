import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { message, startMockAnthropic, text, type MockServer } from '@shadowlap-testing/mock-anthropic';

/**
 * Agents started through npm and npx, as `shadowlap init` suggests for a Node project (`npm start`,
 * `npm run agent`, `npx tsx agent.ts`). Both set environment variables of their own as they start,
 * and in-process capture must not make that fail: they used to exit 1 without a word, so the
 * recording held no calls.
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const AGENT = fileURLToPath(new URL('./env-agent.mjs', import.meta.url));

let mock: MockServer;
let folder: string;
beforeAll(async () => {
  mock = await startMockAnthropic({ script: () => ({ message: message([text('recorded through npm')]) }) });
  folder = mkdtempSync(join(tmpdir(), 'sl-npm-start-'));
  writeFileSync(join(folder, 'package.json'), JSON.stringify({ name: 'npm-agent', private: true, scripts: { start: `node ${JSON.stringify(AGENT)}`, agent: `node ${JSON.stringify(AGENT)}` } }));
  // A bin the project has installed, as npx finds it without asking the registry.
  mkdirSync(join(folder, 'node_modules', '.bin'), { recursive: true });
  const bin = join(folder, 'node_modules', '.bin', 'env-agent');
  writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(AGENT)} "$@"\n`);
  chmodSync(bin, 0o755);
});
afterAll(async () => {
  await mock.close();
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function shadowlap(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', SHADOWLAP_TELEMETRY: '0', SHADOWLAP_HOME: join(folder, '.sl'), SHADOWLAP_UPSTREAM_ANTHROPIC: mock.url, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' };
    // Capture as `shadowlap run` sets it up, whatever the test runner's own environment says.
    delete env.SHADOWLAP_CAPTURE;
    const child = spawn(process.execPath, [CLI, '--db', join(folder, 'store.db'), ...args], { cwd: folder, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (out += c.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

describe('recording an agent started through npm or npx', () => {
  it('records it with npm start and npm run, and replays it', async () => {
    let runId = '';
    for (const command of [[npm, 'start'], [npm, 'run', 'agent']]) {
      const rec = await shadowlap(['run', '--', ...command]);
      expect(rec.code, rec.out).toBe(0);
      expect(rec.out).toContain('recorded through npm');
      runId = /Recorded (\w{26}): 1 call/.exec(rec.out)?.[1] ?? '';
      expect(runId, rec.out).not.toBe('');
    }
    const replay = await shadowlap(['replay', runId]);
    expect(replay.code, replay.out).toBe(0);
    expect(replay.out).toContain('Replay clean');
  });

  it('records it with npx and an installed bin', async () => {
    if (process.platform === 'win32') return;
    const rec = await shadowlap(['run', '--', npx, '--no-install', 'env-agent']);
    expect(rec.code, rec.out).toBe(0);
    expect(rec.out).toMatch(/Recorded \w{26}: 1 call/);
  });

  it('records an agent that sets a variable that is already set', async () => {
    const rec = await shadowlap(['run', '--', process.execPath, AGENT]);
    expect(rec.code, rec.out).toBe(0);
    expect(rec.out).toMatch(/Recorded \w{26}: 1 call/);
  });
});
