import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store, storeView } from '../src/store.js';

/**
 * Two commands change one row's JSON at once: the dashboard labels a run as the sidecar ending it
 * keeps its preloads, a pull stamps the store's record as a push does. Each reads the row, merges
 * its change in and writes it back; another command's change made in between must not be written
 * over. A view of the store whose read lets the other command write first puts that in between.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** This store and another command's connection to the same file, which doesn't wait for the lock. */
function twoCommands(): { store: Store; other: Store } {
  const dir = mkdtempSync(join(tmpdir(), 'sl-merges-'));
  dirs.push(dir);
  const path = join(dir, 'shadowlap.db');
  const store = Store.open(path);
  const other = Store.open(path);
  (other as unknown as { db: { exec(sql: string): void } }).db.exec('PRAGMA busy_timeout = 0');
  return { store, other };
}

/** The store, with `meanwhile` run (and what it throws kept) after each read of the method named. */
function between<K extends 'getRun' | 'teamSync'>(store: Store, name: K, meanwhile: () => void): { view: Store; refused: unknown[] } {
  const refused: unknown[] = [];
  const read = store[name].bind(store) as (...args: unknown[]) => unknown;
  const view = storeView(store, {
    [name]: (...args: unknown[]) => {
      const got = read(...args);
      try {
        meanwhile();
      } catch (err) {
        refused.push(err);
      }
      return got;
    },
  });
  return { view, refused };
}

describe('a change merged into a row another command changes at once', () => {
  it('keeps the other command’s change to a run’s metadata', () => {
    const { store, other } = twoCommands();
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
    const label = () => other.updateRunMeta(run.runId, { labels: ['good'] });
    const { view, refused } = between(store, 'getRun', label);
    const note = { callNo: null, text: 'checked', at: 1 };
    view.updateRunMeta(run.runId, { notes: [note] });
    // Kept out while the merge was made, the other command writes once it is done, as one waiting for the lock does.
    if (refused.length) label();
    expect(store.getRun(run.runId)?.meta).toEqual({ notes: [note], labels: ['good'] });
    expect(refused.map((e) => (e as { errcode?: number }).errcode)).toEqual([5]);
    other.close();
    store.close();
  });

  it('keeps the other command’s stamp on the team store’s record', () => {
    const { store, other } = twoCommands();
    const remote = 's3://bucket/project';
    store.setTeamSync(remote, { data: { setup: { stage: 'bucket' } } });
    const pulled = () => other.setTeamSync(remote, { pulledAt: 2_000 });
    const { view, refused } = between(store, 'teamSync', pulled);
    view.setTeamSync(remote, { pushedAt: 1_000 });
    if (refused.length) pulled();
    expect(store.teamSync(remote)).toEqual({ pushedAt: 1_000, pulledAt: 2_000, data: { setup: { stage: 'bucket' } } });
    expect(refused.map((e) => (e as { errcode?: number }).errcode)).toEqual([5]);
    other.close();
    store.close();
  });

  it('merges inside a transaction the caller has open, as part of it', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
    store.transaction(() => {
      store.updateRunMeta(run.runId, { labels: ['a'] });
      store.setTeamSync('s3://b/p', { pushedAt: 5 });
    });
    expect(() =>
      store.transaction(() => {
        store.updateRunMeta(run.runId, { labels: ['b'] });
        throw new Error('the caller gave up');
      }),
    ).toThrow('the caller gave up');
    expect(store.getRun(run.runId)?.meta?.labels).toEqual(['a']);
    expect(store.teamSync('s3://b/p')?.pushedAt).toBe(5);
    expect(() => store.updateRunMeta('NOPE', { labels: [] })).toThrow('unknown run NOPE');
    store.close();
  });
});
