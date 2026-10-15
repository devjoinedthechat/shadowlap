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
      timeoutMs: 800,
    });
    expect(attempt.kind).toBe('exit');
    expect(attempt.failure!.message).toBe('the agent was stopped after 800ms');
    expect(attempt.output).toContain('[shadowlap] stopped after 800ms');
    expect(existsSync(beat)).toBe(true);
    // The node that sh started is gone too: its heartbeat stops.
    const last = readFileSync(beat, 'utf8');
    const mtime = statSync(beat).mtimeMs;
    await sleep(300);
    expect(readFileSync(beat, 'utf8')).toBe(last);
    expect(statSync(beat).mtimeMs).toBe(mtime);
    store.close();
  });
});
