import { describe, expect, it } from 'vitest';
import { compareRuns, formatComparison } from '../src/compare.js';
import { Store } from '../src/store.js';
import type { CallKind, RunRecord } from '../src/types.js';

function addCall(store: Store, run: RunRecord, callNo: number, kind: CallKind, name: string, args: unknown, result: unknown, fingerprint = JSON.stringify(args)) {
  const identity = { kind, name, fingerprint, occurrence: 1 };
  store.appendCallStart({ runId: run.runId, callNo, ...identity, origin: 'live', effect: kind === 'tool' ? 'read' : null, requestRef: store.putJson({ args }), meta: {}, at: callNo });
  store.appendCallEnd(identity, { runId: run.runId, callNo, attempt: 0, responseRef: store.putJson({ result }), outcome: 'ok', meta: {}, at: callNo + 1 });
}

describe('compareRuns', () => {
  it('finds the first request difference, response differences and the longer tail', () => {
    const store = Store.open(':memory:');
    const a = store.createRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const b = store.createRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    // 1: identical. 2: same request, different result. 3: different request. 4: only in b.
    addCall(store, a, 1, 'tool', 'read_file', { path: 'a.md' }, 'one');
    addCall(store, b, 1, 'tool', 'read_file', { path: 'a.md' }, 'one');
    addCall(store, a, 2, 'tool', 'search', { q: 'x' }, { hits: 1 });
    addCall(store, b, 2, 'tool', 'search', { q: 'x' }, { hits: 2 });
    addCall(store, a, 3, 'tool', 'fetch', { url: 'https://e.com/2026-09-15' }, 'p');
    addCall(store, b, 3, 'tool', 'fetch', { url: 'https://e.com/2026-09-16' }, 'p');
    addCall(store, b, 4, 'tool', 'send', { to: 't' }, 'ok');

    const c = compareRuns(store, a, store.getCalls(a.runId), b, store.getCalls(b.runId));
    expect(c.identicalPrefix).toBe(1);
    expect(c.firstRequestDifference?.callNo).toBe(3);
    expect(c.firstRequestDifference?.diff?.[0]).toMatchObject({ path: '$.args.url', op: 'changed' });
    expect(c.firstRequestDifference?.hints?.[0]?.message).toMatch(/date/);
    expect(c.responseDifferences).toHaveLength(1);
    expect(c.responseDifferences[0]).toMatchObject({ callNo: 2, name: 'search' });
    expect(c.responseDifferences[0]?.detail).toMatch(/\$\.result\.hits/);
    // From call 3 on, the runs are not paired: each has its own course.
    expect(c.after).toEqual({ a: { calls: 1, modelCalls: 0, path: ['fetch'], answer: null }, b: { calls: 2, modelCalls: 0, path: ['fetch', 'send'], answer: null } });
    expect([c.onlyInA, c.onlyInB]).toEqual([0, 0]);

    const text = formatComparison(c);
    expect(text).toContain('calls 1–1: same requests, same responses');
    expect(text).toContain('call 3 (tool fetch): first request that differs');
    expect(text).toContain('#2 tool search');
    expect(text).toContain('From there each run goes its own way:');
    expect(text).toMatch(/2 calls, 0 to the model · fetch → send/);
    store.close();
  });

  it('counts the longer tail only for runs whose requests never differed', () => {
    const store = Store.open(':memory:');
    const a = store.createRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const b = store.createRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    addCall(store, a, 1, 'tool', 'read_file', { path: 'a.md' }, 'one');
    addCall(store, b, 1, 'tool', 'read_file', { path: 'a.md' }, 'one');
    addCall(store, b, 2, 'tool', 'send', { to: 't' }, 'ok');
    const c = compareRuns(store, a, store.getCalls(a.runId), b, store.getCalls(b.runId));
    expect(c).toMatchObject({ firstRequestDifference: null, after: null, onlyInA: 0, onlyInB: 1 });
    expect(formatComparison(c)).toContain('continues for 1 more call');
    store.close();
  });

  it('reports identical runs as identical', () => {
    const store = Store.open(':memory:');
    const a = store.createRun({ mode: 'record', command: { argv: ['agent'], cwd: '/' } });
    const b = store.createRun({ mode: 'replay', parentRunId: a.runId, command: { argv: ['agent'], cwd: '/' } });
    addCall(store, a, 1, 'tool', 'read_file', { path: 'a.md' }, 'one');
    addCall(store, b, 1, 'tool', 'read_file', { path: 'a.md' }, 'one');
    const c = compareRuns(store, a, store.getCalls(a.runId), b, store.getCalls(b.runId));
    expect(c).toMatchObject({ identicalPrefix: 1, firstRequestDifference: null, after: null, responseDifferences: [], onlyInA: 0, onlyInB: 0 });
    expect(formatComparison(c)).toContain('identical');
    store.close();
  });
});
