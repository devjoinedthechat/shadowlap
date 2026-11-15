import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Store, type RunMeta } from '@shadowlap/engine';
import { overviewSummary } from '../src/overview.js';
import { asksRead, cachesRead, runsRead, warmRunStats } from '../src/run-stats.js';
import { loadRunIndex } from '../src/run-index.js';
import { listRunsPage, recentRuns, ROW_CALLS_BUDGET, runsByDay } from '../src/runs-list.js';
import { type JudgeRun, STATUS_JUDGED_RUNS, toolsCalled } from '../src/runs-filter.js';
import { recordedRuns } from '../src/search-hits.js';

/**
 * The read models at scale: 5,000 runs averaging 60 calls, one of them 1,200 calls long, every one
 * of them in the two weeks the Overview reads (the most it ever has to add up).
 *
 * Every run's calls are read once in the store's life: the first look works out each run's totals
 * and keeps them in the store. After that, each read model on a store opened afresh (a new
 * dashboard process) reads one row per run and none of their calls. The test checks that work
 * directly. It measures time as CPU time, which a busy machine does not inflate the way it does
 * wall-clock time, and holds it only against this machine's own measures in the same test, never
 * against a fixed number of milliseconds, which a slow machine goes past with nothing wrong. Both
 * are printed.
 */

const RUNS = 5000;
const NOW = Date.UTC(2026, 9, 1, 10, 15);
const DAY = 86_400_000;
/** The warm-up's budget per slice: the one a dashboard gives it. */
const BUDGET = 50;
/** Seconds of work on a fast machine, a minute on a slow one: each test may take as long as writing the store. */
const TIMEOUT = 180_000;

