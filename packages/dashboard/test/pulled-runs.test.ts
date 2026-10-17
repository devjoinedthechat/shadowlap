import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '@shadowlap/engine';
import { runDetail, showRunJson } from '../src/api.js';
import { overviewSummary } from '../src/overview.js';
import { listRunsPage } from '../src/runs-list.js';
import { normalizeRunDetail } from '../ui/normalize.js';
import { runSpent, runType } from '../ui/runs.js';
import { metricItems } from '../ui/run/metrics.js';
import { pulledSpender, recordingWords, runLikeOf } from '../ui/run/model.js';
import { Metrics } from '../ui/run/parts.js';
import { upstreamParts } from '../ui/run/provenance.js';
import type { RunDetail } from '../ui/types.js';
import { addRun, HOUR } from './read-model-store.js';

// A teammate's run pulled from the team store is their recording: it reads as a recording, by its
// author, with the requests it sent and what it spent where it was recorded. A pack someone sent
// still says it came from a pack, and holds its calls as captured.

// Thursday, Oct 1 2026, 10:15 UTC.
const NOW = Date.UTC(2026, 9, 1, 10, 15);
const STORE = 's3://northwind-agent-runs/support-agent';

let store: Store;
const id: Record<string, string> = {};

beforeAll(() => {
  store = Store.open(':memory:');
  id.mine = addRun(store, { startedAt: NOW - 5 * HOUR, calls: 'llll', meta: { author: 'dana@example.com' } });
  id.pulled = addRun(store, { startedAt: NOW - 4 * HOUR, argv: ['node', 'support_chat.mjs'], calls: 'llll', meta: { author: 'maya@example.com', imported: { at: NOW - HOUR, from: STORE } } });
  id.nobody = addRun(store, { startedAt: NOW - 3 * HOUR, calls: 'll', meta: { imported: { at: NOW - HOUR, from: STORE } } });
  id.pack = addRun(store, { startedAt: NOW - 2 * HOUR, argv: ['node', 'triage.mjs'], calls: 'llll', meta: { imported: { at: NOW - HOUR, from: 'triage-from-maya' } } });
  id.fork = addRun(store, { parent: id.pulled, startedAt: NOW - 90 * 60_000, divergence: 3, calls: 'rrll', meta: { author: 'maya@example.com', imported: { at: NOW - HOUR, from: STORE } } });
});
afterAll(() => store.close());

const detail = (runId: string): RunDetail => normalizeRunDetail(JSON.parse(JSON.stringify(runDetail(store, runId))) as RunDetail);
const spentLabel = (d: RunDetail) => metricItems({ ...inputOf(d) }).find(([, label]) => label.startsWith('spent'));
function inputOf(d: RunDetail): Parameters<typeof metricItems>[0] {
  const s = d.summary;
  const by = pulledSpender(d.run);
  return {
    total: s.total,
    byKind: s.byKind,
    upstreamRequests: s.upstreamRequests,
    cost: s.cost,
    tokensNotRespent: 0,
    counts: { rep: 0, live: s.total, over: 0, inject: 0, fail: 0, block: 0, stub: 0 },
    capture: runType(runLikeOf(d)) === 'capture',
    ...(by === undefined ? {} : { spentBy: by }),
    live: false,
    notWaitedMs: null,
  };
}

