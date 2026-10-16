import { describe, expect, it } from 'vitest';
import { loadApiRequest, manifestRefs, storeApiRequest } from '../src/manifest.js';
import { Store } from '../src/store.js';
import type { RunRecord } from '../src/types.js';

function start(store: Store, run: RunRecord, callNo: number, kind: 'tool' | 'api', requestRef: string) {
  store.appendCallStart({ runId: run.runId, callNo, kind, name: kind === 'api' ? 'POST /v1/messages' : 't', fingerprint: `f${callNo}`, occurrence: 1, origin: 'live', effect: null, requestRef, meta: {}, at: 1 });
}

describe('gcBlobs', () => {
  it('removes only blobs no remaining call references, following request manifests', () => {
    const store = Store.open(':memory:');
    const doomed = store.createRun({ mode: 'record', command: { argv: ['x'], cwd: '/' } });
    const kept = store.createRun({ mode: 'record', command: { argv: ['x'], cwd: '/' } });
    const only = store.putJson({ only: true });
    const shared = store.putJson({ shared: true });
    const manifest = storeApiRequest(store, { model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    const doomedManifest = storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: 'bye' }] });
    start(store, doomed, 1, 'tool', only);
    start(store, doomed, 2, 'tool', shared);
    start(store, doomed, 3, 'api', doomedManifest);
    start(store, kept, 1, 'tool', shared);
    start(store, kept, 2, 'api', manifest);
    // Finished recordings: while a run is still recording, gcBlobs collects nothing.
    store.endRun(doomed.runId, 'completed');
    store.endRun(kept.runId, 'completed');
    expect(manifestRefs(store, manifest)).toHaveLength(2); // system and one message; the tools slot is null
    expect(store.gcBlobs()).toEqual({ removed: 0, bytes: 0, stored: 0, recording: [] });

    store.deleteRun(doomed.runId);
    const gc = store.gcBlobs();
    // `only`, the doomed manifest and its one message blob ("bye"); `shared` and the kept request survive.
    expect(gc.removed).toBe(3);
    expect(gc.bytes).toBeGreaterThan(0);
    expect(store.getBlob(only)).toBeNull();
    expect(store.getJson(shared)).toEqual({ shared: true });
    expect(loadApiRequest(store, manifest)).toEqual({ model: 'm', system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    expect(store.countCalls(doomed.runId)).toBe(0);
    expect(store.getRun(doomed.runId)).toBeNull();
    store.vacuum();
    store.close();
  });
});

describe('deletionHold', () => {
  it('holds a run in progress, and the run a replay in progress serves from, until they end', () => {
    const store = Store.open(':memory:');
    const command = { argv: ['node', 'agent.js'], cwd: '/' };
    const rec = store.createRun({ mode: 'record', command });
    expect(store.deletionHold(rec.runId)).toBe('still recording');
    store.endRun(rec.runId, 'completed');
    expect(store.deletionHold(rec.runId)).toBeNull();
    const replay = store.createRun({ mode: 'replay', parentRunId: rec.runId, command });
    expect(store.deletionHold(replay.runId)).toBe('still running');
    expect(store.deletionHold(rec.runId)).toBe('a replay of it is still running');
    store.endRun(replay.runId, 'completed');
    expect(store.deletionHold(rec.runId)).toBeNull();
    // What counts as in progress is what recordingRuns says: the caller may pass the list it has.
    const other = store.createRun({ mode: 'record', command });
    expect(store.deletionHold(other.runId, [])).toBeNull();
    store.close();
  });
});