let dir: string;
let path: string;
let calls = 0;
/** How many runs are recordings: what their user asked is what their about line quotes. */
let recordingCount = 0;
/** Each run's number of calls. */
const lengths = new Map<string, number>();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'shadowlap-read-models-'));
  path = join(dir, 'shadowlap.db');
  const store = Store.open(path);
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const headers = { 'content-type': 'text/event-stream', 'request-id': 'req_011CTd8z5n2fXq', 'anthropic-ratelimit-requests-remaining': '3999' };
  const recordings: Array<{ id: string; n: number; startedAt: number }> = [];
  const write = (runId: string, n: number, startedAt: number, originOf: (c: number) => 'live' | 'replayed' | 'blocked') => {
    lengths.set(runId, n);
    for (let c = 1; c <= n; c++) {
      const api = c % 2 === 1;
      const origin = originOf(c);
      const identity = { kind: api ? ('api' as const) : ('tool' as const), name: api ? 'POST /v1/messages' : 'lookup_order', fingerprint: `f${c}`, occurrence: 1 };
      store.appendCallStart({ runId, callNo: c, ...identity, origin, effect: api ? null : c % 10 === 0 ? 'write' : 'read', requestRef: null, meta: api ? { provider: 'anthropic', retryCount: 0 } : {}, at: startedAt + c * 900 });
      const replayed = origin === 'replayed';
      const meta: Record<string, unknown> = api
        ? { status: 200, headers, latencyMs: replayed ? 0 : 1800 + (c % 5) * 150, retryable: false, bytes: 2048, provider: 'anthropic', model: 'claude-sonnet-4-5', stopReason: 'tool_use', usage: { inputTokens: 24, outputTokens: 80, cacheReadInputTokens: 900 + c * 120, cacheCreationInputTokens: 150 }, chunks: [[0, 12], [180, 40], [420, 95], [700, 160]] }
        : { latencyMs: replayed ? 0 : 140 };
      if (replayed) meta.replayedFrom = c;
      store.appendCallEnd(identity, { runId, callNo: c, attempt: 0, responseRef: null, outcome: origin === 'blocked' ? 'error' : 'ok', meta, at: startedAt + c * 900 + 450 });
      calls++;
    }
  };
  store.transaction(() => {
    for (let i = 0; i < RUNS; i++) {
      const startedAt = i === 0 ? NOW - 3 * DAY : NOW - Math.floor(rnd() * 13 * DAY);
      const n = i === 0 ? 1200 : 20 + Math.floor(rnd() * 81);
      const pick = rnd();
      if (recordings.length && pick < 0.45) {
        const parent = recordings[Math.floor(rnd() * recordings.length)];
        const clean = pick < 0.15;
        const forkAt = 2 + Math.floor(rnd() * (parent.n - 1));
        const meta: RunMeta = pick < 0.05 ? { repeat: { group: `g${i}`, attempt: 1, of: 3 } } : pick < 0.07 ? { probe: { of: parent.id, callNo: forkAt, passed: rnd() < 0.5 }, repeat: { group: `b${i}`, attempt: 1, of: 4 } } : pick < 0.09 ? { test: { golden: `goldens/g${i % 40}`, session: `s${i % 300}` } } : {};
        const run = store.createRun({ mode: 'replay', parentRunId: parent.id, command: { argv: ['python', 'agent.py'], cwd: '/work' }, startedAt: Math.max(startedAt, parent.startedAt + 1000), meta });
        const len = clean ? parent.n : Math.max(forkAt, n);
        write(run.runId, len, startedAt, (c) => (clean || c < forkAt ? 'replayed' : c % 10 === 0 ? 'blocked' : 'live'));
        if (!clean) store.setDivergence(run.runId, { type: 'request_changed', callNo: forkAt, kind: 'api', name: 'POST /v1/messages', replayedBefore: forkAt - 1, diff: [{ path: '$.system', op: 'changed', before: 'You are a support agent.', after: 'You are a support agent. Escalate refunds above the limit.' }] });
        store.endRun(run.runId, rnd() < 0.08 ? 'failed' : 'completed', startedAt + len * 900);
      } else {
        const failed = rnd() < 0.1;
        const meta: RunMeta = { labels: rnd() < 0.2 ? ['refund-flow'] : [], author: rnd() < 0.5 ? 'dana@example.com' : 'ci' };
        if (failed && rnd() < 0.5) Object.assign(meta, { blame: { at: startedAt + 3_600_000, outcome: 'blamed', callNo: 5, confidence: 'high', rescuedRunId: null, fields: {}, oracle: ['the agent exits 0'], probes: [], spent: 0.1 } });
        const run = store.createRun({ mode: 'record', command: { argv: ['python', 'agent.py'], cwd: '/work' }, startedAt, meta });
        write(run.runId, n, startedAt, () => 'live');
        store.endRun(run.runId, failed ? 'failed' : 'completed', startedAt + n * 900);
        recordings.push({ id: run.runId, n, startedAt });
      }
    }
  });
  recordingCount = recordings.length;
  store.close();
}, TIMEOUT);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Timed<T> {
  out: T;
  /** CPU time the read took, in ms: what the code costs, whatever else the machine is doing. */
  cpu: number;
  wall: number;
  /** Runs whose calls the read had to read, for their totals and for their prompt cache, and recordings whose requests it read for what their user asked. */
  read: number;
  caches: number;
  asks: number;
}

/** One read on a store opened afresh, as a new dashboard process would; the best of `times`. */
function timed<T>(read: (store: Store) => T, times = 3): Timed<T> {
  let best: Timed<T> | null = null;
  for (let i = 0; i < times; i++) {
    const store = Store.open(path);
    try {
      const c0 = process.cpuUsage();
      const t0 = performance.now();
      const out = read(store);
      const wall = performance.now() - t0;
      const c = process.cpuUsage(c0);
      const t = { out, cpu: (c.user + c.system) / 1000, wall, read: runsRead(store), caches: cachesRead(store), asks: asksRead(store) };
      if (!best || t.cpu < best.cpu) best = t;
    } finally {
      store.close();
    }
  }
  return best!;
}

const ms = (t: { cpu: number; wall: number }) => `${Math.round(t.cpu)} ms CPU, ${Math.round(t.wall)} ms`;

/**
 * A measure of this machine, for the reads to be held against: the CPU time of one plain read of
 * every call's rows, through SQLite alone, none of shadowlap's code in it.
 */
