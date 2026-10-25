import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord } from '@shadowlap/engine';
import { runJob, type ReadJob } from '../src/read-jobs.js';
import { ReadPool } from '../src/read-pool.js';
import { recordLoop } from './long-run.js';
import { addRun, DAY, HOUR } from './read-model-store.js';

/**
 * The read models that read every call (read-jobs.ts) are worked out on worker threads beside the
 * dashboard's own, each reading the store through a connection that only reads (read-pool.ts). What
 * a thread answers is what the same job answers worked out here, on the same store; what it works
 * out to keep comes back to the connection that writes; and closing ends the threads.
 */

const NOW = Date.now();
let dir: string;
let dbPath: string;
let store: Store;
let pool: ReadPool;
const id: Record<string, string> = {};
let long: RunRecord;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-read-pool-'));
  dbPath = join(dir, 'shadowlap.db');
  store = Store.open(dbPath);
  id.rec = addRun(store, { startedAt: NOW - DAY, argv: ['node', 'refund_agent.mjs'], calls: [{ code: 'l', request: { messages: [{ role: 'user', content: 'Refund order A-1131.' }] } }, { code: 'l', kind: 'tool' }, { code: 'l' }] });
  id.fork = addRun(store, { parent: id.rec, startedAt: NOW - HOUR, divergence: 3, calls: 'rrl' });
  long = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/work' }, startedAt: NOW - 2 * DAY });
  recordLoop(store, long, 1201);
  pool = new ReadPool({ dbPath, keep: { stats: (rows) => void store.saveRunStats(rows), asks: (rows) => void store.saveRunAsks(rows) } });
});

/** Until the warm-up has been through every run: then a thread and this one know the same. */
async function warmed(): Promise<void> {
  for (let i = 0; i < 400 && !pool.warmed; i++) await new Promise((r) => setTimeout(r, 25));
  expect(pool.warmed).toBe(true);
}

afterAll(async () => {
  await pool.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A job's answer from a thread and worked out here, on the same store, the same way. */
async function both(job: ReadJob): Promise<[unknown, unknown]> {
  const there = await pool.run(job);
  const here = await runJob(store, job);
  expect(there.status).toBe(here.status);
  return [JSON.parse(there.body), JSON.parse(here.body)];
}

describe('read models on threads beside the server', () => {
  it('answer as the same job worked out on the server’s thread', async () => {
    await warmed();
    for (const job of [
      { kind: 'run', runId: id.rec, read: {} },
      { kind: 'run', runId: id.fork, read: {} },
      { kind: 'call', runId: id.rec, read: {}, callNo: 1 },
      { kind: 'lineage', runId: id.fork, read: {} },
      { kind: 'compare', a: id.rec, b: id.fork, cwd: null },
      { kind: 'runs-page', options: { q: 'refund_agent' }, team: null },
      { kind: 'runs-days', options: { tz: 'UTC', now: NOW }, team: null },
      { kind: 'recent', read: {} },
      { kind: 'calls', runId: long.runId, read: {}, from: 201, limit: 100 },
      { kind: 'differences', runId: id.fork, normalizers: [] },
      { kind: 'groups', fixId: 'fix_nothing' },
      { kind: 'activity', before: null },
      { kind: 'show', runId: id.rec, read: {} },
    ] satisfies ReadJob[]) {
      const [there, here] = await both(job);
      expect(there, job.kind).toEqual(here);
    }
  });

  it('says a run isn’t there, or a request is wrong, as the route would', async () => {
    const missing = await pool.run({ kind: 'run', runId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ', read: {} });
    expect(missing.status).toBe(404);
    const badCursor = await pool.run({ kind: 'runs-page', options: { cursor: 'not-a-cursor' }, team: null });
    expect(badCursor.status).toBe(400);
  });

  it('keeps what the warm-up works out through the connection that writes, and says when it has been through every run', async () => {
    await warmed();
    const kept = store.query('SELECT run_id AS id FROM run_stats ORDER BY run_id').map((r) => r.id);
    expect(kept).toEqual([id.rec, id.fork, long.runId].sort());
    expect(store.query('SELECT run_id AS id FROM run_asks ORDER BY run_id').map((r) => r.id)).toEqual([id.rec, long.runId].sort());
    // The Overview then answers whole.
    const summary = JSON.parse((await pool.run({ kind: 'summary', work: { tz: 'UTC', now: NOW, goldens: [], team: null, project: null, warmed: false } })).body);
    expect(summary.warming).toBeUndefined();
    expect(summary.sums.week.runs).toBe(3);
  });

  it('answers a long run from its first calls, then analyses it whole when the thread is free', async () => {
    // A long run no thread has read yet: the one the tests above asked for a page of has been
    // analysed whole since, on the thread that read it.
    const fresh = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/work' }, startedAt: NOW - 3 * DAY });
    recordLoop(store, fresh, 1201);
    const first = await pool.run({ kind: 'run', runId: fresh.runId, read: {} }, { affinity: fresh.runId });
    expect(JSON.parse(first.body)).toMatchObject({ callsTotal: 1201, callsNext: 201, warming: { done: 300, total: 1201 } });
    expect(first.then).toEqual({ kind: 'analyse', runId: fresh.runId });
    // Asked again, by the thread that read it: whole once it has been analysed.
    let again = first;
    for (let i = 0; i < 100 && again.warming; i++) {
      await new Promise((r) => setTimeout(r, 50));
      again = await pool.run({ kind: 'run', runId: fresh.runId, read: {} }, { affinity: fresh.runId });
    }
    expect(again.warming).toBeUndefined();
    expect(JSON.parse(again.body)).toMatchObject({ callsTotal: 1201, callsNext: 501 });
  });

  it('fails a job a thread answers nothing for (one built before that kind of job), rather than wait for good', async () => {
    const script = join(dir, 'stale-worker.mjs');
    writeFileSync(script, "import { parentPort } from 'node:worker_threads';\nparentPort.postMessage({ type: 'ready' });\nparentPort.on('message', (m) => m.type === 'close' ? parentPort.postMessage({ type: 'closed' }) : parentPort.postMessage({ type: 'answer', id: m.id }));\n");
    const lines: string[] = [];
    const stale = new ReadPool({ dbPath, keep: { stats: () => undefined, asks: () => undefined }, size: 1, script: pathToFileURL(script), log: (l) => lines.push(l) });
    try {
      await expect(stale.run({ kind: 'recent', read: {} })).rejects.toThrow(/no answer for a recent job/);
      expect(lines.join('\n')).toMatch(/is the dashboard built/);
    } finally {
      await stale.close();
    }
  });

  it('ends its threads when closed, and refuses work after', async () => {
    const own = new ReadPool({ dbPath, keep: { stats: () => undefined, asks: () => undefined } });
    expect((await own.run({ kind: 'recent', read: {} })).status).toBe(200);
    await own.close();
    await expect(own.run({ kind: 'recent', read: {} })).rejects.toThrow(/stopping/);
  });
});
