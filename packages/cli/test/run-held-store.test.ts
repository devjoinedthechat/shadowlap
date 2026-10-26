import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';

/**
 * `shadowlap run` whose agent's last call is answered while another process holds the store, longer
 * than the writer tries a row for (10 s): the run ends at once, and the command waits for it to be
 * written before it prints its summary, which says what could not be. The run's end itself waits for
 * the store to be free, so the run never stays "running".
 */
const CLI = fileURLToPath(new URL('../bin/shadowlap.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'sl-run-held-'));
const holders: ChildProcess[] = [];
afterAll(() => {
  for (const h of holders) h.kill();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (done: () => boolean) => {
  while (!done()) await sleep(20);
};

/** Another process holding the store's write lock until it is told to let go (60 s at most). */
async function holdStore(path: string): Promise<{ release: () => Promise<void> }> {
  const child = spawn(process.execPath, ['-e', `const db = new (require('node:sqlite').DatabaseSync)(process.env.DB); db.exec('BEGIN IMMEDIATE'); process.stdout.write('locked\\n'); const done = () => { db.exec('COMMIT'); db.close(); process.exit(0); }; process.stdin.once('data', done); setTimeout(done, 60000);`], { env: { ...process.env, DB: path }, stdio: ['pipe', 'pipe', 'ignore'] });
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

describe('shadowlap run while another process holds the store', () => {
  it('prints what of the run could not be written, and leaves the run ended, not running', async () => {
    const db = join(dir, 'store.db');
    const summaryFile = join(dir, 'summary.json');
    const [ready, locked, done] = ['ready', 'locked', 'done'].map((f) => join(dir, f));
    const child = spawn(process.execPath, [CLI, '--db', db, 'run', '--summary-json', summaryFile, '--', process.execPath, '-e', agent(ready, locked, done)], { cwd: dir, env: { ...process.env, SHADOWLAP_TELEMETRY: '0', NO_COLOR: '1', SHADOWLAP_GUARD: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    const exited = once(child, 'exit');
    // Held once the agent has made its first read, past the writer's 10 s for its second read's rows.
    await until(() => existsSync(ready));
    const lock = await holdStore(db);
    writeFileSync(locked, '');
    await until(() => existsSync(done));
    await sleep(11_000);
    await lock.release();
    const [code] = (await exited) as [number | null];
    expect(code, out).toBe(0);
    // In the summary it printed, and in the one it wrote.
    expect(out).toMatch(/Call 2 could not be written to the store .*: it is missing from the recording/);
    const { summary } = JSON.parse(readFileSync(summaryFile, 'utf8')) as { summary: { runId: string; total: number; warnings: string[] } };
    expect(summary.warnings.join('\n')).toMatch(/Call 2 could not be written to the store/);
    // The run is ended in the store, with the call it could write.
    const store = Store.open(db);
    try {
      expect(store.getRun(summary.runId)?.status).toBe('completed');
      expect(store.getCalls(summary.runId)).toHaveLength(1);
    } finally {
      store.close();
    }
  }, 90_000);
});