function plainRead(): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const c0 = process.cpuUsage();
    let rows = 0;
    for (const _ of db.prepare('SELECT * FROM call_events').iterate()) rows++;
    const c = process.cpuUsage(c0);
    expect(rows).toBe(2 * calls);
    return (c.user + c.system) / 1000;
  } finally {
    db.close();
  }
}

/**
 * One batch of the warm-up, as it kept it: its runs' totals, the prompt cache of those of the last
 * eight days, and for recordings the first thing their user asked, which their about line quotes.
 */
interface Batch {
  runs: string[];
  caches: string[];
  asks: string[];
  /** On the warm-up's own clock, how long its slice had run when this batch ended; null when no run was left to go on with. */
  at: number | null;
}

interface Slice {
  batches: Batch[];
  /** True for the last: no run left. */
  done: boolean;
  cpu: number;
}

/** A save of the warm-up: each run's totals as it kept them. */
type Saved = Array<{ runId: string; stats: string }>;
/** What some recordings' users asked, as the warm-up kept it (`run_asks`). */
type Asked = { asked: string[] };

/**
 * A slice's batches from what it did, in order: a reading of its clock as it starts, then for each
 * batch the totals it kept (its runs), what it added to them (the prompt cache of some), what some
 * recordings' user asked, and a reading of its clock while runs are left.
 */
function batchesOf(events: Array<number | Saved | Asked>): Batch[] {
  const [started, ...rest] = events;
  if (typeof started !== 'number') throw new Error('the slice did not read its clock first');
  const out: Batch[] = [];
  const empty = (): Batch => ({ runs: [], caches: [], asks: [], at: null });
  let batch = empty();
  // Each run's totals as the batch last kept them: a later save adds the prompt cache, or the ask.
  let kept = new Map<string, Record<string, unknown>>();
  for (const e of rest) {
    if (typeof e === 'number') {
      batch.at = e - started;
      out.push(batch);
      batch = empty();
      kept = new Map();
      continue;
    }
    if (!Array.isArray(e)) {
      batch.asks.push(...e.asked);
      continue;
    }
    const first = !batch.runs.length;
    if (first) batch.runs = e.map((r) => r.runId);
    for (const r of e) {
      const now = JSON.parse(r.stats) as Record<string, unknown>;
      const was = kept.get(r.runId);
      if (!first && was && !('cache' in was) && 'cache' in now) batch.caches.push(r.runId);
      kept.set(r.runId, now);
    }
  }
  if (batch.runs.length) out.push(batch);
  return out;
}

