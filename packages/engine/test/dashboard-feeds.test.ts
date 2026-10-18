import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { packRun, recordEvent, Store, unpackRun } from '../src/index.js';

/**
 * What the dashboard's feeds need from the store: events paged by time and id, write counters, and
 * packs that read as one import and do not carry who made their runs.
 */

describe('activity events paged by time and id', () => {
  it('never skips events that share a millisecond', () => {
    const store = Store.open(':memory:');
    for (let i = 0; i < 5; i++) recordEvent(store, { kind: 'normalizer.added', ref: `same ${i}`, at: 2000 });
    recordEvent(store, { kind: 'normalizer.added', ref: 'older', at: 1000 });
    const all = store.listEvents();
    expect(all.map((e) => e.at)).toEqual([2000, 2000, 2000, 2000, 2000, 1000]);
    // Newest first, then by id descending: a cursor made of the last event's time and id resumes exactly.
    const ids = all.map((e) => e.eventId);
    expect([...ids.slice(0, 5)].sort().reverse()).toEqual(ids.slice(0, 5));
    const seen: string[] = [];
    let cursor: { before: number; beforeId: string } | null = null;
    for (let page = 0; page < 10; page++) {
      const got = store.listEvents({ limit: 2, ...(cursor ?? {}) });
      seen.push(...got.map((e) => e.eventId));
      if (got.length < 2) break;
      const last = got[got.length - 1]!;
      cursor = { before: last.at, beforeId: last.eventId };
    }
    expect(seen).toEqual(ids);
    // `before` alone still means strictly older.
    expect(store.listEvents({ before: 2000 }).map((e) => e.ref)).toEqual(['older']);
    store.close();
  });

  it('keeps or leaves out kinds', () => {
    const store = Store.open(':memory:');
    recordEvent(store, { kind: 'capture.imported', ref: 'a.har', at: 3 });
    recordEvent(store, { kind: 'normalizer.added', ref: '$.id', at: 2 });
    recordEvent(store, { kind: 'blame.done', ref: 'fx-1', at: 1 });
    expect(store.listEvents({ kinds: ['capture.imported', 'blame.done'] }).map((e) => e.ref)).toEqual(['a.har', 'fx-1']);
    expect(store.listEvents({ exceptKinds: ['capture.imported'] }).map((e) => e.ref)).toEqual(['$.id', 'fx-1']);
    expect(store.listEvents({ exceptKinds: ['capture.imported'], limit: 1, before: 2 }).map((e) => e.ref)).toEqual(['fx-1']);
    store.close();
  });
});

describe('write counters', () => {
  it('go up with every write to runs and events, and calls by their newest row', () => {
    const store = Store.open(':memory:');
    const start = store.changeCounts();
    expect(start).toMatchObject({ runs: 0, events: 0, calls: 0 });
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' } });
    const afterCreate = store.changeCounts();
    expect(afterCreate.runs).toBeGreaterThan(start.runs!);
    store.updateRunMeta(run.runId, { labels: ['bug'] });
    expect(store.changeCounts().runs).toBeGreaterThan(afterCreate.runs!);
    const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: 'f'.repeat(64), occurrence: 1 };
    store.appendCallStart({ runId: run.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: null, meta: {}, at: 1 });
    expect(store.changeCounts().calls).toBeGreaterThan(0);
    recordEvent(store, { kind: 'normalizer.added' });
    expect(store.changeCounts().events).toBe(1);
    store.close();
  });
});

describe('packs', () => {
  function family(store: Store): { root: string; fork: string } {
    const root = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '.' }, meta: { author: 'dana@example.com' } });
    store.endRun(root.runId, 'completed');
    const fork = store.createRun({ mode: 'replay', parentRunId: root.runId, command: { argv: ['node', 'agent.js'], cwd: '.' }, meta: { author: 'dana@example.com', labels: ['bug'] } });
    store.endRun(fork.runId, 'completed');
    return { root: root.runId, fork: fork.runId };
  }

  it('leave out who made each run, unless asked to keep it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-pack-author-'));
    const store = Store.open(':memory:');
    try {
      const { fork } = family(store);
      packRun(store, fork, join(dir, 'shared'), { lineage: true });
      const shared = readFileSync(join(dir, 'shared', 'run.json'), 'utf8');
      expect(shared).not.toContain('dana@example.com');
      expect(JSON.parse(shared).runs[1].meta).toMatchObject({ labels: ['bug'] });
      packRun(store, fork, join(dir, 'kept'), { lineage: true, keepAuthor: true });
      expect(JSON.parse(readFileSync(join(dir, 'kept', 'run.json'), 'utf8')).runs.map((r: { meta: { author?: string } }) => r.meta.author)).toEqual(['dana@example.com', 'dana@example.com']);
      // The store keeps it either way.
      expect(store.getRun(fork)!.meta?.author).toBe('dana@example.com');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unpack with one time for every run they bring in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-pack-time-'));
    const source = Store.open(':memory:');
    const target = Store.open(':memory:');
    try {
      const { fork } = family(source);
      packRun(source, fork, join(dir, 'lineage'), { lineage: true });
      // A large pack takes a while to unpack: the clock moves on between its runs, and they still share one time.
      // Today's clock, moving: unpack refuses a time more than a day ahead of it.
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now++);
      let imported: string[];
      try {
        imported = unpackRun(target, join(dir, 'lineage')).imported;
      } finally {
        clock.mockRestore();
      }
      expect(imported).toHaveLength(2);
      const stamps = imported.map((id) => target.getRun(id)!.meta?.imported);
      expect(stamps[0]).toEqual({ at: expect.any(Number), from: 'lineage' });
      expect(stamps[1]).toEqual(stamps[0]);
    } finally {
      source.close();
      target.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
