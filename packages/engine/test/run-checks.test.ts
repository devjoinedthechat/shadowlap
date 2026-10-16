import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordingsOfRun, Store, testsEntryFor } from '../src/index.js';
import { makeRun } from './fix-fixtures.js';

// The tests entry a run is judged by when it was given no --expect: the CLI's replays and the
// dashboard's Run blame both find it here.

describe('the recordings a run replays', () => {
  it('walks the run and its ancestors, nearest first: the golden a test replayed, then the pack it came from', () => {
    const store = Store.open(':memory:');
    const pack = makeRun(store, { status: 'completed', meta: { imported: { at: 1, from: 'refund-over-limit' } } });
    const tested = makeRun(store, { mode: 'replay', parent: pack, status: 'completed', meta: { test: { golden: 'goldens/refund-over-limit', session: 's1' } } });
    const replay = makeRun(store, { mode: 'replay', parent: tested, status: 'failed' });
    expect(recordingsOfRun(store, store.getRun(replay)!)).toEqual(['goldens/refund-over-limit', 'refund-over-limit']);
    expect(recordingsOfRun(store, store.getRun(pack)!)).toEqual(['refund-over-limit']);
    expect(recordingsOfRun(store, store.getRun(makeRun(store, {}))!)).toEqual([]);
    store.close();
  });
});

describe('a recording’s entry under tests', () => {
  const project = join('/work', 'agent');
  const entries = [{ recording: 'goldens/refund-*' }, { recording: 'goldens/refund-twice' }, { recording: './goldens/email/' }];

  it('takes an exact path over a pattern, wherever the pattern comes', () => {
    expect(testsEntryFor(entries, 'goldens/refund-twice', project)).toBe(entries[1]);
    expect(testsEntryFor(entries, 'goldens/refund-once/', project)).toBe(entries[0]);
    expect(testsEntryFor(entries, 'goldens/email', project)).toBe(entries[2]);
    expect(testsEntryFor(entries, join(project, 'goldens', 'email'), project)).toBe(entries[2]);
  });

  it('matches a pattern within the last part only', () => {
    expect(testsEntryFor(entries, 'goldens/refund-x/inner', project)).toBeNull();
    expect(testsEntryFor(entries, 'other/refund-once', project)).toBeNull();
    expect(testsEntryFor([], 'goldens/refund-once', project)).toBeNull();
  });
});