describe('a run pulled from the team store', () => {
  it('is a recording, as the run list and the run page have it, never a pack', () => {
    const rows = new Map(listRunsPage(store, { limit: 50 }).runs.map((r) => [r.runId, r]));
    expect(rows.get(id.pulled)).toMatchObject({ kind: 'recording', label: 'recording', author: 'maya@example.com', imported: true, captured: 0 });
    expect(rows.get(id.pulled)!.spent).toBeGreaterThan(0);
    expect(rows.get(id.pack)).toMatchObject({ kind: 'pack', label: 'recording', spent: 0 });
    expect(rows.get(id.pack)!.captured).toBeGreaterThan(0);
    const d = detail(id.pulled);
    expect(d.state).toMatchObject({ kind: 'recording' });
    expect(recordingWords(d.run)).toBe('recording');
    expect(recordingWords(detail(id.pack).run)).toBe('recording · from a pack');
    expect(recordingWords(detail(id.mine).run)).toBe('recording');
  });

  it('shows the requests it sent and what it spent where it was recorded, by whom', () => {
    const d = detail(id.pulled);
    expect(d.summary).toMatchObject({ imported: false, upstreamRequests: 4 });
    expect(d.summary.cost.captured).toBe(0);
    expect(d.summary.cost.spent).toBeGreaterThan(0);
    expect(pulledSpender(d.run)).toBe('maya');
    expect(spentLabel(d)).toEqual([expect.stringMatching(/^≈\$/), 'spent · by maya']);
    expect(metricItems(inputOf(d)).find(([, label]) => /upstream/.test(label))).toEqual([4, 'upstream requests']);
    // Provenance's Upstream row says the same.
    expect(upstreamParts(d.summary.upstreamRequests, d.summary.cost.spent, pulledSpender(d.run))).toEqual({ text: expect.stringMatching(/^4 requests · ≈\$\S+$/), note: 'by maya' });
    // As drawn on the run page.
    const html = renderToStaticMarkup(createElement(Metrics, { run: d, notWaitedMs: null, notWaitedUnknown: 0 }));
    expect(html).toContain('<span>spent · by maya</span>');
    expect(html).toContain('<span>upstream requests</span>');
    // Runs shows it at that cost too, as spent.
    expect(runSpent(runLikeOf(d))).toEqual({ text: expect.stringMatching(/^≈\$/), captured: false });
  });

  it('names no one when it names no one, as in an HTML copy, and names who forked it', () => {
    const nobody = detail(id.nobody);
    expect(nobody.summary).toMatchObject({ imported: false, upstreamRequests: 2 });
    expect(pulledSpender(nobody.run)).toBeUndefined();
    expect(spentLabel(nobody)).toEqual([expect.stringMatching(/^≈\$/), 'spent']);
    expect(upstreamParts(2, nobody.summary.cost.spent, pulledSpender(nobody.run))).toEqual({ text: expect.stringMatching(/^2 requests · ≈\$\S+$/), note: null });
    const fork = detail(id.fork);
    expect(fork.state).toMatchObject({ kind: 'fork' });
    expect(spentLabel(fork)![1]).toBe('spent · by maya');
  });

  it('leaves a run made here and a pack as they were: what this machine spent, and what a pack holds', () => {
    const mine = detail(id.mine);
    expect(pulledSpender(mine.run)).toBeUndefined();
    expect(spentLabel(mine)![1]).toBe('spent');
    expect(upstreamParts(4, mine.summary.cost.spent, pulledSpender(mine.run))).toEqual({ text: expect.stringMatching(/^4 requests · ≈\$\S+$/), note: null });
    expect(upstreamParts(1, 0).text).toBe('1 request · $0');
    const pack = detail(id.pack);
    expect(pulledSpender(pack.run)).toBeUndefined();
    expect(pack.summary).toMatchObject({ imported: true, upstreamRequests: 0 });
    expect(pack.summary.cost.spent).toBe(0);
    expect(spentLabel(pack)).toEqual(['$0', 'spent']);
  });

  it('counts in the week’s spend, as the team’s: a pack doesn’t', () => {
    const o = overviewSummary(store, { tz: 'UTC', now: NOW });
    const spent = (runId: string) => listRunsPage(store, { limit: 50 }).runs.find((r) => r.runId === runId)!.spent;
    expect(o.outcomes.spent.value).toBeCloseTo(spent(id.mine) + spent(id.pulled) + spent(id.nobody) + spent(id.fork), 10);
  });

  it('gives show --json the same summary, with the store and the author on the run', () => {
    const shown = showRunJson(store, id.pulled)!;
    expect(shown.summary).toMatchObject({ imported: false, upstreamRequests: 4 });
    expect(shown.run.meta).toMatchObject({ author: 'maya@example.com', imported: { from: STORE } });
  });
});
