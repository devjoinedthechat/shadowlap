import { describe, expect, it } from 'vitest';
import { recordEvent, Store } from '../src/index.js';

/** What the dashboard's feeds need from the store: events paged by time and id, and write counters. */

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
});

describe('write counters', () => {
  it('go up with every write to runs and events, from any connection, and calls by their newest row', () => {
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
