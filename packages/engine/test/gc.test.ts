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
    expect(manifestRefs(store, manifest)).toHaveLength(2); // system and one message; the tools slot is null
    expect(store.gcBlobs()).toEqual({ removed: 0, bytes: 0 });

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
