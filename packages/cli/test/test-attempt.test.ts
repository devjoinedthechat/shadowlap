import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { testAttempt } from '../src/run-agent.js';

/** A replay with a time limit stops the agent and everything it started, as bisect needs at a commit where the agent hangs. */
const dir = mkdtempSync(join(tmpdir(), 'sl-attempt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A shell that starts the real work as its own child; Windows has no sh.
describe.skipIf(process.platform === 'win32')('a replay with a time limit', () => {
  it('stops the whole process group, not only the command it started', async () => {
    const store = Store.open(':memory:');
    const parent = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: dir } });
    store.endRun(parent.runId, 'completed');
    const beat = join(dir, 'beat');
    // sh starts node and waits; node writes a heartbeat until it is killed.
    const script = `setInterval(() => require('fs').writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 20)`;
    const attempt = await testAttempt(store, parent, {
      cwd: dir,
      upstreams: {},
      extraEnv: {},
      writes: 'block',
      guard: 'off',
      normalizers: [],
      prices: undefined,
      clock: undefined,
      spec: null,
      argv: ['sh', '-c', `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}; echo never`],
      // Long enough for node to start and beat on a machine busy with other test runs.
      timeoutMs: 3000,
    });
    expect(attempt.kind).toBe('exit');
    expect(attempt.failure!.message).toBe('the agent was stopped after 3.0s');
    expect(attempt.output).toContain('[shadowlap] stopped after 3.0s');
    expect(existsSync(beat), 'node started and beat before the limit').toBe(true);
    // The node that sh started is gone too: its heartbeat stops.
    const last = readFileSync(beat, 'utf8');
    const mtime = statSync(beat).mtimeMs;
    await sleep(300);
    expect(readFileSync(beat, 'utf8')).toBe(last);
    expect(statSync(beat).mtimeMs).toBe(mtime);
    store.close();
  });

  it('fails an agent stopped at the limit even when it catches the signal and exits 0', async () => {
    const store = Store.open(':memory:');
    const parent = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: dir } });
    store.endRun(parent.runId, 'completed');
    const attempt = await testAttempt(store, parent, {
      cwd: dir,
      upstreams: {},
      extraEnv: {},
      writes: 'block',
      guard: 'off',
      normalizers: [],
      prices: undefined,
      clock: undefined,
      spec: null,
      argv: [process.execPath, '-e', "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
      // Long enough for node to start and install its handler on a busy machine.
      timeoutMs: 2500,
    });
    expect(attempt.code).toBe(0);
    expect(attempt).toMatchObject({ kind: 'exit', failure: { message: 'the agent was stopped after 2.5s' } });
    store.close();
  });
});

// node starts the work as a child of its own, on every system: on Windows the tree is ended with taskkill.
describe('a replay with a time limit, whose agent starts a process of its own', () => {
  it('stops that process too', async () => {
    const store = Store.open(':memory:');
    const parent = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.mjs'], cwd: dir } });
    store.endRun(parent.runId, 'completed');
    const beat = join(dir, 'beat-child');
    const heartbeat = `setInterval(() => require('fs').writeFileSync(${JSON.stringify(beat)}, String(Date.now())), 20)`;
    const agent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(heartbeat)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    const attempt = await testAttempt(store, parent, {
      cwd: dir,
      upstreams: {},
      extraEnv: {},
      writes: 'block',
      guard: 'off',
      normalizers: [],
      prices: undefined,
      clock: undefined,
      spec: null,
      argv: [process.execPath, '-e', agent],
      // Long enough for both to start on a machine busy with other test runs (Windows starts processes slowly).
      timeoutMs: process.platform === 'win32' ? 8000 : 3000,
    });
    expect(attempt.failure!.message).toMatch(/^the agent was stopped after /);
    expect(existsSync(beat), 'the child started and beat before the limit').toBe(true);
    // The child the agent started is gone too: its heartbeat stops.
    await sleep(300);
    const last = readFileSync(beat, 'utf8');
    await sleep(300);
    expect(readFileSync(beat, 'utf8')).toBe(last);
    store.close();
  });
});
