import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * A disk that fills mid-write. SQLite rolls the whole transaction back by itself then, so what the
 * store reports must be that error ("database or disk is full", 13), not the "no transaction is
 * active" its own ROLLBACK would meet afterwards: the sidecar logs what it is told, and keeps it in
 * the error end that stands in for a call it could not write.
 */

interface Connection {
  exec(sql: string): void;
  prepare(sql: string): { get(): Record<string, unknown> | undefined };
  readonly isTransaction?: boolean;
}

const connection = (store: Store) => (store as unknown as { db: Connection }).db;

/** Leaves the store room for `pages` more pages, as a disk with that much space left does. */
function room(store: Store, pages: number | null): void {
  const db = connection(store);
  db.exec(`PRAGMA max_page_count = ${pages === null ? 1_073_741_823 : Number(db.prepare('PRAGMA page_count').get()?.page_count) + pages}`);
}

function thrown(fn: () => unknown): { message: string; errcode: unknown } {
  try {
    fn();
  } catch (err) {
    return { message: (err as Error).message, errcode: (err as { errcode?: unknown }).errcode };
  }
  throw new Error('it did not throw');
}

const FULL = { message: 'database or disk is full', errcode: 13 };

describe('a store the disk fills under', () => {
  it('says the disk is full when a write in a transaction fills it', () => {
    const store = Store.open(':memory:');
    const kept = store.putJson({ before: true });
    room(store, 2);
    const write = () => {
      for (let i = 0; i < 100; i++) store.putBlob(randomBytes(4096));
    };
    expect(thrown(() => store.transaction(write))).toEqual(FULL);
    // The sidecar writes each call through tryWrite.
    expect(thrown(() => store.tryWrite(write, 20))).toEqual(FULL);
    expect(connection(store).isTransaction).toBe(false);
    room(store, null);
    // Nothing of either write is left, what was there before is, and the next write is one of its own.
    expect(store.getJson(kept)).toEqual({ before: true });
    expect(store.transaction(() => store.putJson({ after: true }))).toMatch(/^[0-9a-f]{64}$/);
    store.close();
  });

  it('says the disk is full when deleting a run fills it, and keeps the run whole', () => {
    // Taking a run's documents out of the full-text index writes to the index, so it takes room.
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: { argv: ['node', 'agent.js'], cwd: '/tmp' } });
    store.endRun(run.runId, 'completed');
    const text = () => Array.from({ length: 400 }, () => randomBytes(5).toString('hex')).join(' ');
    store.replaceSearchDocs(run.runId, 50, 'completed', Array.from({ length: 50 }, (_, i) => ({ callNo: i + 1, field: 'request', text: text() })));
    room(store, 0);
    expect(thrown(() => store.deleteRun(run.runId))).toEqual(FULL);
    expect(connection(store).isTransaction).toBe(false);
    room(store, null);
    expect(store.getRun(run.runId)?.runId).toBe(run.runId);
    expect(store.searchState(run.runId)).toEqual({ calls: 50, status: 'completed', progress: null });
    store.deleteRun(run.runId);
    expect(store.getRun(run.runId)).toBeNull();
    store.close();
  });
});
