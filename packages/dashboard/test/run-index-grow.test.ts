import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordBlame, Store, type CallKind } from '@shadowlap/engine';
import { blameReport, EXPECT } from '../../engine/test/fix-fixtures.js';
import { loadRunIndex } from '../src/run-index.js';
import { addRun, HOUR } from './read-model-store.js';

/**
 * The run index takes what was written into the index it has: calls added (a run recording, a
 * replay making its calls) are counted into the runs they belong to, runs written (started, ended,
 * labelled, filed) are read again as the store's log of runs written names them, and a fix changed
 * reads again which check lists each run failing; the runs touched are classified again with their
 * children. The status bar asks for the counts every two seconds, and reading every run of a big
 * store again held the server's thread 82 ms a poll while a run recorded, and 137 ms while a session
 * wrote a run a second, at 10,000 runs. What it holds must be what a whole read finds.
 */

const T = Date.parse('2026-10-20T12:00:00Z');
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => { exec(sql: string): void; close(): void } };

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

/** Works on the store's file through SQLite itself, as another program could. */
function raw(work: (db: { exec(sql: string): void }) => void): void {
  const db = new DatabaseSync(join(dir, 'shadowlap.db'));
  try {
    work(db);
  } finally {
    db.close();
  }
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

  it('takes runs started, ended, relabelled and filed, and a fix linked, into the index it has, reading only those runs', () => {
    const lost = addRun(writer, { startedAt: T - 3 * HOUR, calls: 'lll', status: 'failed' });
    const first = loadRunIndex(reader);
    // Every statement the index reads with from here: none reads every run again.
    const read: string[] = [];
    const query = reader.query.bind(reader);
    reader.query = ((sql: string, ...params: Parameters<Store['query']>[1][]) => (read.push(sql), query(sql, ...params)));
    const wholeReads = () => read.filter((sql) => /ORDER BY r\.started_at DESC/.test(sql)).length;

    // A run starts and records, and ends.
    const two = addRun(writer, { startedAt: T - HOUR, calls: 'lll', status: 'running' });
    expect(loadRunIndex(reader)).toBe(first);
    expect(first.byId.get(two)).toMatchObject({ calls: 3, status: 'running' });
    expect(first.runs.map((r) => r.runId)).toEqual([two, lost]);
    writer.endRun(two, 'completed', T);
    expect(loadRunIndex(reader)).toBe(first);
    expect(first.byId.get(two)?.status).toBe('completed');
    // A label, then blame's probes: one filed under the run it probes, then the fork it rescued the run with.
    writer.updateRunMeta(two, { labels: ['good'] });
    const probe = addRun(writer, { parent: lost, startedAt: T - 2 * HOUR, divergence: 2, calls: 'rrl', meta: { probe: { of: lost, callNo: 2, passed: true }, repeat: { group: 'b1-2', attempt: 1, of: 2 } } });
    expect(loadRunIndex(reader)).toBe(first);
    expect(first.byId.get(two)?.meta.labels).toEqual(['good']);
    expect(first.attempts.get(lost)?.map((r) => r.runId)).toEqual([probe]);
    writer.updateRunMeta(lost, { blame: { at: T, outcome: 'blamed', callNo: 2, confidence: 'high', rescuedRunId: probe, fields: {}, oracle: [], probes: [], spent: 0.1 } as never });
    loadRunIndex(reader);
    expect(first.byId.get(probe)?.rescues).toBe(lost);
    // A fix that lists the run among its failing runs: its check is what it failed.
    recordBlame(writer, { runId: lost, report: blameReport(lost), expect: EXPECT, scope: null, command: 'shadowlap blame x', title: 'issue_refund called with amount 240', checkText: 'issue_refund never called with {"amount":240}' });
    expect(loadRunIndex(reader)).toBe(first);
    expect(first.byId.get(lost)?.fixCheck).toBe('issue_refund never called with {"amount":240}');

    // All of it as a whole read finds it, and not one whole read made.
    const whole = fresh();
    expect(first.runs).toEqual(whole.runs);
    expect(first.attempts).toEqual(whole.attempts);
    expect(first.counts).toEqual(whole.counts);
    expect(wholeReads()).toBe(0);
  });

  it('reads the index whole when a run goes, when the store keeps no log of runs written, or the log has gone past what it read', () => {
    const one = addRun(writer, { startedAt: T - 2 * HOUR, calls: 'll' });
    const two = addRun(writer, { startedAt: T - HOUR, calls: 'lll' });
    const first = loadRunIndex(reader);
    writer.deleteRun(one);
    const second = loadRunIndex(reader);
    expect(second).not.toBe(first);
    expect(second.byId.has(one)).toBe(false);
    expect(second.runs).toEqual(fresh().runs);
    // The log has gone past what the index read: the oldest writes since it looked trimmed, as the log
    // trims itself to the last few thousand.
    for (const label of ['a', 'b', 'c']) writer.updateRunMeta(two, { labels: [label] });
    raw((db) => db.exec(`DELETE FROM run_changes WHERE seq < (SELECT MAX(seq) FROM run_changes)`));
    const third = loadRunIndex(reader);
    expect(third).not.toBe(second);
    expect(third.byId.get(two)?.meta.labels).toEqual(['c']);
    expect(third.runs).toEqual(fresh().runs);
  });

  it('reads the index whole on a store that keeps no log of runs written, as a build from before it leaves one', () => {
    const one = addRun(writer, { startedAt: T - 2 * HOUR, calls: 'll' });
    raw((db) => db.exec(`DROP TRIGGER run_changes_insert; DROP TRIGGER run_changes_update; DROP TRIGGER run_changes_delete; DROP TRIGGER run_changes_trim; DROP TABLE run_changes`));
    const old = Store.openReadOnly(join(dir, 'shadowlap.db'));
    try {
      const first = loadRunIndex(old);
      writer.updateRunMeta(one, { labels: ['good'] });
      const second = loadRunIndex(old);
      expect(second).not.toBe(first);
      expect(second.byId.get(one)?.meta.labels).toEqual(['good']);
    } finally {
      old.close();
    }
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
