import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunMeta } from '@shadowlap/engine';
import { overviewSummary } from '../src/overview.js';
import { cachesRead, runsRead, warmRunStats } from '../src/run-stats.js';
import { listRunsPage, recentRuns, runsByDay } from '../src/runs-list.js';

/**
 * The read models at scale: 5,000 runs averaging 60 calls, one of them 1,200 calls long, every one
 * of them in the two weeks the Overview reads (the most it ever has to add up).
 *
 * Every run's calls are read once in the store's life: the first look works out each run's totals
 * and keeps them in the store. After that, each read model on a store opened afresh (a new
 * dashboard process) reads one row per run and none of their calls. The test checks that work
 * directly, and bounds each read by the CPU time it takes, which a busy machine does not inflate
 * the way it does wall-clock time. Both are printed.
 */

const RUNS = 5000;
const NOW = Date.UTC(2026, 9, 1, 10, 15);
const DAY = 86_400_000;

let dir: string;
let path: string;
let calls = 0;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'shadowlap-read-models-'));
  path = join(dir, 'shadowlap.db');
  const store = Store.open(path);
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const headers = { 'content-type': 'text/event-stream', 'request-id': 'req_011CTd8z5n2fXq', 'anthropic-ratelimit-requests-remaining': '3999' };
  const recordings: Array<{ id: string; n: number; startedAt: number }> = [];
  const write = (runId: string, n: number, startedAt: number, originOf: (c: number) => 'live' | 'replayed' | 'blocked') => {
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
        const parent = recordings[Math.floor(rnd() * recordings.length)]!;
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
  store.close();
}, 180_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Timed<T> {
  out: T;
  /** CPU time the read took, in ms: what the code costs, whatever else the machine is doing. */
  cpu: number;
  wall: number;
  /** Runs whose calls the read had to read, for their totals and for their prompt cache. */
  read: number;
  caches: number;
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
      const t = { out, cpu: (c.user + c.system) / 1000, wall, read: runsRead(store), caches: cachesRead(store) };
      if (!best || t.cpu < best.cpu) best = t;
    } finally {
      store.close();
    }
  }
  return best!;
}

const ms = (t: { cpu: number; wall: number }) => `${Math.round(t.cpu)} ms CPU, ${Math.round(t.wall)} ms`;

describe('read models at scale', () => {
  it('read every run’s calls once, then answer for 5,000 runs and 300,000 calls from a row per run', () => {
    expect(calls).toBeGreaterThan(RUNS * 55);
    const first = timed((s) => overviewSummary(s, { tz: 'Europe/Berlin', now: NOW }), 1);
    expect(first.read).toBe(RUNS);
    // The prompt cache only for this week's runs: the week before never needs it.
    expect(first.caches).toBeGreaterThan(1000);
    expect(first.caches).toBeLessThan(RUNS * 0.75);
    // Once in the store's life: about 2 s of CPU time alone; the bound leaves room for a slower machine.
    expect(first.cpu, `the first look took ${ms(first)}`).toBeLessThan(6_000);

    const summary = timed((s) => overviewSummary(s, { tz: 'Europe/Berlin', now: NOW }));
    const page = timed((s) => listRunsPage(s, {}));
    const bySpent = timed((s) => listRunsPage(s, { sort: 'spent' }));
    const byCalls = timed((s) => listRunsPage(s, { sort: 'calls' }));
    const failures = timed((s) => listRunsPage(s, { types: ['failed'], q: 'agent' }));
    const calendar = timed((s) => runsByDay(s, { tz: 'Europe/Berlin', now: NOW }));
    const sidebar = timed((s) => recentRuns(s));

    expect(summary.out).toEqual(first.out);
    expect(summary.out.sums.week.runs + summary.out.sums.lastWeek.runs).toBeGreaterThan(4500);
    expect(summary.out.grid.families.length).toBeGreaterThan(0);
    expect(summary.out.grid.shown).toBeLessThanOrEqual(40);
    expect(page.out.runs).toHaveLength(50);
    expect(page.out.total).toBeGreaterThan(4500);
    expect(page.out.runs.every((r) => r.origins.length === r.calls)).toBe(true);
    const spent = bySpent.out.runs.map((r) => r.spent);
    expect(spent).toEqual([...spent].sort((a, b) => b - a));
    expect(byCalls.out.runs[0]!.calls).toBe(1200);
    expect(failures.out.total).toBeGreaterThan(0);
    expect(calendar.out.totals.runs).toBeGreaterThan(4500);
    expect(sidebar.out).toHaveLength(500);

    const reads = { summary, page, bySpent, byCalls, failures, calendar, sidebar };
    process.stdout.write(`read models on ${RUNS} runs, ${calls} calls: first look ${ms(first)} (${first.caches} runs' prompt cache); then ${Object.entries(reads).map(([name, t]) => `${name} ${ms(t)}`).join(', ')}\n`);
    for (const [name, t] of Object.entries(reads)) {
      // No read model reads a finished run's calls again.
      expect(t.read, `${name} read the calls of ${t.read} runs`).toBe(0);
      expect(t.caches, `${name} worked out the prompt cache of ${t.caches} runs`).toBe(0);
      // Alone, each takes 60 to 130 ms of CPU time; the bound leaves room for a slower machine.
      expect(t.cpu, `${name} took ${ms(t)}`).toBeLessThan(1000);
    }
  });

  it('works the totals out ahead in short slices, so the first look reads no calls either', () => {
    // As a store no dashboard has opened: no run's totals kept yet.
    const raw = new DatabaseSync(path);
    raw.exec('DELETE FROM run_stats');
    raw.close();
    const store = Store.open(path);
    try {
      let slices = 0;
      const took: number[] = [];
      for (let done = false; !done; slices++) {
        const c0 = process.cpuUsage();
        done = warmRunStats(store, { budgetMs: 50, now: NOW });
        const c = process.cpuUsage(c0);
        took.push((c.user + c.system) / 1000);
      }
      expect(runsRead(store)).toBe(RUNS);
      // The last eight days' prompt cache too: the Overview's week, wherever the viewer is.
      expect(cachesRead(store)).toBeGreaterThan(1000);
      const longest = Math.max(...took);
      const sorted = [...took].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      process.stdout.write(`warmed ${RUNS} runs (${cachesRead(store)} with their prompt cache) in ${slices} slices, median ${Math.round(median)} ms CPU, the longest ${Math.round(longest)} ms\n`);
      // A slice stops at the first batch that ends past its 50 ms, and batches are cut by the calls
      // they read: alone, slices take 50 to 70 ms. The bounds leave room for a slower machine.
      expect(slices).toBeGreaterThanOrEqual(10);
      expect(median, `half the slices took more than ${Math.round(median)} ms of CPU time`).toBeLessThan(120);
      expect(longest, `a slice took ${Math.round(longest)} ms of CPU time`).toBeLessThan(250);
    } finally {
      store.close();
    }
    const summary = timed((s) => overviewSummary(s, { tz: 'Europe/Berlin', now: NOW }), 1);
    expect([summary.read, summary.caches]).toEqual([0, 0]);
  });
});
