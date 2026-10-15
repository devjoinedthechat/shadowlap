import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store, type RunMeta } from '@shadowlap/engine';
import { overviewSummary } from '../src/overview.js';
import { listRunsPage, runsByDay } from '../src/runs-list.js';

/**
 * The read models at scale: 5,000 runs averaging 60 calls, one of them 1,200 calls long, spread
 * evenly over the calendar's twelve weeks (about 830 of them in the two weeks the Overview reads).
 * Each read model is timed on a store opened afresh, so nothing it worked out before helps it.
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
      const startedAt = i === 0 ? NOW - 3 * DAY : NOW - Math.floor(rnd() * 83 * DAY);
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
}, 120_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Times one read on a store opened afresh, nothing kept from an earlier read. The best of three
 * such reads is what the code costs; the others measure whatever else the machine was doing.
 */
function timed<T>(read: (store: Store) => T): { ms: number; out: T } {
  let best: { ms: number; out: T } | null = null;
  for (let i = 0; i < 3; i++) {
    const store = Store.open(path);
    try {
      const t0 = performance.now();
      const out = read(store);
      const ms = performance.now() - t0;
      if (!best || ms < best.ms) best = { ms, out };
    } finally {
      store.close();
    }
  }
  return best!;
}

describe('read models at scale', () => {
  it('answer for 5,000 runs and 300,000 calls in well under a second each', () => {
    expect(calls).toBeGreaterThan(RUNS * 55);
    const summary = timed((s) => overviewSummary(s, { tz: 'Europe/Berlin', now: NOW }));
    const page = timed((s) => listRunsPage(s, {}));
    const failures = timed((s) => listRunsPage(s, { types: ['failed'], q: 'agent' }));
    const calendar = timed((s) => runsByDay(s, { tz: 'Europe/Berlin', now: NOW }));
    expect(summary.out.sums.week.runs + summary.out.sums.lastWeek.runs).toBeGreaterThan(600);
    expect(summary.out.grid.families.length).toBeGreaterThan(0);
    expect(page.out.runs).toHaveLength(50);
    expect(page.out.total).toBeGreaterThan(4000);
    expect(page.out.runs.some((r) => r.origins.length === r.calls && r.calls > 0)).toBe(true);
    expect(failures.out.total).toBeGreaterThan(0);
    expect(calendar.out.totals.runs).toBeGreaterThan(4000);
    // Alone, the summary takes about 400 ms and the others under 100 ms; the bound leaves room for a busy machine.
    for (const [name, t] of Object.entries({ summary, page, failures, calendar })) expect(t.ms, `${name} took ${Math.round(t.ms)} ms`).toBeLessThan(1000);
    process.stdout.write(`read models on ${RUNS} runs, ${calls} calls: summary ${Math.round(summary.ms)} ms, page ${Math.round(page.ms)} ms, failed page ${Math.round(failures.ms)} ms, calendar ${Math.round(calendar.ms)} ms\n`);
  });
});
