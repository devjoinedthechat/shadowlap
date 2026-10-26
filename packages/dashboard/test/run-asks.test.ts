import { describe, expect, it, vi } from 'vitest';
import { Store } from '@shadowlap/engine';
import { loadRunIndex } from '../src/run-index.js';
import { asksOf, asksRead, warmRunStats } from '../src/run-stats.js';
import { listRunsPage, runsByDay } from '../src/runs-list.js';
import { addRun, DAY } from './read-model-store.js';

/**
 * A recording's about line quotes what its user asked first, which is read from its requests. That
 * is kept per finished run (`run_asks`) and comes with the run index, read in a few rows at a time as
 * it is kept, so the run list's filter matches about lines without reading any request: on the
 * dashboard it matches those known, and says how many are still being worked out (`warming`), never
 * working out thousands of them while a browser waits. Keeping what was worked out reads no run
 * again.
 */

const NOW = Date.UTC(2026, 9, 1, 12);
const asked = (order: string) => ({ system: 'You are a support agent.', messages: [{ role: 'user', content: `A customer asks for a refund of order ${order}. They paid $40.` }] });

function store3(): { store: Store; ids: string[] } {
  const store = Store.open(':memory:');
  const ids = ['A-1131', 'B-2242', 'C-3353'].map((order, i) => addRun(store, { startedAt: NOW - DAY + i * 60_000, argv: ['node', 'refund_agent.mjs'], calls: [{ code: 'l', request: asked(order) }, { code: 'l', kind: 'tool' }] }));
  return { store, ids };
}

describe('what recordings’ users asked, with the run index', () => {
  it('comes with the index once kept, read in as it is kept, the index itself not read again', () => {
    const { store, ids } = store3();
    const index = loadRunIndex(store);
    expect(index.byId.get(ids[0])!.ask).toBeUndefined();
    // Worked out (as the warm-up does) and kept: the index read before stays, and now has it.
    asksOf(store, index, [index.byId.get(ids[0])!]);
    const after = loadRunIndex(store);
    expect(after).toBe(index);
    expect(after.byId.get(ids[0])!.ask).toEqual({ text: 'A customer asks for a refund of order A-1131', agent: false, batch: false });
    // Another process's store opened afresh reads it with the index, and reads no request for it.
    expect(store.query('SELECT COUNT(*) AS n FROM run_asks')).toEqual([{ n: 1 }]);
    // A change to a run is taken into the index in place: what the others asked stays.
    store.updateRunMeta(ids[1], { labels: ['refunds'] });
    expect(loadRunIndex(store)).toBe(index);
    expect(index.byId.get(ids[1])!.meta.labels).toEqual(['refunds']);
    expect(loadRunIndex(store).byId.get(ids[0])!.ask?.text).toBe('A customer asks for a refund of order A-1131');
    store.close();
  });

  it('is kept by the warm-up, and keeping it or the totals reads no run again', () => {
    const { store, ids } = store3();
    const index = loadRunIndex(store);
    while (!warmRunStats(store, { budgetMs: 0, now: NOW }));
    expect(loadRunIndex(store)).toBe(index);
    expect(ids.map((id) => loadRunIndex(store).byId.get(id)!.ask?.text)).toEqual(['A customer asks for a refund of order A-1131', 'A customer asks for a refund of order B-2242', 'A customer asks for a refund of order C-3353']);
    store.close();
  });

  it('is moved from where an earlier build kept it, with the run’s totals, rather than read again', () => {
    const { store, ids } = store3();
    const index = loadRunIndex(store);
    const run = index.byId.get(ids[2])!;
    // As an earlier build kept it: inside the totals' JSON, under the totals' key.
    const key = `t4|${run.status}|${run.endedAt}|${run.calls}`;
    store.saveRunStats([{ runId: run.runId, key, stats: JSON.stringify({ codes: 'll', models: [], notWaitedMs: 0, ask: { text: 'Kept before', agent: false, batch: false } }) }]);
    const before = asksRead(store);
    expect(asksOf(store, index, [run]).get(run.runId)).toEqual({ text: 'Kept before', agent: false, batch: false });
    expect(asksRead(store)).toBe(before);
    expect(loadRunIndex(store).byId.get(run.runId)!.ask?.text).toBe('Kept before');
    store.close();
  });
});

describe('the run list’s filter on the dashboard', () => {
  it('reads no request to match: it matches the about lines known, and says how many are still being worked out', () => {
    const { store, ids } = store3();
    const reads = [vi.spyOn(store, 'getCalls'), vi.spyOn(store, 'getBlob'), vi.spyOn(store, 'getJson')];
    const page = listRunsPage(store, { q: 'B-2242', known: true });
    // No about line known yet: no run matches by its order, and the page says so.
    expect(page.runs.map((r) => r.runId)).toEqual([]);
    expect(page.warming).toEqual({ done: 0, total: 3 });
    expect(runsByDay(store, { q: 'B-2242', known: true, now: NOW }).warming).toEqual({ done: 0, total: 3 });
    expect(reads.map((r) => r.mock.calls.length)).toEqual([0, 0, 0]);
    vi.restoreAllMocks();
    // What doesn't need an about line still matches: the command. The rows shown say what each was
    // about (at most a page of them: their own about lines, nothing more).
    expect(listRunsPage(store, { q: 'refund_agent', known: true }).total).toBe(3);
    // Once the warm-up has worked them out, it matches by them, and has nothing left to say.
    while (!warmRunStats(store, { budgetMs: 0, now: NOW }));
    const done = listRunsPage(store, { q: 'B-2242', known: true });
    expect(done.runs.map((r) => r.runId)).toEqual([ids[1]]);
    expect(done.warming).toBeUndefined();
    store.close();
  });

  it('sorted by spent, orders by the totals known and says the rest are warming', () => {
    const { store, ids } = store3();
    const page = listRunsPage(store, { sort: 'spent', known: true });
    expect(page.warming).toEqual({ done: 0, total: 3 });
    expect(page.runs.map((r) => r.runId).sort()).toEqual([...ids].sort());
    while (!warmRunStats(store, { budgetMs: 0, now: NOW }));
    expect(listRunsPage(store, { sort: 'spent', known: true }).warming).toBeUndefined();
    store.close();
  });
});