describe('read models at scale', () => {
  it('read every run’s calls once, then answer for 5,000 runs and 300,000 calls from a row per run', () => {
    expect(calls).toBeGreaterThan(RUNS * 55);
    const plain = plainRead();
    const first = timed((s) => overviewSummary(s, { tz: 'Europe/Berlin', now: NOW }), 1);
    expect(first.read).toBe(RUNS);
    // The prompt cache only for this week's runs: the week before never needs it.
    expect(first.caches).toBeGreaterThan(1000);
    expect(first.caches).toBeLessThan(RUNS * 0.75);
    // Once in the store's life: 1.7 to 1.9 times what a plain read of every call takes on Node 22, and
    // 2.4 to 3.1 times on Node 24, whose plain read is faster. Under 8 times leaves room for both, and
    // fails a first look that read the whole store again for each run.
    expect(first.cpu, `the first look took ${ms(first)}, ${(first.cpu / plain).toFixed(1)} times a plain read of every call`).toBeLessThan(8 * plain);
    // A run is named by its id with its about line, which for a recording quotes what its user asked
    // first: a first look works that out only for the runs it shows (the newest failing run nobody
    // has blamed, which Needs a look names, here a replay, which quotes no ask), and the lists for
    // those they show or filter (a word in the filter field reads every run's), each keeping it with
    // the run's totals, reading no calls again.
    const unblamed = first.out.needsLook.items.find((r) => r.kind === 'unblamed');
    expect(unblamed?.about?.text).toBeTruthy();
    expect(first.asks).toBeLessThanOrEqual(1);
    const lists = timed((s) => [listRunsPage(s, { q: 'agent' }), recentRuns(s)], 1);
    expect(lists.read).toBe(0);
    expect(first.asks + lists.asks).toBe(recordingCount);

    const summary = timed((s) => overviewSummary(s, { tz: 'Europe/Berlin', now: NOW }));
    const page = timed((s) => listRunsPage(s, {}));
    const bySpent = timed((s) => listRunsPage(s, { sort: 'spent' }));
    const byCalls = timed((s) => listRunsPage(s, { sort: 'calls' }));
    const failures = timed((s) => listRunsPage(s, { types: ['failed'], q: 'agent' }));
    const calendar = timed((s) => runsByDay(s, { tz: 'Europe/Berlin', now: NOW }));
    const sidebar = timed((s) => recentRuns(s));

    expect(summary.out).toEqual(first.out);
    expect(summary.out.sums.week.runs + summary.out.sums.lastWeek.runs).toBeGreaterThan(4500);
    expect(summary.out.sums.week.runs).toBeGreaterThan(0);
    expect(page.out.runs).toHaveLength(50);
    expect(page.out.total).toBeGreaterThan(4500);
    expect(page.out.runs.every((r) => r.origins.length === r.calls)).toBe(true);
    const spent = bySpent.out.runs.map((r) => r.spent);
    expect(spent).toEqual([...spent].sort((a, b) => b - a));
    expect(byCalls.out.runs[0].calls).toBe(1200);
    expect(failures.out.total).toBeGreaterThan(0);
    expect(calendar.out.totals.runs).toBeGreaterThan(4500);
    expect(sidebar.out).toHaveLength(500);

    const reads = { summary, page, bySpent, byCalls, failures, calendar, sidebar };
    process.stdout.write(`read models on ${RUNS} runs, ${calls} calls: a plain read of every call ${Math.round(plain)} ms CPU; first look ${ms(first)} (${first.caches} runs' prompt cache); then ${Object.entries(reads).map(([name, t]) => `${name} ${ms(t)}`).join(', ')}\n`);
    for (const [name, t] of Object.entries(reads)) {
      // No read model reads a finished run's calls again.
      expect(t.read, `${name} read the calls of ${t.read} runs`).toBe(0);
      expect(t.caches, `${name} worked out the prompt cache of ${t.caches} runs`).toBe(0);
      expect(t.asks, `${name} read what the user of ${t.asks} recordings asked again`).toBe(0);
      // A row per run: about a tenth of what a plain read of every call takes on Node 22, and about a
      // fifth on Node 24. Under one plain read: less than reading every call's row again.
      expect(t.cpu, `${name} took ${ms(t)}, ${(t.cpu / plain).toFixed(2)} times a plain read of every call`).toBeLessThan(plain);
    }
  }, TIMEOUT);

  it('judges what Failed counts by a family’s checks within a read’s budget, the newest runs first', () => {
    const asked: string[] = [];
    // Nothing judged yet (`quick` finds none), and a run judged in full fails its family's checks.
    const judge: JudgeRun = (runId, quick) => (quick ? undefined : (asked.push(runId), { by: 'family', verdict: 'failed' }));
    const callsOf = (ids: readonly string[]) => ids.reduce((n, id) => n + lengths.get(id)!, 0);
    const s = Store.open(path);
    try {
      const page = listRunsPage(s, { types: ['failed'], known: true, judge });
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.length).toBeLessThanOrEqual(STATUS_JUDGED_RUNS);
      expect(callsOf(asked)).toBeLessThanOrEqual(ROW_CALLS_BUDGET);
      expect(page.warming?.what).toBe('verdicts');
      asked.length = 0;
      runsByDay(s, { tz: 'Europe/Berlin', now: NOW, types: ['failed'], known: true, judge });
      expect(asked.length).toBeLessThanOrEqual(STATUS_JUDGED_RUNS);
      expect(callsOf(asked)).toBeLessThanOrEqual(ROW_CALLS_BUDGET);
    } finally {
      s.close();
    }
  }, TIMEOUT);

  it('works the totals out ahead in short slices, so the first look reads no calls either', () => {
    // The measure of this machine the warm-up's time is held against, as the reads' is above.
    const plain = plainRead();
    // As a store no dashboard has opened: no run's totals kept yet, nor what any user asked.
    const raw = new DatabaseSync(path);
    raw.exec('DELETE FROM run_stats; DELETE FROM run_asks');
    raw.close();
    const store = Store.open(path);
    // What each slice does, in order: the warm-up's own clock (performance.now), read as the slice
    // starts and after each batch while runs are left, and what each batch keeps.
    let events: Array<number | Saved | Asked> = [];
    const clock = performance.now.bind(performance);
    const save = store.saveRunStats.bind(store);
    const saveAsks = store.saveRunAsks.bind(store);
    vi.spyOn(performance, 'now').mockImplementation(() => {
      const t = clock();
      events.push(t);
      return t;
    });
    vi.spyOn(store, 'saveRunStats').mockImplementation((rows) => {
      events.push(rows.map((r) => ({ runId: r.runId, stats: r.stats })));
      return save(rows);
    });
    vi.spyOn(store, 'saveRunAsks').mockImplementation((rows) => {
      events.push({ asked: rows.map((r) => r.runId) });
      return saveAsks(rows);
    });
    const slices: Slice[] = [];
    try {
      for (let done = false; !done; ) {
        events = [];
        const c0 = process.cpuUsage();
        done = warmRunStats(store, { budgetMs: BUDGET, now: NOW });
        const c = process.cpuUsage(c0);
        slices.push({ batches: batchesOf(events), done, cpu: (c.user + c.system) / 1000 });
      }
      expect(runsRead(store)).toBe(RUNS);
      // The last eight days' prompt cache too: the Overview's week, wherever the viewer is.
      expect(cachesRead(store)).toBeGreaterThan(1000);
      // And what each recording's user asked, which its about line quotes in every list.
      expect(asksRead(store)).toBe(recordingCount);
    } finally {
      vi.restoreAllMocks();
      store.close();
    }
    const batches = slices.flatMap((s) => s.batches);
    const total = slices.reduce((n, s) => n + s.cpu, 0);
    const first = slices[0].cpu;
    const middle = slices.slice(1, -1).map((s) => s.cpu);
    const median = [...middle].sort((a, b) => a - b)[Math.floor(middle.length / 2)];
    const longest = Math.max(...middle);
    process.stdout.write(`warmed ${RUNS} runs (${batches.reduce((n, b) => n + b.caches.length, 0)} with their prompt cache) in ${slices.length} slices of ${batches.length} batches, ${Math.round(total)} ms CPU in all where a plain read of every call took ${Math.round(plain)} ms: the first ${Math.round(first)} ms CPU, with the run index; then median ${Math.round(median)} ms CPU, the longest ${Math.round(longest)} ms\n`);

    // Every run's totals kept once, by one batch.
    expect(new Set(batches.flatMap((b) => b.runs)).size).toBe(RUNS);
    expect(batches.reduce((n, b) => n + b.runs.length, 0)).toBe(RUNS);
    // A batch is cut by the calls it reads: it takes no run more once it has 50, or once it has read
    // 2,000 calls, a run's counted four times when its prompt cache is worked out too (that reads
    // every request it sent), and once more for a recording whose user's first words are read (that
    // reads its requests to count its conversations).
    expect(batches.reduce((n, b) => n + b.asks.length, 0)).toBe(recordingCount);
    for (const [i, b] of batches.entries()) {
      expect(b.runs.length, `batch ${i} kept ${b.runs.length} runs`).toBeLessThanOrEqual(50);
      const before = b.runs.slice(0, -1).reduce((n, id) => n + lengths.get(id)! * (b.caches.includes(id) ? 4 : 1) + (b.asks.includes(id) ? lengths.get(id)! : 0), 0);
      expect(before, `batch ${i} went on after reading ${before} calls' worth`).toBeLessThan(2000);
    }
    // A slice, on its own clock, runs a batch at least, then the next only while its budget is not
    // spent: it stops at the first batch that ends past it, or when no run is left. On any machine.
    for (const [i, s] of slices.entries()) {
      const at = s.batches.map((b) => b.at);
      expect(at.length, `slice ${i} kept nothing`).toBeGreaterThan(0);
      const past = at.slice(0, -1).findIndex((t) => t === null || t >= BUDGET);
      expect(past, `slice ${i} went on after its batch ${past} ended ${at[past]?.toFixed(1)} ms in, past its budget`).toBe(-1);
      if (s.done) expect(at.at(-1), 'the last slice read its clock with no run left').toBeNull();
      else expect(at.at(-1), `slice ${i} stopped before its budget was spent`).toBeGreaterThanOrEqual(BUDGET);
    }
    // Time only against this machine's own. The slices do the first look's work between them: 1.7 to
    // 1.9 times a plain read of every call on Node 22, and 2.4 to 3.1 times on Node 24. Under 8 times,
    // as the first look is held, leaves room for both, and fails batches that read more than their
    // runs' calls: a scan of every call in each batch took 60 to 100 times.
    expect(total, `the warm-up took ${Math.round(total)} ms of CPU time in all, ${(total / plain).toFixed(1)} times a plain read of every call`).toBeLessThan(8 * plain);
    // The first slice also reads the run index, one row per run, as every read model does first: with
    // its batches, 0.06 to 0.08 of a plain read on Node 22 and up to 0.14 on Node 24, about what a read
    // model takes. Under one plain read, as each of them is held.
    expect(first, `the first slice took ${Math.round(first)} ms of CPU time, ${(first / plain).toFixed(2)} times a plain read of every call`).toBeLessThan(plain);
    // Each slice between the first and the last (which ends with the runs) takes its budget and at
    // most one batch more: none takes four times the median (the longest, 1.7 times at most here).
    expect(middle.length, 'the warm-up took one slice or two: none between to hold against the others').toBeGreaterThan(0);
    expect(longest, `a slice took ${Math.round(longest)} ms of CPU time, where half took ${Math.round(median)} ms or less`).toBeLessThan(4 * median);

    const summary = timed((s) => overviewSummary(s, { tz: 'Europe/Berlin', now: NOW }), 1);
    expect([summary.read, summary.caches]).toEqual([0, 0]);
  }, TIMEOUT);

  it('finds the runs a word every run recorded is in, and the tools each run called, each in less than a plain read of every call', () => {
    const plain = plainRead();
    // The search index as it holds what tool calls were given, a document a call: a word in every run, in half its calls.
    const store = Store.open(path);
    try {
      for (const [runId, n] of lengths) store.replaceSearchDocs(runId, n, 'completed', Array.from({ length: Math.floor(n / 2) }, (_, i) => ({ callNo: 2 * i + 2, field: 'input', text: `lookup_order {"order":"A-${1000 + i}","why":"refund check"}` })));
    } finally {
      store.close();
    }
    const word = timed((s) => {
      const index = loadRunIndex(s);
      const c0 = process.cpuUsage();
      const runs = recordedRuns(s, 'refund', index);
      const c = process.cpuUsage(c0);
      return { runs: runs.size, cpu: (c.user + c.system) / 1000 };
    });
    const tools = timed((s) => toolsCalled(s));
    process.stdout.write(`over ${RUNS} runs: the ${word.out.runs} a word is recorded in ${Math.round(word.out.cpu)} ms CPU, the tools each called ${ms(tools)}\n`);
    expect(word.out.runs).toBe([...lengths.values()].filter((n) => n >= 2).length);
    expect(tools.out.size).toBe(word.out.runs);
    expect(word.out.cpu, `the word took ${Math.round(word.out.cpu)} ms CPU, ${(word.out.cpu / plain).toFixed(2)} times a plain read of every call`).toBeLessThan(plain);
    expect(tools.cpu, `the tools took ${ms(tools)}, ${(tools.cpu / plain).toFixed(2)} times a plain read of every call`).toBeLessThan(plain);
  }, TIMEOUT);
});
