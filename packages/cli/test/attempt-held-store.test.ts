import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { Sidecar } from '@shadowlap/sidecar';
import { judgeRequests, message, startMockAnthropic, text, withJudge } from '@shadowlap-testing/mock-anthropic';
import { AttemptRunner } from '../src/attempts.js';
import { parseExpect } from '../src/checks.js';
import { judgeAttempt, repeatUnderSidecar } from '../src/run-agent.js';

/**
 * An attempt of blame or verify whose agent makes its last call while another process holds the
 * store (the dashboard, gc, another recording) ends at once, and reads its calls once their rows are
 * written: it waits on the store writer's timer, never on the thread every other attempt's answers
 * stream on. Here the store is let go by a timer of this process, which a wait on the thread would
 * hold up past the writer's deadline, and the attempt would find its last call missing.
 */
const dir = mkdtempSync(join(tmpdir(), 'sl-attempt-held-'));
const holders: ChildProcess[] = [];
afterAll(() => {
  for (const h of holders) h.kill();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (done: () => boolean) => {
  while (!done()) await sleep(10);
};

/** Another process holding the store's write lock until it is told to let go (20 s at most). */
async function holdStore(path: string): Promise<{ release: () => Promise<void> }> {
  const child = spawn(process.execPath, ['-e', `const db = new (require('node:sqlite').DatabaseSync)(process.env.DB); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); const done = () => { db.exec('COMMIT'); db.close(); process.exit(0); }; process.stdin.once('data', done); setTimeout(done, 20000);`], { env: { ...process.env, DB: path }, stdio: ['pipe', 'pipe', 'ignore'] });
  holders.push(child);
  await new Promise<void>((resolve) => child.stdout.on('data', (chunk: Buffer) => chunk.toString('utf8').includes('locked') && resolve()));
  return {
    release: async () => {
      if (child.exitCode !== null) return;
      child.stdin.end('let go\n');
      await once(child, 'exit');
    },
  };
}

/** Two clock reads through the resolution API, as `now()` makes them: the second once `locked` exists. */
const agent = (ready: string, locked: string, done: string) => `
  const fs = require('fs');
  const now = () => fetch(process.env.SHADOWLAP_URL + '/r/' + process.env.SHADOWLAP_RUN_ID + '/v1/calls/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clock', name: 'now', label: '' }) }).then((r) => r.json());
  (async () => {
    await now();
    fs.writeFileSync(${JSON.stringify(ready)}, '');
    while (!fs.existsSync(${JSON.stringify(locked)})) await new Promise((r) => setTimeout(r, 10));
    await now();
    fs.writeFileSync(${JSON.stringify(done)}, '');
  })();`;

/** A clock read once `locked` exists, then an exit with 9, as an agent whose Node refused the preload exits. */
const exitsNine = (ready: string, locked: string, done: string) => `
  const fs = require('fs');
  fs.writeFileSync(${JSON.stringify(ready)}, '');
  (async () => {
    while (!fs.existsSync(${JSON.stringify(locked)})) await new Promise((r) => setTimeout(r, 10));
    await fetch(process.env.SHADOWLAP_URL + '/r/' + process.env.SHADOWLAP_RUN_ID + '/v1/calls/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clock', name: 'now', label: '' }) });
    fs.writeFileSync(${JSON.stringify(done)}, '');
    process.exit(9);
  })();`;

describe('an attempt that ends while another process holds the store', () => {
  it('reads every call its agent made once their rows are written, without holding the thread', async () => {
    const db = join(dir, 'store.db');
    // The recording the attempt replays: the same two reads.
    const setup = Store.open(db);
    const recorder = await Sidecar.start({ store: setup });
    const parent = recorder.startRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: dir } });
    for (let i = 0; i < 2; i++) await fetch(`${recorder.url}/r/${parent.runId}/v1/calls/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clock', name: 'now', label: '' }) });
    recorder.endRun(parent.runId, 'completed');
    await recorder.close();
    const recorded = setup.getRun(parent.runId)!;
    setup.close();

    const [ready, locked, done] = ['ready', 'locked', 'done'].map((f) => join(dir, f));
    const r = await AttemptRunner.start({ db }, { writes: 'block', reads: 'replay', liveTools: [], spec: null, budget: null, timeoutMs: 30_000, guard: 'off' });
    try {
      const attempt = r.attempt({ parent: recorded, argv: [process.execPath, '-e', agent(ready, locked, done)], commandFromImport: false });
      // Held once the agent has made its first read, so its second read's rows wait their turn.
      await until(() => existsSync(ready));
      const lock = await holdStore(db);
      writeFileSync(locked, '');
      await until(() => existsSync(done));
      // Let go by this process's timer, once the agent has exited and its attempt is ending.
      setTimeout(() => void lock.release(), 500);
      const a = await attempt;
      expect(a.code).toBe(0);
      expect(a.summary).toMatchObject({ total: 2, byOrigin: { replayed: 2 } });
      expect(a.calls.map((c) => `${c.callNo} ${c.kind} ${c.origin} ${c.end?.outcome}`)).toEqual(['1 clock replayed ok', '2 clock replayed ok']);
      expect(a.summary.warnings.filter((w) => /store/.test(w))).toEqual([]);
    } finally {
      await r.close();
    }
  }, 60_000);

  it('of replay --repeat that exits 9 is told from a Node that refused the preload by its calls, read once their rows are written', async () => {
    const db = join(dir, 'repeat.db');
    const setup = Store.open(db);
    const recorder = await Sidecar.start({ store: setup });
    const parent = recorder.startRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: dir } });
    await fetch(`${recorder.url}/r/${parent.runId}/v1/calls/resolve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'clock', name: 'now', label: '' }) });
    recorder.endRun(parent.runId, 'completed');
    await recorder.close();
    const recorded = setup.getRun(parent.runId)!;
    setup.close();

    const [ready, locked, done] = ['nine-ready', 'nine-locked', 'nine-done'].map((f) => join(dir, f));
    const argv = [process.execPath, '-e', exitsNine(ready, locked, done)];
    const attempts = repeatUnderSidecar({ db }, argv, 1, 1, (sidecar) => sidecar.startRun({ mode: 'replay', parentRunId: recorded.runId, command: { argv, cwd: dir } }), 'off', { recording: recorded });
    // Held once the agent is up, so its read's rows wait behind the lock when it exits 9.
    await until(() => existsSync(ready));
    const lock = await holdStore(db);
    writeFileSync(locked, '');
    await until(() => existsSync(done));
    // Let go by this process's timer, which a count of its calls made on the thread would hold up past the writer's deadline.
    setTimeout(() => void lock.release(), 500);
    const [attempt] = await attempts;
    expect(attempt.code).toBe(9);
    const store = Store.open(db);
    try {
      expect(store.getCalls(attempt.run.runId)).toHaveLength(1);
    } finally {
      store.close();
    }
  }, 60_000);

  it('asks its judge about every call its agent made, once their rows are written, without holding the thread', async () => {
    const mock = await startMockAnthropic({ eventDelayMs: () => 0, script: withJudge((q) => (q.material.includes('shipped on Monday') ? { verdict: 'yes', reason: 'it says when' } : { verdict: 'no', reason: 'it says nothing' }), () => ({ message: message([text('Your order shipped on Monday.')]) })) });
    const db = join(dir, 'judged.db');
    const store = Store.open(db);
    const sidecar = await Sidecar.start({ store, upstreams: { anthropic: mock.url } });
    const spec = { ...parseExpect({ judge: [{ name: 'when', question: 'Does the answer say when the order shipped?', model: 'claude-haiku-4-5' }] }, 'expect'), fork: false, repeat: 1, passes: 1 };
    try {
      const run = sidecar.startRun({ mode: 'record', command: { argv: ['agent'], cwd: dir } });
      const lock = await holdStore(db);
      // The agent's answer, given at once with the store held: its rows wait their turn.
      const res = await fetch(`${sidecar.envFor(run.runId).ANTHROPIC_BASE_URL}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'Where is my order?' }] }) });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      // Let go by this process's timer, while the judge waits to read the run.
      setTimeout(() => void lock.release(), 400);
      const judged = await judgeAttempt(store, sidecar, run.runId, spec, { code: 0, interrupted: false, stdout: '', upstreams: { anthropic: mock.url }, redact: [], prices: undefined });
      expect(judged.verdicts.get('when')).toMatchObject({ verdict: 'yes', reason: 'it says when' });
      expect(judgeRequests(mock.requests).map((q) => q.material)).toEqual([expect.stringContaining('Your order shipped on Monday.')]);
      sidecar.endRun(run.runId, 'completed');
    } finally {
      await sidecar.close();
      store.close();
      await mock.close();
    }
  }, 60_000);
});
