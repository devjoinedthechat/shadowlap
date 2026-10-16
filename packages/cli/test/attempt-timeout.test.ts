import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { AttemptRunner } from '../src/attempts.js';

/**
 * Blame's probes and verify's attempts stop the agent and everything it started, at the time limit
 * and when it exits, as `test` and `bisect` do (test-attempt.test.ts): a probe that hangs must not
 * leave its agent's work running, or sending, after blame has moved on.
 */
const dir = mkdtempSync(join(tmpdir(), 'sl-attempt-timeout-'));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const heartbeat = (file: string) => `setInterval(() => require('fs').writeFileSync(${JSON.stringify(file)}, String(Date.now())), 20)`;
/** An agent that starts a process of its own, which writes a heartbeat until it is stopped. */
const starts = (file: string, then: string) => `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(heartbeat(file))}], { stdio: 'ignore' }); ${then}`;

async function runner(timeoutMs: number) {
  const db = join(dir, `store-${timeoutMs}.db`);
  const setup = Store.open(db);
  const parent = setup.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: dir } });
  setup.endRun(parent.runId, 'failed');
  const recorded = setup.getRun(parent.runId)!;
  setup.close();
  return { recorded, runner: await AttemptRunner.start({ db }, { writes: 'block', reads: 'replay', liveTools: [], spec: null, budget: null, timeoutMs, guard: 'off' }) };
}

/** Whether the heartbeat has stopped: it holds still for a while, well past its interval. */
async function stopped(file: string): Promise<boolean> {
  await sleep(300);
  const last = readFileSync(file, 'utf8');
  await sleep(300);
  return readFileSync(file, 'utf8') === last;
}

describe('an attempt of blame or verify', () => {
  it('stops, at its time limit, the process its agent started too', async () => {
    const beat = join(dir, 'beat-timeout');
    // Long enough for both to start on a machine busy with other test runs (Windows starts processes slowly).
    const { recorded, runner: r } = await runner(process.platform === 'win32' ? 8000 : 3000);
    try {
      const a = await r.attempt({ parent: recorded, argv: [process.execPath, '-e', starts(beat, 'setInterval(() => {}, 1000)')], commandFromImport: false });
      expect(a.passed).toBe(false);
      expect(a.failures[0]).toMatch(/^timed out after /);
      expect(existsSync(beat), 'the child started and beat before the limit').toBe(true);
      expect(await stopped(beat)).toBe(true);
    } finally {
      await r.close();
    }
  });

  // Once the agent has exited, what it started can be found from it only through its process group.
  it.skipIf(process.platform === 'win32')('stops what its agent left running when it exited', async () => {
    const beat = join(dir, 'beat-exit');
    const { recorded, runner: r } = await runner(30_000);
    try {
      const wait = `const t = setInterval(() => { if (require('fs').existsSync(${JSON.stringify(beat)})) { clearInterval(t); process.exit(0); } }, 20)`;
      const a = await r.attempt({ parent: recorded, argv: [process.execPath, '-e', starts(beat, wait)], commandFromImport: false });
      expect(a.code).toBe(0);
      expect(await stopped(beat)).toBe(true);
    } finally {
      await r.close();
    }
  });
});
