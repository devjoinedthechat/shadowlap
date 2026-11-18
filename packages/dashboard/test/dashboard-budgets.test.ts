import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectHost, ProjectRegistry, recordBlame, Store, storeApiRequest, type RunRecord } from '@shadowlap/engine';
import { blameReport, EXPECT } from '../../engine/test/fix-fixtures.js';
import type { ProjectConfig } from '../src/context.js';
import { startDashboard, type Dashboard } from '../src/index.js';
import { runJob } from '../src/read-jobs.js';
import { recordLoop } from './long-run.js';

/**
 * The dashboard's own thread answers every request, while what reads every call of a run, or of
 * every run, is worked out on threads beside it (read-pool.ts), the search index is brought up to
 * date on a thread of its own (search-index.ts), and a long run comes a page at a time. The budgets
 * hold on a machine busy with other work, as the ones they were written on were: each is held
 * against the server's thread itself, how long its event loop was held up and how much of the time
 * it was busy (`onServerThread`), or against the order answers came in, never against a time a
 * browser waits, which a busy machine stretches with work of its own. The times waited are printed.
 *
 * - With 10,000 runs whose totals no dashboard has kept and whose recordings it never indexed,
 *   /api/summary answers at once with how far the warm-up has got; all the while the totals warm and
 *   the search index catches up, the server's event loop is held up under 60 ms at the 99th
 *   percentile, and it is busy under half the time, the test's own asking among it.
 * - While a run records into that store, the status bar's poll of /api/meta costs its thread a few
 *   milliseconds: the run index counts the new calls into what it had (82 ms a poll, before).
 * - Settings → Tools, which reads every tool call in that store, and the project switcher, the
 *   setup and Training, which read every run of it, cost the server's thread a few milliseconds: the
 *   store is read beside it.
 * - A run of 20,000 calls answers its first page under 1 MB, where it sent every call at once
 *   (15 MB), worked out in under 500 ms of CPU read through a connection of its own, as a thread
 *   reads it (the median of five); its other pages come from /calls?from=.
 * - Scrolling deep into it while the whole run is analysed: the page at #10,000 and a call's details
 *   there come before the whole analysis does, from the calls around them.
 * - Comparing it with its fork shows the identical prefix and the first difference before the whole
 *   comparison comes, and holds the server's thread up no more than any other read.
 * - Its Provenance, its untrusted reads and the page of the fix that blamed it, each of which
 *   reads every call of the run, cost the server's thread a few
 *   milliseconds each, a small share of the time each takes (`beside`).
 */

const TIMEOUT = 300_000;
const FIRST_PAGE_CPU_MS = 500;
const FIRST_PAGE_BYTES = 1024 * 1024;
/** How long the server's event loop may be held up at the 99th percentile while long work runs beside it. */
const HELD_P99_MS = 60;
/**
 * The share of the time the server's thread may be busy while that work runs beside it, this test's
 * own asking and reading of the answers among it (it runs on the same thread): the search index alone
 * took 70% of it on the server's thread, in 50 ms slices every 20 ms.
 */
const BUSY_SHARE = 1 / 2;
/**
 * What one status-bar poll may cost the server's thread (median): a few milliseconds for the runs
 * written since the last poll, where a read of every run took 80. Coverage counts every block it runs,
 * so there the bar is 30, still well under a read of every run.
 */
const POLL_MS = process.env.SHADOWLAP_TEST_COVERAGE ? 30 : 10;

/**
 * What a request worked out beside the server may cost its thread: under half the time the request
 * took. Worked out on the thread, a read of every call or every run takes all of it; beside it, the
 * thread moves the answer through its sockets, which a busy machine stretches as it stretches the
 * rest (a fix's page of 20,000 calls, 2 MB: 17 ms of 240 here, 62 ms under the whole suite).
 */
/**
 * Beside the server: its thread busy under half the time, or, for a read that answers in a few ms
 * (where the work each request does on the thread is most of it, and the share is noise), under
 * 10 ms of it, the /api/meta poll's own bound.
 */
const beside = (path: string, t: { busyMs: number; busy: number }) => expect(t.busy < BUSY_SHARE || t.busyMs < 10, `${path}: the server's thread was busy ${t.busyMs.toFixed(0)} ms, ${(t.busy * 100).toFixed(0)}% of the time`).toBe(true);

