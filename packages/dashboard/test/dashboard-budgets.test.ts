import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord } from '@shadowlap/engine';
import { startDashboard, type Dashboard } from '../src/index.js';
import { runJob } from '../src/read-jobs.js';
import { recordLoop } from './long-run.js';

/**
 * The dashboard's own thread answers every request while the read models that read every call of a
 * run, or of every run, are worked out on threads beside it (read-pool.ts), and a long run comes a
 * page at a time. The budgets hold on a machine busy with other work, as the one they were written
 * on was: a time a browser waits is the median of several answers, and a bound on the slowest is
 * set against the work it would have waited for.
 *
 * - With 10,000 runs whose totals no dashboard has kept yet, /api/summary answers at once with how
 *   far the warm-up has got, and /api/meta, asked all the while the totals warm, answers in under
 *   100 ms (median), none of its answers waiting for the totals: the slowest takes under a second,
 *   or under a quarter of the time the totals took to warm, where it used to wait for all of it.
 * - A run of 20,000 calls answers its first page under 1 MB, where it sent every call at once
 *   (15 MB), and works it out in under 500 ms of CPU, read through a connection of its own as a
 *   thread reads it (the median of five). CPU rather than the time the browser waits: a busy machine
 *   stretches that with work of its own, which says nothing of the page's. The wait is printed.
 *   Its other pages come from /calls?from=.
 * - Comparing two such runs holds no request up: /api/meta beside it answers in under 100 ms
 *   (median), the slowest in under a second, or under half the time the comparison took.
 */

const TIMEOUT = 300_000;
const META_MS = 100;
/** Far above any answer that didn't wait for the read models; a bound of its own when the work it might wait for is short. */
const NEVER_WAITED_MS = 1000;
const FIRST_PAGE_CPU_MS = 500;
const FIRST_PAGE_BYTES = 1024 * 1024;

async function ask(d: Dashboard, path: string): Promise<{ status: number; ms: number; bytes: number; body: any }> {
  const t0 = performance.now();
  const res = await fetch(`${d.url}/api/${path}`, { headers: { 'x-shadowlap-token': d.token } });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - t0, bytes: Buffer.byteLength(text), body: text ? JSON.parse(text) : null };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Asks /api/meta every 20 ms while `work` runs: each answer's time. */
async function metaBeside<T>(d: Dashboard, work: () => Promise<T>): Promise<{ out: T; metas: number[] }> {
  let busy = true;
  const metas: number[] = [];
  const pings = (async () => {
    while (busy) {
      const m = await ask(d, 'meta');
      expect(m.status).toBe(200);
      metas.push(m.ms);
      await wait(20);
    }
  })();
  try {
    return { out: await work(), metas };
  } finally {
    busy = false;
    await pings;
  }
}

/** /api/meta's answers beside work that took `workMs`: the median under META_MS, and none of them waiting for the work (`share` of it at most, or a second). */
function metaHeld(metas: readonly number[], what: string, workMs: number, share: number): void {
  const slowest = Math.max(...metas);
  process.stdout.write(`/api/meta ${what} (${(workMs / 1000).toFixed(1)} s): ${metas.length} answers, median ${median(metas).toFixed(0)} ms, the slowest ${slowest.toFixed(0)} ms\n`);
  expect(median(metas), `/api/meta's median ${what}`).toBeLessThan(META_MS);
  expect(slowest, `/api/meta's slowest answer ${what}, which took ${workMs.toFixed(0)} ms`).toBeLessThan(Math.max(NEVER_WAITED_MS, workMs * share));
}

/** The CPU `work` takes, in milliseconds: this process's, its threads' and its garbage collector's. */
async function cpuOf<T>(work: () => Promise<T>): Promise<{ out: T; ms: number }> {
  const before = process.cpuUsage();
  const out = await work();
  const used = process.cpuUsage(before);
  return { out, ms: (used.user + used.system) / 1000 };
}

/** Asks the Overview until it no longer says it is warming: the answers that said it, and the whole one. */
async function untilWhole(d: Dashboard): Promise<{ warming: number; body: any }> {
  let warming = 0;
  for (;;) {
    const s = await ask(d, 'summary?tz=UTC');
    expect(s.status).toBe(200);
    if (!s.body.warming) return { warming, body: s.body };
    warming++;
    await wait(200);
  }
}

