import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store, type CallKind } from '@shadowlap/engine';
import { loadRunIndex } from '../src/run-index.js';
import { addRun, HOUR } from './read-model-store.js';

/**
 * The run index is read whole when a run, a fix or a link changes, and when only calls are added
 * (a run recording, a replay making its calls) what they add is counted into the runs they belong
 * to, which are classified again with their children: the status bar asks for the counts every two
 * seconds while a run records, and reading every run of a big store again for each call held the
 * server's thread for 82 ms a poll at 10,000 runs. What it counts must be what a whole read finds.
 */

const T = Date.parse('2026-10-20T12:00:00Z');

let dir: string;
let writer: Store;
let reader: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sl-run-index-'));
  writer = Store.open(join(dir, 'shadowlap.db'));
  reader = Store.openReadOnly(join(dir, 'shadowlap.db'));
});

afterEach(() => {
  reader.close();
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The next call of a run, started and, unless `open`, answered: as the sidecar writes them. */
function call(runId: string, o: { kind?: CallKind; scope?: string; outcome?: 'ok' | 'error'; endMeta?: Record<string, unknown>; open?: boolean } = {}): number {
  const callNo = writer.countCalls(runId) + 1;
  const kind = o.kind ?? 'api';
  const identity = { kind, name: kind === 'api' ? 'POST /v1/messages' : 'lookup_order', fingerprint: `g${callNo}`, occurrence: 1 };
  writer.appendCallStart({ runId, callNo, ...identity, origin: 'live', effect: kind === 'tool' ? 'read' : null, requestRef: null, meta: o.scope ? { scope: o.scope } : {}, at: T + callNo * 10 });
  if (!o.open) writer.appendCallEnd(identity, { runId, callNo, attempt: 0, responseRef: null, outcome: o.outcome ?? 'ok', meta: { latencyMs: 5, ...(o.endMeta ?? {}) }, at: T + callNo * 10 + 5 });
  return callNo;
}

/** The index as a connection that never read it reads it: whole. */
function fresh(): ReturnType<typeof loadRunIndex> {
  const other = Store.openReadOnly(join(dir, 'shadowlap.db'));
  try {
    return loadRunIndex(other);
  } finally {
    other.close();
  }
}

describe('the run index while calls are added', () => {
  it('counts what a recording adds into the index it has, as a whole read would, without reading every run again', () => {
    const done = addRun(writer, { startedAt: T - 2 * HOUR, calls: 'llll' });
    const recording = addRun(writer, { startedAt: T - HOUR, calls: 'll', status: 'running' });
    const replay = addRun(writer, { parent: done, startedAt: T - HOUR / 2, calls: 'rr', status: 'running' });
    const before = loadRunIndex(reader);
    expect(before.byId.get(recording)).toMatchObject({ calls: 2, agentCalls: 2, status: 'running' });

    // The recording makes three calls, one a judge check's; the replay one; a call starts unanswered.
    call(recording);
    call(recording, { kind: 'tool' });
    call(recording, { scope: 'shadowlap:judge' });
    call(replay);
    call(recording, { open: true });
    const after = loadRunIndex(reader);
    // The same index, counted on: not read again.
    expect(after).toBe(before);
    expect(after.byId.get(recording)).toMatchObject({ calls: 6, agentCalls: 5 });
    expect(after.byId.get(replay)).toMatchObject({ calls: 3, agentCalls: 3 });
    expect(after.runs).toEqual(fresh().runs);
    expect(after.counts).toEqual(fresh().counts);
  });

  it('classifies a run whose count moved again, and the runs replayed from it, as a whole read does', () => {
    // A recording that failed, and a replay of it that failed with fewer calls: a replay, not a clean
    // one, until it has made every call the recording made.
    const lost = addRun(writer, { startedAt: T - 2 * HOUR, calls: 'lll', status: 'failed' });
    const again = addRun(writer, { parent: lost, startedAt: T - HOUR, calls: 'rr', status: 'failed' });
    const index = loadRunIndex(reader);
    expect(index.byId.get(again)).toMatchObject({ kind: 'replay', label: 'replay' });
    call(again);
    expect(loadRunIndex(reader)).toBe(index);
    expect(index.byId.get(again)).toMatchObject({ calls: 3, kind: 'clean', label: 'clean replay' });
    expect(index.runs).toEqual(fresh().runs);
    // Its parent gains a call (an answer written late): the replay falls short of it again.
    call(lost);
    expect(loadRunIndex(reader)).toBe(index);
    expect(index.byId.get(again)).toMatchObject({ kind: 'replay' });
    expect(index.runs).toEqual(fresh().runs);
  });

  it('counts an injected failure and a call refused offline into the outcome, as a whole read does', () => {
    const failed = addRun(writer, { startedAt: T - 2 * HOUR, calls: 'll', status: 'failed' });
    const golden = addRun(writer, { startedAt: T - 3 * HOUR, calls: 'll' });
    const test = addRun(writer, { parent: golden, startedAt: T - HOUR, calls: 'rr', status: 'failed', divergence: 2, meta: { test: { golden: 'refund', session: 'ts-1' } } });
    const index = loadRunIndex(reader);
    expect(index.byId.get(failed)?.injected).toBe(false);
    expect(index.byId.get(test)?.offline).toBe(false);
    call(failed, { outcome: 'error', endMeta: { injected: true, status: 529 } });
    call(test, { outcome: 'error', endMeta: { offline: true, status: 503 } });
    expect(loadRunIndex(reader)).toBe(index);
    expect(index.byId.get(failed)?.injected).toBe(true);
    expect(index.byId.get(test)?.offline).toBe(true);
    expect(index.runs).toEqual(fresh().runs);
  });

  it('reads the index whole when a run is added, changes or goes, or a fix changes', () => {
    const one = addRun(writer, { startedAt: T - 2 * HOUR, calls: 'll' });
    const first = loadRunIndex(reader);
    const two = addRun(writer, { startedAt: T - HOUR, calls: 'lll', status: 'running' });
    const second = loadRunIndex(reader);
    expect(second).not.toBe(first);
    expect(second.byId.get(two)?.calls).toBe(3);
    writer.endRun(two, 'completed', T);
    const third = loadRunIndex(reader);
    expect(third).not.toBe(second);
    expect(third.byId.get(two)?.status).toBe('completed');
    writer.deleteRun(one);
    const fourth = loadRunIndex(reader);
    expect(fourth).not.toBe(third);
    expect(fourth.byId.has(one)).toBe(false);
    expect(fourth.runs).toEqual(fresh().runs);
  });

  it('counts the calls of a run added while it read the index once the next look reads it whole', () => {
    loadRunIndex(reader);
    // A run created and recording at once: its counter moved, so its calls are never counted twice.
    const run = addRun(writer, { startedAt: T, calls: 'll', status: 'running' });
    call(run);
    expect(loadRunIndex(reader).byId.get(run)?.calls).toBe(3);
    call(run);
    expect(loadRunIndex(reader).byId.get(run)?.calls).toBe(4);
    expect(loadRunIndex(reader).runs).toEqual(fresh().runs);
  });
});
