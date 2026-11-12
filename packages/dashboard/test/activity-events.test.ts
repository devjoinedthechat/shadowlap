import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordEvent, Store } from '@shadowlap/engine';
import { activity } from '../src/activity.js';

/** The features' own events in the activity feed (activity-events.ts): a preview and a migration by how they came out. */

let store: Store;
beforeEach(() => {
  store = Store.open(':memory:');
});
afterEach(() => store.close());

const textAt = (at: number) => activity(store, { limit: 50 }).items.find((i) => i.at === at)?.text;

describe('a preview and a migration in the feed', () => {
  it('names a preview, and says why one settled nothing, in the engine’s words', () => {
    recordEvent(store, { kind: 'decisions.done', ref: 'dc-1', data: { change: 'the model claude-haiku-4-5', name: 'Model switch to claude-haiku-4-5', runs: 7, flagged: 2, spent: 0.4, why: null, exit: 0 }, at: 1_000 });
    recordEvent(store, { kind: 'decisions.done', ref: 'dc-2', data: { change: 'temperature=0', name: 'Field change to temperature=0', runs: 7, flagged: 0, spent: 0.2, why: '1 run could not be asked', exit: 3 }, at: 2_000 });
    // Kept before events had a name: by its change.
    recordEvent(store, { kind: 'decisions.done', ref: 'dc-3', data: { change: 'the model claude-haiku-4-5', runs: 1, flagged: 0, spent: 0 }, at: 3_000 });
    recordEvent(store, { kind: 'migrate.done', ref: 'mg-1', data: { change: 'the model claude-sonnet-5-5', name: 'claude-sonnet-4-5 → claude-sonnet-5-5', runs: 3, flagged: 1, spent: 1, why: 'verify did not settle every run it took', exit: 3 }, at: 4_000 });
    recordEvent(store, { kind: 'migrate.done', ref: 'mg-2', data: { change: 'the model claude-sonnet-5-5', runs: 3, flagged: 1, spent: 1, why: null, exit: 0 }, at: 5_000 });
    expect(textAt(1_000)).toBe('Previewed model switch to claude-haiku-4-5 on 7 runs · 2 with a write, stop or judged change');
    expect(textAt(2_000)).toBe('Preview inconclusive · field change to temperature=0 on 7 runs · 1 run could not be asked');
    // In the fork's shape, amber when it settled nothing.
    expect(activity(store, { limit: 50 }).items.filter((i) => i.kind === 'fork').map((i) => [i.at, i.outcome ?? null])).toEqual([[5_000, null], [4_000, 'warn'], [3_000, null], [2_000, 'warn'], [1_000, null]]);
    expect(textAt(3_000)).toBe('Previewed the model claude-haiku-4-5 on 1 run');
    expect(textAt(4_000)).toBe('Migration inconclusive · the model claude-sonnet-5-5 on 3 runs · verify did not settle every run it took');
    expect(textAt(5_000)).toBe('Migration previewed: the model claude-sonnet-5-5 on 3 runs · 1 with a write, stop or judged change');
  });

  it('opens a preview at its session on its tab under Changes, settled or not, and a migration at its run', () => {
    const id = 'dc-01M5000000000000000000000A';
    recordEvent(store, { kind: 'decisions.done', ref: id, data: { change: 'temperature=0', runs: 2, flagged: 1, why: null }, at: 1_000 });
    recordEvent(store, { kind: 'decisions.done', ref: id, data: { change: 'temperature=0', runs: 2, flagged: 0, why: '1 run could not be asked' }, at: 2_000 });
    // A ref that is no session id opens nothing of its own.
    recordEvent(store, { kind: 'decisions.done', ref: 'not-a-session', data: { change: 'temperature=0', runs: 1, flagged: 0 }, at: 3_000 });
    recordEvent(store, { kind: 'migrate.done', ref: 'mg-01M5000000000000000000000B', runId: 'run-1', data: { change: 'the model gpt-5-mini', runs: 1, flagged: 0, why: null }, at: 4_000 });
    const hrefs = new Map(activity(store, { limit: 50 }).items.map((i) => [i.at, i.href ?? null]));
    expect([1_000, 2_000, 3_000, 4_000].map((at) => hrefs.get(at))).toEqual([`#/changes/decisions/${id}`, `#/changes/decisions/${id}`, null, '#/run/run-1']);
  });
});