describe('ten thousand runs, their totals not kept yet', () => {
  const RUNS = 10_000;
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'sl-budget-runs-'));
    dbPath = join(dir, 'shadowlap.db');
    const store = Store.open(dbPath);
    const now = Date.now();
    store.transaction(() => {
      for (let i = 0; i < RUNS; i++) {
        const startedAt = now - Math.floor((i / RUNS) * 12 * 86_400_000) - 60_000;
        const run = store.createRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: '/work' }, startedAt });
        for (let c = 1; c <= 20; c++) {
          const api = c % 2 === 1;
          const identity = { kind: api ? ('api' as const) : ('tool' as const), name: api ? 'POST /v1/messages' : 'lookup_order', fingerprint: `f${c}`, occurrence: 1 };
          store.appendCallStart({ runId: run.runId, callNo: c, ...identity, origin: 'live', effect: api ? null : 'read', requestRef: null, meta: api ? { provider: 'anthropic' } : {}, at: startedAt + c * 100 });
          store.appendCallEnd(identity, { runId: run.runId, callNo: c, attempt: 0, responseRef: null, outcome: 'ok', meta: api ? { status: 200, latencyMs: 900, model: 'claude-sonnet-4-5', usage: { inputTokens: 800, outputTokens: 60, cacheReadInputTokens: 400 } } : { latencyMs: 20 }, at: startedAt + c * 100 + 50 });
        }
        store.endRun(run.runId, 'completed', startedAt + 2500);
      }
    });
    store.close();
  }, TIMEOUT);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('answers the Overview at once with how far the totals are, and /api/meta in under 100 ms while they warm', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0 });
    try {
      const t0 = performance.now();
      const first = await ask(d, 'summary?tz=UTC');
      expect(first.status).toBe(200);
      // At once, with what is known: nothing yet, or the newest few.
      expect(first.body.warming).toMatchObject({ total: RUNS });
      expect(first.body.warming.done).toBeLessThan(RUNS);
      const { out, metas } = await metaBeside(d, () => untilWhole(d));
      const warmMs = performance.now() - t0;
      expect(first.ms, 'the first look at the Overview waited for the totals').toBeLessThan(Math.max(NEVER_WAITED_MS * 2, warmMs / 4));
      // The Overview was asked while the totals warmed, and meta beside it all along.
      expect(out.warming).toBeGreaterThan(2);
      expect(metas.length).toBeGreaterThan(10);
      metaHeld(metas, `while ${RUNS} runs' totals warmed`, warmMs, 1 / 4);
      // Then the whole of it, every run counted.
      expect(out.body.sums.week.runs + out.body.sums.lastWeek.runs).toBe(RUNS);
      // What was worked out beside the server is kept in the store, through its own connection.
      expect(store.query('SELECT COUNT(*) AS n FROM run_stats')[0]!.n).toBeGreaterThanOrEqual(RUNS - 100);
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);
});