async function ask(d: Dashboard, path: string): Promise<{ status: number; ms: number; bytes: number; body: any }> {
  const t0 = performance.now();
  const res = await fetch(`${d.url}/api/${path}`, { headers: { 'x-shadowlap-token': d.token } });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - t0, bytes: Buffer.byteLength(text), body: text ? JSON.parse(text) : null };
}

/** A write, as the page sends one. */
async function send(d: Dashboard, path: string, method: 'POST' | 'DELETE', body?: unknown): Promise<{ status: number; ms: number; body: any }> {
  const t0 = performance.now();
  const res = await fetch(`${d.url}/api/${path}`, { method, headers: { 'x-shadowlap-token': d.token, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - t0, body: text ? JSON.parse(text) : null };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * The server's thread while `work` runs (the dashboard runs on this one): how late its event loop
 * ran its timers (the 99th percentile and the most, in ms), and how long and how much of the time it
 * was busy. A request answered beside the server leaves it idle; one worked out on it holds it.
 */
async function onServerThread<T>(work: () => Promise<T>): Promise<{ out: T; p99: number; max: number; busyMs: number; busy: number; ms: number }> {
  const held = monitorEventLoopDelay({ resolution: 5 });
  held.enable();
  const before = performance.eventLoopUtilization();
  const t0 = performance.now();
  try {
    const out = await work();
    const used = performance.eventLoopUtilization(before);
    return { out, p99: held.percentile(99) / 1e6, max: held.max / 1e6, busyMs: used.active, busy: used.utilization, ms: performance.now() - t0 };
  } finally {
    held.disable();
  }
}

const said = (what: string, t: { p99: number; max: number; busyMs: number; busy: number; ms: number }) =>
  process.stdout.write(`${what} (${(t.ms / 1000).toFixed(1)} s): the server's thread held up ${t.p99.toFixed(0)} ms at the 99th percentile, ${t.max.toFixed(0)} ms at most, busy ${t.busyMs.toFixed(0)} ms (${(t.busy * 100).toFixed(0)}%)\n`);

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

/** Asks a search until the index has every run: how many searches it took. */
async function untilIndexed(d: Dashboard): Promise<number> {
  for (let n = 1; ; n++) {
    const s = await ask(d, 'search?q=refund&limit=5');
    expect(s.status).toBe(200);
    if (!s.body.indexing) return n;
    await wait(250);
  }
}

describe('ten thousand runs, their totals not kept yet, their recordings never indexed', () => {
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
          // What the user asked, and what the order lookup said: text for the about line and the search index.
          const requestRef = c === 1 ? storeApiRequest(store, { model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: `Refund order A-${10_000 + i}: it arrived damaged, ticket T-${i}.` }] }) : c === 2 ? store.putJson({ args: { order: `A-${10_000 + i}` } }) : null;
          const responseRef = c === 2 ? store.putJson({ result: { order: `A-${10_000 + i}`, status: 'delivered', note: `damaged on arrival, ticket T-${i}` } }) : null;
          store.appendCallStart({ runId: run.runId, callNo: c, ...identity, origin: 'live', effect: api ? null : 'read', requestRef, meta: api ? { provider: 'anthropic' } : {}, at: startedAt + c * 100 });
          store.appendCallEnd(identity, { runId: run.runId, callNo: c, attempt: 0, responseRef, outcome: 'ok', meta: api ? { status: 200, latencyMs: 900, model: 'claude-sonnet-4-5', usage: { inputTokens: 800, outputTokens: 60, cacheReadInputTokens: 400 } } : { latencyMs: 20 }, at: startedAt + c * 100 + 50 });
        }
        store.endRun(run.runId, 'completed', startedAt + 2500);
      }
    });
    store.close();
  }, TIMEOUT);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('answers the Overview at once, and holds the server’s thread free while the totals warm and the search index catches up', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0 });
    try {
      const first = await ask(d, 'summary?tz=UTC');
      expect(first.status).toBe(200);
      // At once, with what is known: nothing yet, or the newest few.
      expect(first.body.warming).toMatchObject({ total: RUNS });
      expect(first.body.warming.done).toBeLessThan(RUNS);
      const t = await onServerThread(() => metaBeside(d, async () => ({ whole: await untilWhole(d), searches: await untilIndexed(d) })));
      const { whole, searches } = t.out.out;
      const metas = t.out.metas;
      said(`${RUNS} runs' totals warmed and their recordings indexed, ${metas.length} answers of /api/meta beside it (median ${median(metas).toFixed(0)} ms, the slowest ${Math.max(...metas).toFixed(0)} ms)`, t);
      // The Overview was asked while the totals warmed, the search while the index caught up, and meta beside it all along.
      expect(whole.warming).toBeGreaterThan(2);
      expect(searches).toBeGreaterThan(1);
      expect(metas.length).toBeGreaterThan(10);
      expect(t.p99, 'the server’s event loop, 99th percentile').toBeLessThan(HELD_P99_MS);
      expect(t.busy, 'the share of the time the server’s thread was busy').toBeLessThan(BUSY_SHARE);
      // Then the whole of it, every run counted, and found.
      expect(whole.body.sums.week.runs + whole.body.sums.lastWeek.runs).toBe(RUNS);
      expect((await ask(d, 'search?q=T-9999&limit=5')).body.hits.map((h: { field: string }) => h.field)).toEqual(expect.arrayContaining(['prompt']));
      // What was worked out beside the server is kept in the store, through its own connection, every
      // run's totals: what waited while the search index held the store is written once it let go
      // (keeper.ts), so this waits for that, however long the machine's load makes it.
      const kept = () => Number(store.query('SELECT COUNT(*) AS n FROM run_stats')[0].n);
      while (kept() < RUNS) await wait(100);
      expect(kept()).toBe(RUNS);
      expect(store.query('SELECT COUNT(*) AS n FROM search_state')[0].n).toBe(RUNS);
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);

  it('keeps the status bar’s poll a few milliseconds of the server’s thread while a session writes runs, and labels them', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0 });
    // A session in a thread of its own, as a test session or a verify writes from another process:
    // a run started, a call, the run ended, then a label on the run before it, every 50 ms.
    const script = join(dir, 'session.mjs');
    writeFileSync(
      script,
      [
        `import { parentPort, workerData } from 'node:worker_threads';`,
        `import { Store } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../engine/dist/index.js')).href)};`,
        'const store = Store.open(workerData.dbPath);',
        'let n = 0, last = null;',
        'const t = setInterval(() => {',
        "  const run = store.createRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: '/work' }, startedAt: Date.now() });",
        "  const identity = { kind: 'tool', name: 'lookup_order', fingerprint: 's' + n, occurrence: 1 };",
        "  store.appendCallStart({ runId: run.runId, callNo: 1, ...identity, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: Date.now() });",
        "  store.appendCallEnd(identity, { runId: run.runId, callNo: 1, attempt: 0, responseRef: null, outcome: 'ok', meta: { latencyMs: 1 }, at: Date.now() });",
        "  store.endRun(run.runId, 'completed', Date.now());",
        "  if (last) store.updateRunMeta(last, { labels: ['session'] });",
        '  last = run.runId;',
        "  if (++n === workerData.runs) { clearInterval(t); store.close(); parentPort.postMessage(n); }",
        '}, 50);',
      ].join('\n'),
    );
    try {
      await ask(d, 'meta');
      await untilWhole(d);
      const runsBefore = Number((await ask(d, 'meta')).body.counts.runs);
      const RUNS_WRITTEN = 40;
      const session = new Worker(script, { workerData: { dbPath, runs: RUNS_WRITTEN } });
      const written = new Promise<number>((resolve, reject) => {
        session.once('message', resolve);
        session.once('error', reject);
      });
      const busy: number[] = [];
      let done = false;
      void written.then(() => (done = true));
      const t = await onServerThread(async () => {
        while (!done) {
          const before = performance.eventLoopUtilization();
          expect((await ask(d, 'meta')).status).toBe(200);
          busy.push(performance.eventLoopUtilization(before).active);
          await wait(20);
        }
        return written;
      });
      expect(t.out).toBe(RUNS_WRITTEN);
      said(`/api/meta while a session wrote ${RUNS_WRITTEN} runs into ${RUNS} runs: ${busy.length} polls, each costing the server's thread ${median(busy).toFixed(1)} ms (median)`, t);
      // Each poll took in the runs written since: a few milliseconds, not a read of every run (80 ms here, 137 in the review).
      expect(busy.length).toBeGreaterThan(10);
      expect(median(busy), 'what a poll costs the server’s thread (median)').toBeLessThan(POLL_MS);
      expect((await ask(d, 'meta')).body.counts.runs).toBe(runsBefore + RUNS_WRITTEN);
      await session.terminate();
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);

  it('keeps the status bar’s poll a few milliseconds of the server’s thread while a run records', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0 });
    // A recording in a thread of its own, as the sidecar writes one from another process: a call every 50 ms.
    const script = join(dir, 'recorder.mjs');
    writeFileSync(
      script,
      [
        `import { parentPort, workerData } from 'node:worker_threads';`,
        `import { Store } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../engine/dist/index.js')).href)};`,
        'const store = Store.open(workerData.dbPath);',
        "const run = store.createRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: '/work' }, startedAt: Date.now() });",
        'let n = 0;',
        'const t = setInterval(() => {',
        "  const identity = { kind: 'tool', name: 'lookup_order', fingerprint: 'r' + ++n, occurrence: 1 };",
        "  store.appendCallStart({ runId: run.runId, callNo: n, ...identity, origin: 'live', effect: 'read', requestRef: null, meta: {}, at: Date.now() });",
        "  store.appendCallEnd(identity, { runId: run.runId, callNo: n, attempt: 0, responseRef: null, outcome: 'ok', meta: { latencyMs: 1 }, at: Date.now() });",
        "  if (n === workerData.calls) { clearInterval(t); store.endRun(run.runId, 'completed', Date.now()); store.close(); parentPort.postMessage(n); }",
        '}, 50);',
      ].join('\n'),
    );
    try {
      // As a browser finds it: the threads started, the run index read, the totals kept by the test before.
      await ask(d, 'meta');
      await untilWhole(d);
      // The runs before it: those the tests before this one wrote into the store too.
      const runsBefore = Number((await ask(d, 'meta')).body.counts.runs);
      const CALLS = 60;
      const recorder = new Worker(script, { workerData: { dbPath, calls: CALLS } });
      const recorded = new Promise<number>((resolve, reject) => {
        recorder.once('message', resolve);
        recorder.once('error', reject);
      });
      const metas: number[] = [];
      const busy: number[] = [];
      const t = await onServerThread(async () => {
        let done = false;
        void recorded.then(() => (done = true));
        while (!done) {
          const before = performance.eventLoopUtilization();
          const m = await ask(d, 'meta');
          busy.push(performance.eventLoopUtilization(before).active);
          metas.push(m.ms);
          await wait(20);
        }
        return recorded;
      });
      expect(t.out).toBe(CALLS);
      said(`/api/meta while a run made ${CALLS} calls into ${RUNS} runs: ${metas.length} polls, median ${median(metas).toFixed(1)} ms, each costing the server's thread ${median(busy).toFixed(1)} ms (median)`, t);
      // Every poll saw the recording grow, and each cost a few milliseconds of the thread, not a read of every run.
      expect(metas.length).toBeGreaterThan(20);
      expect(median(busy), 'what a poll costs the server’s thread (median)').toBeLessThan(POLL_MS);
      expect(t.p99, 'the server’s event loop, 99th percentile').toBeLessThan(HELD_P99_MS);
      expect((await ask(d, 'meta')).body.counts.runs).toBe(runsBefore + 1);
      await recorder.terminate();
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);

  it('lists the projects, and shows the setup, Training, Fixes and Not covered, from what the store says read beside the server', async () => {
    // A dashboard over projects, as `shadowlap dashboard` serves them, this store the current one's.
    const home = mkdtempSync(join(tmpdir(), 'sl-budget-home-'));
    const folder = join(home, 'support-agent');
    mkdirSync(folder);
    const registry = new ProjectRegistry({ home, env: { SHADOWLAP_HOME: join(home, '.sl') }, actor: () => null });
    const host = ProjectHost.open<ProjectConfig>(folder, { registry, loadConfig: () => ({ normalize: [], redact: [] }), dbPath });
    const d = await startDashboard({ projects: host });
    try {
      await ask(d, 'meta');
      await untilWhole(d);
      for (const path of ['projects', 'setup', 'training', 'fixes', 'coverage']) {
        // Asked once before, so what is measured is an answer, not the thread's first look at the project list and the folders.
        expect((await ask(d, path)).status, path).toBe(200);
        const t = await onServerThread(() => ask(d, path));
        said(`${path} answered in ${t.out.ms.toFixed(0)} ms`, t);
        expect(t.out.status, path).toBe(200);
        // Each reads every run of the store (to count them, list its recordings or its fixes, find its pairs, or count the imported runs no coverage scan has read): none of it on the server's thread.
        beside(path, t);
      }
      // Every run counted: the recording an earlier test made in the store among them, when it ran.
      const current = (await ask(d, 'projects')).body.current;
      expect(current.name).toBe('support-agent');
      expect(current.runs).toBeGreaterThanOrEqual(RUNS);
    } finally {
      await d.close();
      host.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, TIMEOUT);

  it('reads Settings → Tools, a scan of every call in the store, beside the server', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0, project: { path: dir } });
    try {
      await ask(d, 'meta');
      await untilWhole(d);
      const t = await onServerThread(() => ask(d, 'settings/tools'));
      said(`settings/tools answered in ${t.out.ms.toFixed(0)} ms`, t);
      expect(t.out.status).toBe(200);
      expect(t.out.body.live.map((tool: { name: string }) => tool.name)).toEqual(['lookup_order']);
      // Every tool call of every run, and the MCP servers they came through: none of it read on the server's thread.
      beside('settings/tools', t);
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);

  // Last: it deletes runs the others count.
  it('deletes fifty runs beside the server, with their calls and what nothing else uses', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0, readOnly: false });
    try {
      await ask(d, 'meta');
      const ids = ((await ask(d, 'runs/page?limit=50')).body.runs as Array<{ runId: string }>).map((r) => r.runId);
      expect(ids).toHaveLength(50);
      const t = await onServerThread(() => send(d, 'runs/delete', 'POST', { ids }));
      said(`50 runs deleted in ${t.out.ms.toFixed(0)} ms`, t);
      expect(t.out.status).toBe(200);
      expect(t.out.body.done).toHaveLength(50);
      // Every call of each, its search index and the data nothing else used: none of it on the server's thread.
      beside('runs/delete', t);
      expect((await ask(d, `runs/${ids[0]}`)).status).toBe(404);
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
  let fixId: string;

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
    // A blame of the long run, whose fix's page reads every call of it.
    fixId = recordBlame(store, { runId: big.runId, report: blameReport(big.runId), expect: EXPECT, scope: null, command: 'shadowlap blame x', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' }).fix.fixId;
    // A dashboard opened on it before: the runs' totals are kept and their recordings indexed, so a
    // dashboard started now has no warm-up working beside what is measured, only that.
    const d = await startDashboard({ store, dbPath, port: 0 });
    await untilWhole(d);
    await untilIndexed(d);
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
    process.stdout.write(`a run of ${CALLS} calls, its first page over HTTP: median ${ms.toFixed(0)} ms (${firsts.map((f) => f.ms.toFixed(0)).join(', ')}), ${(firsts[0].bytes / 1024).toFixed(0)} KB\n`);
  }, TIMEOUT);

  it('answers a page deep in it, and a call there, while the whole run is analysed: before the analysis does', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0 });
    try {
      await ask(d, 'meta');
      await wait(300);
      // The first page sets the whole run's analysis going on the run's thread; then a scroll deep
      // into it, and what asks for every fact, which waits for that analysis.
      expect((await ask(d, `runs/${big.runId}`)).body.warming).toMatchObject({ total: CALLS });
      const order: string[] = [];
      const t = await onServerThread(() =>
        Promise.all([
          ask(d, `runs/${big.runId}/calls?from=10000&limit=500`).then((a) => (order.push('page'), a)),
          ask(d, `runs/${big.runId}/calls/10006`).then((a) => (order.push('call'), a)),
          ask(d, `runs/${big.runId}/calls?from=10000&limit=500&whole=1`).then((a) => (order.push('whole'), a)),
        ]),
      );
      const [page, call, whole] = t.out;
      said(`a page at #10,000 of ${CALLS} calls in ${page.ms.toFixed(0)} ms and a call there in ${call.ms.toFixed(0)} ms, the whole analysis's in ${whole.ms.toFixed(0)} ms`, t);
      // From the calls around them, at once; the same calls with every fact once the run is analysed.
      expect(page.body).toMatchObject({ around: { from: 9800 }, callsNext: 10500 });
      expect(call.body.around).toBeDefined();
      expect(whole.body.around).toBeUndefined();
      expect(order.slice(0, 2).sort()).toEqual(['call', 'page']);
      expect(order[2]).toBe('whole');
      expect(page.body.calls.map((c: { callNo: number }) => c.callNo)).toEqual(whole.body.calls.map((c: { callNo: number }) => c.callNo));
      expect(t.p99, 'the server’s event loop, 99th percentile').toBeLessThan(HELD_P99_MS);
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);

  it('compares it with its fork showing where they part first, without holding up the server’s thread', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0 });
    try {
      await ask(d, 'meta');
      await wait(300);
      const order: string[] = [];
      const t = await onServerThread(() =>
        metaBeside(d, () =>
          Promise.all([
            ask(d, `compare?a=${big.runId}&b=${fork.runId}&part=head`).then((a) => (order.push('head'), a)),
            ask(d, `compare?a=${big.runId}&b=${fork.runId}`).then((a) => (order.push('whole'), a)),
          ]),
        ),
      );
      const [[head, whole], metas] = [t.out.out, t.out.metas];
      said(`the head of comparing two runs of ${CALLS} calls in ${head.ms.toFixed(0)} ms, the whole in ${whole.ms.toFixed(0)} ms, /api/meta beside it in ${median(metas).toFixed(0)} ms (median)`, t);
      expect(whole.status).toBe(200);
      expect(whole.body).toMatchObject({ a: { runId: big.runId, calls: CALLS }, b: { runId: fork.runId, calls: CALLS } });
      expect(whole.body.identicalPrefix).toBeGreaterThan(CALLS / 2);
      // Where they part, first, as the whole comparison has it.
      expect(order).toEqual(['head', 'whole']);
      expect(head.body).toMatchObject({ identicalPrefix: whole.body.identicalPrefix, firstRequestDifference: { callNo: whole.body.firstRequestDifference.callNo } });
      expect(metas.length).toBeGreaterThan(3);
      expect(t.p99, 'the server’s event loop, 99th percentile').toBeLessThan(HELD_P99_MS);
      expect(t.busy, 'the share of the time the server’s thread was busy').toBeLessThan(BUSY_SHARE);
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);

  it('reads its Provenance, its untrusted reads and the fix that blamed it beside the server', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0 });
    try {
      await ask(d, 'meta');
      await wait(300);
      for (const path of [`runs/${big.runId}/provenance`, `injection/runs/${big.runId}`, `fixes/${fixId}`]) {
        const t = await onServerThread(() => ask(d, path));
        said(`${path.replace(big.runId, '<run>')} answered in ${t.out.ms.toFixed(0)} ms`, t);
        expect(t.out.status, path).toBe(200);
        // Each reads every call of the run, or of every run: none of it on the server's thread.
        beside(path, t);
      }
      expect((await ask(d, `runs/${big.runId}/provenance`)).body).toMatchObject({ runId: big.runId, calls: { model: CALLS / 2, tool: CALLS / 2 } });
      expect((await ask(d, `fixes/${fixId}`)).body.blame.callRow).toHaveLength(CALLS);
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);

  it('works out what its fork menu, its Run blame and its fix’s buttons would bill beside the server', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0 });
    try {
      await ask(d, 'meta');
      await wait(300);
      for (const path of [`runs/${big.runId}/estimates?at=${CALLS - 1}`, `fixes/${fixId}/estimates`]) {
        const t = await onServerThread(() => ask(d, path));
        said(`${path.replace(big.runId, '<run>')} answered in ${t.out.ms.toFixed(0)} ms`, t);
        expect(t.out.status, path).toBe(200);
        // Each prices the run from every call of it: none of it on the server's thread.
        beside(path, t);
      }
      expect((await ask(d, `runs/${big.runId}/estimates?at=${CALLS - 1}`)).body).toMatchObject({ blame: { kind: 'blame' }, actions: expect.any(Object) });
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);

  // Last: it deletes the fork the others compare.
  it('deletes its fork of twenty thousand calls beside the server', async () => {
    const store = Store.open(dbPath);
    const d = await startDashboard({ store, dbPath, port: 0, readOnly: false });
    try {
      await ask(d, 'meta');
      const t = await onServerThread(() => send(d, `runs/${fork.runId}`, 'DELETE'));
      said(`a run of ${CALLS} calls deleted in ${t.out.ms.toFixed(0)} ms`, t);
      expect(t.out.status).toBe(200);
      expect(t.out.body.deleted).toBe(fork.runId);
      beside(`runs/<fork> DELETE`, t);
      expect((await ask(d, `runs/${fork.runId}`)).status).toBe(404);
      expect((await ask(d, `runs/${big.runId}`)).status).toBe(200);
    } finally {
      await d.close();
      store.close();
    }
  }, TIMEOUT);
});
