import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { StorePart } from '../src/store/core.js';

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

  it('has the methods of every part in store/ and nothing else but its own, from the one list of parts', async () => {
    const dir = new URL('../src/store/', import.meta.url);
    const parts: Array<{ name: string; prototype: object }> = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      for (const value of Object.values((await import(new URL(file, dir).href)) as Record<string, unknown>)) {
        if (typeof value === 'function' && Object.getPrototypeOf(value.prototype) === StorePart.prototype) parts.push(value);
      }
    }
    expect(parts.length).toBeGreaterThan(10);
    // A part left out of the list would have none of its methods here (and none in the interface,
    // which the list makes too), and its file nothing to call it. A part's onRunDeleted is the
    // store's to call (forgetRun), not a caller's.
    const fromParts = new Map<PropertyKey, unknown>();
    for (const part of parts) for (const key of Reflect.ownKeys(part.prototype)) if (key !== 'constructor' && key !== 'onRunDeleted') fromParts.set(key, Reflect.get(part.prototype, key));
    const own = ['constructor', 'schemaVersion', 'close', 'transaction', 'forgetRun'];
    const onStore = Reflect.ownKeys(Store.prototype).filter((k) => !own.includes(String(k)));
    expect(onStore.map(String).sort()).toEqual([...fromParts.keys()].map(String).sort());
    for (const key of onStore) expect(Reflect.get(Store.prototype, key), String(key)).toBe(fromParts.get(key));
  });

  it('writes each table from the part that keeps it, as its SQL reads', () => {
    const dir = new URL('../src/store/', import.meta.url);
    const writers = new Map<string, Set<string>>();
    // schema.ts makes every table; core.ts prepares the recording core's statements (store/recording.ts).
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'schema.ts')) {
      for (const [, table] of readFileSync(new URL(file, dir), 'utf8').matchAll(/\b(?:INSERT (?:OR [A-Z]+ )?INTO|UPDATE|DELETE FROM)\s+([a-z_]+)\b/g)) {
        const of = writers.get(table) ?? new Set<string>();
        writers.set(table, of.add(file === 'core.ts' ? 'recording.ts' : file));
      }
    }
    expect(writers.size).toBeGreaterThan(30);
    // gc (store/cleanup.ts) deletes what no call references any more: blobs, and what was worked out of them.
    const collected = (table: string, parts: Set<string>) => ['blobs', 'fingerprint_cache'].includes(table) && parts.size === 2 && parts.has('cleanup.ts');
    // Another part's rows of a run go by its onRunDeleted, which deleteRun has the store call.
    expect([...writers].filter(([table, parts]) => parts.size > 1 && !collected(table, parts)).map(([table, parts]) => `${table}: ${[...parts].sort().join(', ')}`)).toEqual([]);
  });

  it('has each part delete what it keeps of a run deleted, in the deletion’s transaction', () => {
    const store = Store.open(':memory:');
    const db = (store as unknown as { db: { exec(sql: string): void } }).db;
    const remote = 's3://bucket/project';
    const [gone, kept] = [1, 2].map(() => {
      const run = store.createRun({ mode: 'record', command: cmd });
      store.endRun(run.runId, 'completed');
      store.replaceSearchDocs(run.runId, 1, 'completed', [{ callNo: 1, field: 'arguments', text: 'lookup_order wombat' }]);
      store.setTeamRun(remote, { runId: run.runId, state: 'queued', at: 1, base: null, baseHash: null, remoteHash: null, entry: null });
      store.setTeamRun(`${remote}/other`, { runId: run.runId, state: 'pushed', at: 1, base: null, baseHash: null, remoteHash: 'h', entry: null });
      return run.runId;
    }) as [string, string];
    const held = (runId: string) => ({ run: store.getRun(runId) !== null, search: store.searchState(runId) !== null, found: store.searchDocs('wombat', 10).some((h) => h.runId === runId), queued: store.teamRun(remote, runId) !== null, pushed: store.teamRun(`${remote}/other`, runId) !== null });
    const all = { run: true, search: true, found: true, queued: true, pushed: true };

    // One part failing takes the deletion back whole: the run and what every part keeps of it stay.
    db.exec(`CREATE TEMP TRIGGER refuse_team BEFORE DELETE ON team_runs BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`);
    expect(() => store.deleteRun(gone)).toThrow('database or disk is full');
    expect(held(gone)).toEqual(all);
    db.exec('DROP TRIGGER refuse_team');

    store.deleteRun(gone);
    // The search index's and the queued push go, by their parts' own hooks; a push made stays, so a pull doesn't bring the run back.
    expect(held(gone)).toEqual({ run: false, search: false, found: false, queued: false, pushed: true });
    expect(held(kept)).toEqual(all);
    store.close();
  });
});