describe('a run of twenty thousand calls', () => {
  const CALLS = 20_000;
  let dir: string;
  let dbPath: string;
  let big: RunRecord;
  let fork: RunRecord;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'sl-budget-calls-'));
    dbPath = join(dir, 'shadowlap.db');
    const store = Store.open(dbPath);
    const command = { argv: ['node', 'agent.js'], cwd: '/work' };
    big = store.createRun({ mode: 'record', command, startedAt: Date.now() - 86_400_000 });
    recordLoop(store, big, CALLS);
    // A fork that parts from it twenty calls before its end.
    fork = store.createRun({ mode: 'replay', parentRunId: big.runId, command, startedAt: Date.now() - 3_600_000 });
    recordLoop(store, fork, CALLS, { liveFrom: CALLS - 19 });
    store.setDivergence(fork.runId, { type: 'request_changed', callNo: CALLS - 19, kind: 'api', name: 'POST /v1/messages', replayedBefore: CALLS - 20 });
    // A dashboard opened on it before: the runs' totals are kept, so a dashboard started now has no
    // warm-up working beside the first page measured, only that page.
    const d = await startDashboard({ store, dbPath, port: 0 });
    await untilWhole(d);
    await d.close();
    store.close();
  }, TIMEOUT);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('works out its first page in under 500 ms of CPU', async () => {
    const cpu: number[] = [];
    for (let i = 0; i < 5; i++) {
      // A connection of its own, as a thread has: nothing of the run read on it yet.
      const reader = Store.openReadOnly(dbPath);
      try {
        const { out, ms } = await cpuOf(() => runJob(reader, { kind: 'run', runId: big.runId, read: {} }));
        expect(out.status).toBe(200);
        expect(JSON.parse(out.body)).toMatchObject({ callsTotal: CALLS, warming: { total: CALLS } });
        cpu.push(ms);
      } finally {
        reader.close();
      }
    }
    const ms = median(cpu);
    process.stdout.write(`a run of ${CALLS} calls, its first page: ${ms.toFixed(0)} ms of CPU (median; ${cpu.map((x) => x.toFixed(0)).join(', ')})\n`);
    expect(ms, `its first page took ${ms.toFixed(0)} ms of CPU (median)`).toBeLessThan(FIRST_PAGE_CPU_MS);
  }, TIMEOUT);

  it('answers its first page under 1 MB, and each next one on asking', async () => {
    const firsts: Array<{ ms: number; bytes: number }> = [];
    for (let i = 0; i < 3; i++) {
      const store = Store.open(dbPath);
      const d = await startDashboard({ store, dbPath, port: 0 });
      try {
        // As a browser finds it once the page has loaded: the threads started.
        await ask(d, 'meta');
        await wait(300);
        const first = await ask(d, `runs/${big.runId}`);
        expect(first.status).toBe(200);
        firsts.push({ ms: first.ms, bytes: first.bytes });
        expect(first.bytes, `the first page was ${first.bytes} bytes`).toBeLessThan(FIRST_PAGE_BYTES);
        expect(first.body.calls[0].callNo).toBe(1);
        expect(first.body).toMatchObject({ callsTotal: CALLS, summary: { total: CALLS } });
        // Every call's origin for the strip, before their pages come.
        expect(first.body.origins).toHaveLength(CALLS);
        if (i > 0) continue;
        // Answered from its first calls while the whole run is analysed beside the server.
        expect(first.body.warming).toMatchObject({ total: CALLS });
        const from = first.body.callsNext as number;
        const next = await ask(d, `runs/${big.runId}/calls?from=${from}&limit=500`);
        expect(next.status).toBe(200);
        expect(next.body.calls.map((c: { callNo: number }) => c.callNo)).toEqual(Array.from({ length: 500 }, (_, j) => from + j));
        expect(next.body).toMatchObject({ runId: big.runId, callsTotal: CALLS, callsNext: from + 500 });
        const last = await ask(d, `runs/${big.runId}/calls?from=${CALLS - 99}&limit=500`);
        expect(last.body.calls).toHaveLength(100);
        expect(last.body.callsNext).toBeNull();
        // Asked again once the whole run is analysed: the same first calls, every fact of the whole run's.
        let whole = first;
        for (let j = 0; j < 200 && whole.body.warming; j++) {
          await wait(200);
          whole = await ask(d, `runs/${big.runId}`);
        }
        expect(whole.body.warming).toBeUndefined();
        expect(whole.body.calls.slice(0, first.body.calls.length)).toEqual(first.body.calls);
        // The same summary; its costs to the ninth decimal (priced per model first, per call after).
        const cents = (sum: { cost: Record<string, unknown> }) => ({ ...sum, cost: Object.fromEntries(Object.entries(sum.cost).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1e9) / 1e9 : v])) });
        expect(cents(whole.body.summary)).toEqual(cents(first.body.summary));
      } finally {
        await d.close();
        store.close();
      }
    }
    // The time a browser waits for it, on this machine as busy as it is: said, not judged.
    const ms = median(firsts.map((f) => f.ms));
    process.stdout.write(`a run of ${CALLS} calls, its first page over HTTP: median ${ms.toFixed(0)} ms (${firsts.map((f) => f.ms.toFixed(0)).join(', ')}), ${(firsts[0]!.bytes / 1024).toFixed(0)} KB\n`);
  }, TIMEOUT);

  it('compares two of them without holding up any other request', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0 });
    try {
      await ask(d, 'meta');
      await wait(300);
      const { out, metas } = await metaBeside(d, () => ask(d, `compare?a=${big.runId}&b=${fork.runId}`));
      expect(out.status).toBe(200);
      expect(out.body).toMatchObject({ a: { runId: big.runId, calls: CALLS }, b: { runId: fork.runId, calls: CALLS } });
      expect(out.body.identicalPrefix).toBeGreaterThan(CALLS / 2);
      process.stdout.write(`comparing two runs of ${CALLS} calls took ${out.ms.toFixed(0)} ms\n`);
      expect(metas.length).toBeGreaterThan(3);
      metaHeld(metas, 'while two long runs were compared', out.ms, 1 / 2);
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);
});
