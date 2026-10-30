import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunRecord } from '@shadowlap/engine';
import { runJob, type ReadJob } from '../src/read-jobs.js';
import { READ_LIMITS, ReadPool } from '../src/read-pool.js';
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
    const summary = JSON.parse((await pool.run({ kind: 'summary', work: { tz: 'UTC', now: NOW, goldens: [], team: null, project: null } })).body);
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

  it('answers a page or a call of a run the run’s thread is analysing on a free thread, and only what asks for the whole analysis waits for it', async () => {
    // Threads that answer at once with which thread they are, but take 1.5 s over a run's whole
    // analysis, which the run's first page asks for when it is answered from its first calls.
    const script = join(dir, 'slow-analysis.mjs');
    writeFileSync(
      script,
      [
        "import { parentPort, threadId } from 'node:worker_threads';",
        "parentPort.postMessage({ type: 'ready' });",
        'let analysed = 0;',
        'parentPort.on(\'message\', (m) => {',
        "  if (m.type === 'close') return parentPort.postMessage({ type: 'closed' });",
        '  const answer = (extra = {}) => parentPort.postMessage({ type: \'answer\', id: m.id, answer: { status: 200, body: JSON.stringify({ kind: m.job.kind, whole: !!m.job.whole, thread: threadId, analysed }), etag: null, ...extra } });',
        "  if (m.job.kind === 'warm') return answer({ warm: { done: true, walked: 0, total: 0 } });",
        "  if (m.job.kind === 'analyse') return setTimeout(() => (analysed++, answer()), 1500);",
        // Once a thread has analysed the run, it answers from the analysis: whole, nothing to follow.
        "  if ((m.job.kind === 'run' || m.job.kind === 'calls') && !analysed) return answer({ warming: true, then: { kind: 'analyse', runId: m.job.runId } });",
        '  answer();',
        '});',
      ].join('\n'),
    );
    const slow = new ReadPool({ dbPath, keep: { stats: () => undefined, asks: () => undefined }, size: 2, script: pathToFileURL(script) });
    const said = (a: { body: string }) => JSON.parse(a.body) as { kind: string; whole: boolean; thread: number; analysed: number };
    try {
      const first = said(await slow.run({ kind: 'run', runId: 'R', read: {} }, { affinity: 'R' }));
      // The run's thread takes up its analysis once it is free.
      await new Promise((r) => setTimeout(r, 150));
      const t0 = performance.now();
      const at = <T,>(p: Promise<T>) => p.then((v) => ({ v, ms: performance.now() - t0 }));
      const [page, call, again, whole] = await Promise.all([
        at(slow.run({ kind: 'calls', runId: 'R', read: {}, from: 15_001, limit: 500 }, { affinity: 'R' })),
        at(slow.run({ kind: 'call', runId: 'R', read: {}, callNo: 15_002 }, { affinity: 'R' })),
        at(slow.run({ kind: 'run', runId: 'R', read: {} }, { affinity: 'R' })),
        at(slow.run({ kind: 'calls', runId: 'R', read: {}, from: 15_001, limit: 500, whole: true }, { affinity: 'R' })),
      ]);
      // A page, a call and the run's first page: answered at once, by the other thread.
      for (const x of [page, call, again]) {
        expect(said(x.v).thread).not.toBe(first.thread);
        expect(x.ms).toBeLessThan(whole.ms - 500);
      }
      // What asks for the whole analysis waited for it, on the run's thread, which keeps the run.
      expect(said(whole.v)).toMatchObject({ whole: true, thread: first.thread, analysed: 1 });
      const after = said(await slow.run({ kind: 'calls', runId: 'R', read: {}, from: 1, limit: 500 }, { affinity: 'R' }));
      expect(after.thread).toBe(first.thread);
      // The other thread took up no analysis of the run for the answers it lent: the run's thread had it.
      await new Promise((r) => setTimeout(r, 1800));
      const each = (await Promise.all([slow.run({ kind: 'recent', read: {} }), slow.run({ kind: 'recent', read: {} })])).map(said);
      expect(new Set(each.map((x) => x.thread)).size).toBe(2);
      for (const x of each) expect(x.analysed, `thread ${x.thread}`).toBe(x.thread === first.thread ? 1 : 0);
    } finally {
      await slow.close();
    }
  });

  it('takes a request waiting behind a long one on the free thread, and does what can wait only while another thread stays free', async () => {
    // Threads that answer at once with which thread they are, but take 2 s over a comparison and 3 s
    // over a run's whole analysis, which a run's first page asks for.
    const script = join(dir, 'long-jobs.mjs');
    writeFileSync(
      script,
      [
        "import { parentPort, threadId } from 'node:worker_threads';",
        "parentPort.postMessage({ type: 'ready' });",
        'parentPort.on(\'message\', (m) => {',
        "  if (m.type === 'close') return parentPort.postMessage({ type: 'closed' });",
        '  const answer = (extra = {}) => parentPort.postMessage({ type: \'answer\', id: m.id, answer: { status: 200, body: JSON.stringify({ kind: m.job.kind, thread: threadId }), etag: null, ...extra } });',
        "  if (m.job.kind === 'warm') return answer({ warm: { done: true, walked: 0, total: 0 } });",
        "  if (m.job.kind === 'compare') return setTimeout(() => answer(), 2000);",
        "  if (m.job.kind === 'analyse') return setTimeout(() => answer(), 3000);",
        "  if (m.job.kind === 'run') return answer({ warming: true, then: { kind: 'analyse', runId: m.job.runId } });",
        '  answer();',
        '});',
      ].join('\n'),
    );
    const two = new ReadPool({ dbPath, keep: { stats: () => undefined, asks: () => undefined }, size: 2, script: pathToFileURL(script) });
    const said = (a: { body: string }) => JSON.parse(a.body) as { kind: string; thread: number };
    // The order answers came in: what is measured is which came first, never how long each took.
    const order: string[] = [];
    const noted = (name: string, p: Promise<{ body: string }>) => p.then((a) => (order.push(name), said(a)));
    try {
      // Once the warm-up is through, both threads are free: a thread reads run S, then takes a long comparison, the first free one both times.
      for (let i = 0; i < 400 && !two.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      const s = said(await two.run({ kind: 'calls', runId: 'S', read: {}, from: 1, limit: 500 }, { affinity: 'S' }));
      const compare = noted('compare', two.run({ kind: 'compare', a: 'X', b: 'Y', cwd: null }));
      // S's page again, which goes to the thread that read S last, busy comparing: the free thread
      // takes it once it has waited a moment, rather than for the comparison.
      const page = noted('page', two.run({ kind: 'calls', runId: 'S', read: {}, from: 1, limit: 500 }, { affinity: 'S' }));
      // Meanwhile the free thread answers run R's first page, whose whole analysis waits for the other
      // thread to be free too: what is asked after it is answered at once.
      const first = await noted('first', two.run({ kind: 'run', runId: 'R', read: {} }, { affinity: 'R' }));
      const recent = noted('recent', two.run({ kind: 'recent', read: {} }));
      const [c, p, r] = await Promise.all([compare, page, recent]);
      expect(c.thread).toBe(s.thread);
      expect(p.thread).not.toBe(s.thread);
      expect(r.thread).toBe(first.thread);
      // Both before the comparison ended: neither waited for it, nor for the analysis.
      expect(order.indexOf('page')).toBeLessThan(order.indexOf('compare'));
      expect(order.indexOf('recent')).toBeLessThan(order.indexOf('compare'));
      // Once both are free, the analysis R's first page asked for is done: a page that asks for the whole of it is answered from it.
      const whole = said(await two.run({ kind: 'calls', runId: 'R', read: {}, from: 1, limit: 500, whole: true }, { affinity: 'R' }));
      expect(whole.thread).toBe(first.thread);
    } finally {
      await two.close();
    }
  }, 30_000);

  /** A pool of threads that answer each kind of job after the time `slow` gives it, at once otherwise, saying which thread they are. */
  function timedPool(slow: Record<string, number>, name: string): { pool: ReadPool; said: (a: { body: string }) => { kind: string; thread: number } } {
    const script = join(dir, `${name}.mjs`);
    writeFileSync(
      script,
      [
        "import { parentPort, threadId } from 'node:worker_threads';",
        `const slow = ${JSON.stringify(slow)};`,
        "parentPort.postMessage({ type: 'ready' });",
        'parentPort.on(\'message\', (m) => {',
        "  if (m.type === 'close') return parentPort.postMessage({ type: 'closed' });",
        '  const answer = (extra = {}) => parentPort.postMessage({ type: \'answer\', id: m.id, answer: { status: 200, body: JSON.stringify({ kind: m.job.kind, thread: threadId }), etag: null, ...extra } });',
        "  if (m.job.kind === 'warm') return answer({ warm: { done: true, walked: 0, total: 0 } });",
        "  if (m.job.kind === 'run') return answer({ warming: true, then: { kind: 'analyse', runId: m.job.runId } });",
        '  if (slow[m.job.kind]) return setTimeout(() => answer(), slow[m.job.kind]);',
        '  answer();',
        '});',
      ].join('\n'),
    );
    const timed = new ReadPool({ dbPath, keep: { stats: () => undefined, asks: () => undefined }, size: 2, script: pathToFileURL(script) });
    return { pool: timed, said: (a) => JSON.parse(a.body) as { kind: string; thread: number } };
  }

  it('answers on a spare thread what comes while what can wait holds one thread and a request the other, and ends it after', async () => {
    const { pool: two, said } = timedPool({ analyse: 3000, compare: 2000 }, 'spare-jobs');
    const idle = READ_LIMITS.spareIdleMs;
    READ_LIMITS.spareIdleMs = 50;
    const order: string[] = [];
    const noted = (name: string, p: Promise<{ body: string }>) => p.then((a) => (order.push(name), said(a)));
    try {
      for (let i = 0; i < 400 && !two.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      // A long run's first page, answered from its first calls: its whole analysis starts beside, both threads being free.
      const first = said(await two.run({ kind: 'run', runId: 'R', read: {} }, { affinity: 'R' }));
      // A whole Compare takes the other thread.
      const compare = noted('compare', two.run({ kind: 'compare', a: 'X', b: 'Y', cwd: null }));
      // What comes behind both is answered on a third thread, before either ends.
      const recent = await noted('recent', two.run({ kind: 'recent', read: {} }));
      const c = await compare;
      expect(new Set([first.thread, c.thread, recent.thread]).size).toBe(3);
      expect(order).toEqual(['recent', 'compare']);
      // Once nothing can wait any more and it has had nothing to do, the third thread ends.
      const slots = () => (two as unknown as { slots: unknown[] }).slots.length;
      expect(slots()).toBe(3);
      for (let i = 0; i < 400 && slots() > 2; i++) await new Promise((r) => setTimeout(r, 25));
      expect(slots()).toBe(2);
    } finally {
      READ_LIMITS.spareIdleMs = idle;
      await two.close();
    }
  }, 30_000);

  it('starts another spare thread for what comes while what can wait holds one thread and requests every other, and ends both after', async () => {
    const { pool: two, said } = timedPool({ analyse: 4000, compare: 3000, unrecorded: 2000 }, 'spare-stand-in');
    const idle = READ_LIMITS.spareIdleMs;
    READ_LIMITS.spareIdleMs = 50;
    const order: string[] = [];
    const noted = (name: string, p: Promise<{ body: string }>) => p.then((a) => (order.push(name), said(a)));
    try {
      for (let i = 0; i < 400 && !two.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      // A long run's first page: its whole analysis starts beside, both threads being free. A whole
      // Compare takes the other thread, and a long request about another run a spare one.
      const first = said(await two.run({ kind: 'run', runId: 'R', read: {} }, { affinity: 'R' }));
      const compare = noted('compare', two.run({ kind: 'compare', a: 'X', b: 'Y', cwd: null }));
      const tools = noted('tools', two.run({ kind: 'unrecorded', runId: 'S', declared: {} }, { affinity: 'S', calls: 30 }));
      // The sidebar behind all three is answered on a fourth thread, before any of them ends: what can
      // wait holds a thread a request would have had.
      const recent = await noted('recent', two.run({ kind: 'recent', read: {} }));
      const [c, t] = await Promise.all([compare, tools]);
      expect(new Set([first.thread, c.thread, t.thread, recent.thread]).size).toBe(4);
      expect(order).toEqual(['recent', 'tools', 'compare']);
      // Once nothing can wait any more (the analysis outlasts both requests) and they have had nothing
      // to do, both spare threads end.
      const slots = () => (two as unknown as { slots: unknown[] }).slots.length;
      expect(slots()).toBe(4);
      for (let i = 0; i < 400 && slots() > 2; i++) await new Promise((r) => setTimeout(r, 25));
      expect(slots()).toBe(2);
      // The two threads left answer as before.
      const each = (await Promise.all([two.run({ kind: 'recent', read: {} }), two.run({ kind: 'compare', a: 'X', b: 'Y', cwd: null })])).map(said);
      expect(new Set(each.map((x) => x.thread)).size).toBe(2);
    } finally {
      READ_LIMITS.spareIdleMs = idle;
      await two.close();
    }
  }, 30_000);

  it('answers on a spare thread what waits behind two long requests, once it has waited a moment', async () => {
    const { pool: two, said } = timedPool({ compare: 4000 }, 'spare-requests');
    const order: string[] = [];
    const noted = (name: string, p: Promise<{ body: string }>) => p.then((a) => (order.push(name), said(a)));
    try {
      for (let i = 0; i < 400 && !two.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      // Two whole Compares, one on each thread.
      const compares = [noted('compare', two.run({ kind: 'compare', a: 'A', b: 'B', cwd: null })), noted('compare', two.run({ kind: 'compare', a: 'C', b: 'D', cwd: null }))];
      // A small run's page behind them: a third thread answers it, once it has waited a moment.
      const t0 = Date.now();
      const page = await noted('page', two.run({ kind: 'calls', runId: 'S', read: {}, from: 1, limit: 500 }, { affinity: 'S', calls: 30 }));
      expect(order).toEqual(['page']);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(READ_LIMITS.spareAfterMs - 20);
      const [a, b] = await Promise.all(compares);
      expect(new Set([a.thread, b.thread, page.thread]).size).toBe(3);
      expect(order).toEqual(['page', 'compare', 'compare']);
    } finally {
      await two.close();
    }
  }, 30_000);

  it('hands a long run’s whole request to another thread once its holder has kept it waiting, with the run and what waits for it', async () => {
    const { pool: two, said } = timedPool({ compare: 4000 }, 'handed-jobs');
    const was = READ_LIMITS.stealLongMs;
    READ_LIMITS.stealLongMs = 800;
    const order: string[] = [];
    const noted = (name: string, p: Promise<{ body: string }>) => p.then((a) => (order.push(name), said(a)));
    try {
      for (let i = 0; i < 400 && !two.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      // One thread reads a run of 100,000 calls: it holds it. Then two whole Compares take both threads.
      const holder = said(await two.run({ kind: 'calls', runId: 'BIG', read: {}, from: 1, limit: 500 }, { affinity: 'BIG', calls: 100_000 })).thread;
      const compares = [noted('compare', two.run({ kind: 'compare', a: 'A', b: 'B', cwd: null })), noted('compare', two.run({ kind: 'compare', a: 'C', b: 'D', cwd: null }))];
      // The long run's tools, then its JSON: both wait for the holder a while, then a third thread takes
      // the tools with the run, and the JSON follows them there rather than read the run on yet another.
      const tools = noted('tools', two.run({ kind: 'unrecorded', runId: 'BIG', declared: {} }, { affinity: 'BIG', calls: 100_000 }));
      const json = noted('json', two.run({ kind: 'show', runId: 'BIG', read: {} }, { affinity: 'BIG', calls: 100_000 }));
      const [t, j] = await Promise.all([tools, json]);
      expect(t.thread).not.toBe(holder);
      expect(j.thread).toBe(t.thread);
      await Promise.all(compares);
      expect(order).toEqual(['tools', 'json', 'compare', 'compare']);
      // The run is that thread's now: its next request goes there, though the holder is free.
      expect(said(await two.run({ kind: 'unrecorded', runId: 'BIG', declared: {} }, { affinity: 'BIG', calls: 100_000 })).thread).toBe(t.thread);
    } finally {
      READ_LIMITS.stealLongMs = was;
      await two.close();
    }
  }, 30_000);

  it('hands a long run’s whole request over a moment after its holder starts what can wait on another run', async () => {
    const { pool: two, said } = timedPool({ analyse: 3000 }, 'handed-behind-analysis');
    try {
      for (let i = 0; i < 400 && !two.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      // One thread reads a run of 100,000 calls, then answers run R's first page, whose whole analysis
      // it starts once both threads are free: a slice of what can wait that takes seconds.
      const holder = said(await two.run({ kind: 'calls', runId: 'BIG', read: {}, from: 1, limit: 500 }, { affinity: 'BIG', calls: 100_000 })).thread;
      expect(said(await two.run({ kind: 'run', runId: 'R', read: {} }, { affinity: 'R', calls: 5000 })).thread).toBe(holder);
      await new Promise((r) => setTimeout(r, 50));
      // The long run's tools wait for the holder a moment only, then go to the free thread with the run.
      const t0 = Date.now();
      const tools = said(await two.run({ kind: 'unrecorded', runId: 'BIG', declared: {} }, { affinity: 'BIG', calls: 100_000 }));
      const took = Date.now() - t0;
      expect(tools.thread).not.toBe(holder);
      expect(took).toBeGreaterThanOrEqual(2 * READ_LIMITS.warmSliceMs - 20);
      expect(took).toBeLessThan(2500);
      expect(said(await two.run({ kind: 'show', runId: 'BIG', read: {} }, { affinity: 'BIG', calls: 100_000 })).thread).toBe(tools.thread);
    } finally {
      await two.close();
    }
  }, 30_000);

  it('works through the warm-up on the thread that answered a request least lately, leaving a run just read its thread', async () => {
    // Threads whose first slice of the warm-up ends it, and whose slices after that take a while: a
    // long run's prompt cache, worked out in one.
    const script = join(dir, 'slow-warm.mjs');
    writeFileSync(
      script,
      [
        "import { parentPort, threadId } from 'node:worker_threads';",
        'let warms = 0;',
        "parentPort.postMessage({ type: 'ready' });",
        'parentPort.on(\'message\', (m) => {',
        "  if (m.type === 'close') return parentPort.postMessage({ type: 'closed' });",
        '  const answer = (extra = {}) => parentPort.postMessage({ type: \'answer\', id: m.id, answer: { status: 200, body: JSON.stringify({ kind: m.job.kind, thread: threadId }), etag: null, ...extra } });',
        "  if (m.job.kind === 'warm') return ++warms === 1 ? answer({ warm: { done: true, walked: 0, total: 0 } }) : setTimeout(() => answer({ warm: { done: false, walked: 0, total: 1 } }), 1500);",
        '  answer();',
        '});',
      ].join('\n'),
    );
    const two = new ReadPool({ dbPath, keep: { stats: () => undefined, asks: () => undefined }, size: 2, script: pathToFileURL(script) });
    const said = (a: { body: string }) => JSON.parse(a.body) as { kind: string; thread: number };
    try {
      for (let i = 0; i < 400 && !two.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      // A page of a run of 100,000 calls, and the sidebar beside the next on the other thread: the
      // first thread holds the long run.
      const holder = said(await two.run({ kind: 'calls', runId: 'BIG', read: {}, from: 1, limit: 500 }, { affinity: 'BIG', calls: 100_000 })).thread;
      const [, other] = await Promise.all([
        two.run({ kind: 'calls', runId: 'BIG', read: {}, from: 501, limit: 500 }, { affinity: 'BIG', calls: 100_000 }),
        two.run({ kind: 'recent', read: {} }).then(said),
      ]);
      expect(other.thread).not.toBe(holder);
      // The long run's next page: its holder is the thread that answered a request last.
      await new Promise((r) => setTimeout(r, 20));
      expect(said(await two.run({ kind: 'calls', runId: 'BIG', read: {}, from: 1001, limit: 500 }, { affinity: 'BIG', calls: 100_000 })).thread).toBe(holder);
      // The warm-up goes through the runs again: its slice goes to the other thread, the one that
      // answered a request least lately.
      await new Promise((r) => setTimeout(r, 20));
      two.warm();
      await new Promise((r) => setTimeout(r, 100));
      const t0 = Date.now();
      const tools = said(await two.run({ kind: 'unrecorded', runId: 'BIG', declared: {} }, { affinity: 'BIG', calls: 100_000 }));
      expect(tools.thread).toBe(holder);
      expect(Date.now() - t0).toBeLessThan(400);
    } finally {
      await two.close();
    }
  }, 30_000);

  it('leaves a run with the thread that holds it: a long one’s whole request waits for it, a short one’s is taken but stays its', async () => {
    const { pool: two, said } = timedPool({ 'injection-run': 1500, unrecorded: 300 }, 'holder-jobs');
    try {
      for (let i = 0; i < 400 && !two.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      // One thread reads a run of 100,000 calls and two short runs: it holds all three.
      const holder = said(await two.run({ kind: 'calls', runId: 'BIG', read: {}, from: 1, limit: 500 }, { affinity: 'BIG', calls: 100_000 })).thread;
      expect(said(await two.run({ kind: 'calls', runId: 'S', read: {}, from: 1, limit: 500 }, { affinity: 'S', calls: 30 })).thread).toBe(holder);
      expect(said(await two.run({ kind: 'calls', runId: 'T', read: {}, from: 1, limit: 500 }, { affinity: 'T', calls: 40 })).thread).toBe(holder);
      // It takes a long request about one short run; meanwhile the long run's tools are asked, and the other short run's.
      const busy = two.run({ kind: 'injection-run', runId: 'T' }, { affinity: 'T', calls: 40 });
      const big = two.run({ kind: 'unrecorded', runId: 'BIG', declared: {} }, { affinity: 'BIG', calls: 100_000 });
      const small = two.run({ kind: 'unrecorded', runId: 'S', declared: {} }, { affinity: 'S', calls: 30 });
      // The short run's is taken by the free thread; the long run's waits for the thread that holds it.
      const [b, sm] = await Promise.all([big, small]);
      await busy;
      expect(said(sm).thread).not.toBe(holder);
      expect(said(b).thread).toBe(holder);
      // Taken, the short run stayed its holder's: its next request goes there.
      expect(said(await two.run({ kind: 'unrecorded', runId: 'S', declared: {} }, { affinity: 'S', calls: 30 })).thread).toBe(holder);
    } finally {
      await two.close();
    }
  }, 30_000);

  it('ends a thread whose job runs past its time, says so, and answers what comes after on a new one', async () => {
    // A thread that never answers a page of calls.
    const script = join(dir, 'stuck-worker.mjs');
    writeFileSync(
      script,
      [
        "import { parentPort, threadId } from 'node:worker_threads';",
        "parentPort.postMessage({ type: 'ready' });",
        'parentPort.on(\'message\', (m) => {',
        "  if (m.type === 'close') return parentPort.postMessage({ type: 'closed' });",
        "  if (m.job.kind === 'calls') return;",
        "  parentPort.postMessage({ type: 'answer', id: m.id, answer: { status: 200, body: JSON.stringify({ thread: threadId }), etag: null, ...(m.job.kind === 'warm' ? { warm: { done: true, walked: 0, total: 0 } } : {}) } });",
        '});',
      ].join('\n'),
    );
    const was = READ_LIMITS.jobMs;
    READ_LIMITS.jobMs = 300;
    const lines: string[] = [];
    const stuck = new ReadPool({ dbPath, keep: { stats: () => undefined, asks: () => undefined }, size: 1, script: pathToFileURL(script), log: (l) => lines.push(l) });
    try {
      // The warm-up's first slice over: the first answer comes from the thread the calls job then holds,
      // not from a spare answering beside that slice.
      for (let i = 0; i < 400 && !stuck.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      expect(stuck.warmed).toBe(true);
      const first = JSON.parse((await stuck.run({ kind: 'recent', read: {} })).body) as { thread: number };
      const t0 = Date.now();
      const late = stuck.run({ kind: 'calls', runId: 'R', read: {}, from: 1, limit: 500 }, { affinity: 'R' });
      // Asked while the thread is stuck: answered once it has been ended, by the next one.
      const after = stuck.run({ kind: 'recent', read: {} });
      // What happened, and no advice the page can't follow ("ask for less"): each page says what it can do instead.
      await expect(late).rejects.toMatchObject({ status: 503, message: 'a calls job took more than 0.3 s, so it was stopped' });
      expect(Date.now() - t0).toBeLessThan(5000);
      const next = JSON.parse((await after).body) as { thread: number };
      expect(next.thread).not.toBe(first.thread);
      expect(lines.join('\n')).toMatch(/a read-model thread stopped: a calls job took more than 0\.3 s/);
    } finally {
      READ_LIMITS.jobMs = was;
      await stuck.close();
    }
  });

  it('gives a request that reads long runs longer, in step with their calls, and one that reads short runs its time', async () => {
    // Threads that take 600 ms over a comparison: past the time a request is given here, but within
    // what a pair of runs of 2,500 calls is given.
    const { pool: two, said } = timedPool({ compare: 600 }, 'long-pair');
    const was = { jobMs: READ_LIMITS.jobMs, jobCalls: READ_LIMITS.jobCalls };
    READ_LIMITS.jobMs = 300;
    READ_LIMITS.jobCalls = 1000;
    try {
      for (let i = 0; i < 400 && !two.warmed; i++) await new Promise((r) => setTimeout(r, 10));
      expect(said(await two.run({ kind: 'compare', a: 'A', b: 'B', cwd: null }, { calls: 2500 })).kind).toBe('compare');
      await expect(two.run({ kind: 'compare', a: 'C', b: 'D', cwd: null }, { calls: 500 })).rejects.toMatchObject({ status: 503, message: 'a compare job took more than 0.3 s, so it was stopped' });
    } finally {
      Object.assign(READ_LIMITS, was);
      await two.close();
    }
  }, 30_000);

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
