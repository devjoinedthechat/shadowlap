import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };

/** A view of the store, as redact.ts and run-offers.ts make one: the store with one method replaced. */
function viewOf<K extends keyof Store>(store: Store, name: K, method: Store[K]): Store {
  return Object.create(store, { [name]: { value: method } }) as Store;
}

describe('Store, made of parts', () => {
  it('calls its own methods through the store, so a view that replaces one is what the others call', () => {
    const store = Store.open(':memory:');
    const hash = store.putJson({ hello: 'world' });

    // previewRedaction counts what it reads this way: getJson reads through the view's getBlob.
    const read: string[] = [];
    const counting = viewOf(store, 'getBlob', (h: string) => {
      read.push(h);
      return store.getBlob(h);
    });
    expect(counting.getJson(hash)).toEqual({ hello: 'world' });
    expect(read).toEqual([hash]);

    // putJson writes through the view's putBlob.
    const written: number[] = [];
    const writing = viewOf(store, 'putBlob', (bytes: Uint8Array) => {
      written.push(bytes.length);
      return store.putBlob(bytes);
    });
    writing.putJson({ n: 1 });
    expect(written).toEqual([7]);

    // findRun reads the run through the view's getRun, as run-offers' view of a run shown interrupted is read.
    const run = store.createRun({ mode: 'record', command: cmd });
    store.endRun(run.runId, 'completed');
    const shown = viewOf(store, 'getRun', (id: string) => {
      const got = store.getRun(id);
      return got && { ...got, status: 'failed' };
    });
    expect(shown.findRun(run.runId)?.status).toBe('failed');
    store.close();
  });

  it('calls another part through the store too: a deletion and gc ask the view which runs are recording', () => {
    const store = Store.open(':memory:');
    const run = store.createRun({ mode: 'record', command: cmd });
    store.endRun(run.runId, 'completed');
    const recording = viewOf(store, 'recordingRuns', () => ({ live: [{ run, lastAt: Date.now() }], abandoned: [] }));
    expect(store.deletionHold(run.runId)).toBeNull();
    expect(recording.deletionHold(run.runId)).toBe('still recording');
    expect(recording.gcBlobs().recording).toEqual([run.runId]);
    store.close();
  });

  it('runs a part’s writes in the transaction the store is asked for', () => {
    const store = Store.open(':memory:');
    const modes: string[] = [];
    const watched = viewOf(store, 'transaction', <T>(fn: () => T, mode: 'deferred' | 'immediate' = 'immediate'): T => {
      modes.push(mode);
      return store.transaction(fn, mode);
    });
    watched.addTeamBlobs('s3://bucket/project', ['a', 'b']);
    expect(modes).toEqual(['immediate']);
    expect([...store.knownTeamBlobs('s3://bucket/project', ['a', 'b', 'c'])]).toEqual(['a', 'b']);
    store.close();
  });

  it('has each of its methods once, as a class method is defined', () => {
    const methods = Reflect.ownKeys(Store.prototype).filter((k) => k !== 'constructor');
    expect(methods.length).toBeGreaterThan(120);
    for (const key of methods) {
      const d = Object.getOwnPropertyDescriptor(Store.prototype, key)!;
      expect({ key, type: typeof d.value, enumerable: d.enumerable, writable: d.writable, configurable: d.configurable }).toEqual({ key, type: 'function', enumerable: false, writable: true, configurable: true });
    }
  });
});
