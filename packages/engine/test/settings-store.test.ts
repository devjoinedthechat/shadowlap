import { describe, expect, it } from 'vitest';
import { calibrationTarget } from '../src/calibrate.js';
import { storeApiRequest } from '../src/manifest.js';
import { NO_COMMAND } from '../src/pack.js';
import { Store } from '../src/store.js';
import type { Effect, RunMeta, RunStatus } from '../src/types.js';

const cmd = { argv: ['node', 'agent.js'], cwd: '/tmp' };

function run(store: Store, o: { mode?: 'record' | 'replay'; status?: RunStatus | 'running'; at: number; meta?: RunMeta; argv?: string[] }) {
  const r = store.createRun({ mode: o.mode ?? 'record', command: o.argv ? { argv: o.argv, cwd: '/tmp' } : cmd, startedAt: o.at, ...(o.meta ? { meta: o.meta } : {}) });
  if (o.status && o.status !== 'running') store.endRun(r.runId, o.status, o.at + 1);
  return r;
}

function tool(store: Store, runId: string, callNo: number, name: string, effect: Effect | null, at: number, requestRef: string | null = null) {
  store.appendCallStart({ runId, callNo, kind: 'tool', name, fingerprint: `${name}${callNo}`, occurrence: 1, origin: 'live', effect, requestRef, meta: {}, at });
}

describe('calibrationTarget', () => {
  it('takes the setup run, else the newest finished recording made here, else none', () => {
    const store = Store.open(':memory:');
    expect(calibrationTarget(store)).toBeNull();
    const setup = run(store, { status: 'completed', at: 1000 });
    const failed = run(store, { status: 'failed', at: 2000 });
    run(store, { status: 'crashed', at: 3000 });
    run(store, { status: 'running', at: 4000 });
    run(store, { mode: 'replay', status: 'completed', at: 5000 });
    run(store, { status: 'completed', at: 6000, meta: { imported: { at: 6000, from: 'goldens/x' } } });
    run(store, { status: 'completed', at: 7000, argv: [NO_COMMAND], meta: { covers: ['api'] } });
    expect(calibrationTarget(store)).toEqual({ run: expect.objectContaining({ runId: failed.runId }), source: 'newest' });
    expect(calibrationTarget(store, { setupRunId: setup.runId })).toEqual({ run: expect.objectContaining({ runId: setup.runId }), source: 'setup' });
    // A setup run that is gone, or can't be calibrated, falls back to the newest.
    expect(calibrationTarget(store, { setupRunId: 'GONE' })?.source).toBe('newest');
    store.close();
  });

  it('looks past a long run of recordings it cannot use', () => {
    const store = Store.open(':memory:');
    const good = run(store, { status: 'completed', at: 1 });
    for (let i = 0; i < 120; i++) run(store, { status: 'completed', at: 10 + i, meta: { imported: { at: 0, from: 'x' } } });
    expect(calibrationTarget(store)?.run.runId).toBe(good.runId);
    store.close();
  });
});

describe('toolUsage', () => {
  it('lists every tool across runs with its effects, calls, runs and latest call', () => {
    const store = Store.open(':memory:');
    const a = run(store, { status: 'completed', at: 1 });
    const b = run(store, { status: 'completed', at: 2 });
    tool(store, a.runId, 1, 'lookup_order', 'read', 100);
    tool(store, a.runId, 2, 'lookup_order', 'read', 110);
    tool(store, a.runId, 3, 'issue_refund', 'write', 120);
    tool(store, b.runId, 1, 'lookup_order', 'read', 200);
    tool(store, b.runId, 2, 'issue_refund', 'read', 210);
    store.appendCallStart({ runId: b.runId, callNo: 3, kind: 'api', name: 'POST /v1/messages', fingerprint: 'm', occurrence: 1, origin: 'live', effect: null, requestRef: null, meta: {}, at: 220 });
    expect(store.toolUsage()).toEqual([
      { name: 'issue_refund', effect: 'read', calls: 1, runs: 1, lastAt: 210 },
      { name: 'issue_refund', effect: 'write', calls: 1, runs: 1, lastAt: 120 },
      { name: 'lookup_order', effect: 'read', calls: 3, runs: 2, lastAt: 200 },
    ]);
    store.close();
  });
});

describe('runCounts', () => {
  it('tells runs from the attempts blame, verify and --repeat make, and counts runs still recording', () => {
    const store = Store.open(':memory:');
    expect(store.runCounts()).toEqual({ runs: 0, attempts: 0, recording: 0 });
    run(store, { status: 'completed', at: 1 });
    run(store, { status: 'running', at: 2 });
    run(store, { mode: 'replay', status: 'completed', at: 3, meta: { probe: { of: 'X', callNo: 3, passed: true } } });
    run(store, { mode: 'replay', status: 'failed', at: 4, meta: { verify: { role: 'target', passed: false } } });
    run(store, { mode: 'replay', status: 'completed', at: 5, meta: { repeat: { group: 'g', attempt: 1, of: 2 }, labels: ['x'] } });
    run(store, { mode: 'replay', status: 'completed', at: 6, meta: { labels: ['good'] } });
    expect(store.runCounts()).toEqual({ runs: 3, attempts: 3, recording: 1 });
    store.close();
  });
});

describe('unreferencedBlobs', () => {
  it('finds what deleting runs would free without deleting anything, as gcBlobs then does', () => {
    const store = Store.open(':memory:');
    const old = run(store, { status: 'completed', at: 1 });
    const kept = run(store, { status: 'completed', at: 2 });
    const shared = store.putJson({ args: { shared: true } });
    const only = store.putBlob(Buffer.from('x'.repeat(4000)));
    const manifest = storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: 'only in the old run' }] });
    tool(store, old.runId, 1, 't', 'read', 1, shared);
    tool(store, old.runId, 2, 't', 'read', 2, only);
    store.appendCallStart({ runId: old.runId, callNo: 3, kind: 'api', name: 'POST /v1/messages', fingerprint: 'm', occurrence: 1, origin: 'live', effect: null, requestRef: manifest, meta: {}, at: 3 });
    tool(store, kept.runId, 1, 't', 'read', 4, shared);
    const orphan = store.putJson({ nobody: 'references this' });

    expect(store.unreferencedBlobs().hashes).toEqual([orphan]);
    const plan = store.unreferencedBlobs([old.runId]);
    // The old run's own blob, its request manifest and the message under it, and the orphan.
    expect(plan.hashes.sort()).toEqual([only, manifest, orphan, expect.any(String)].sort());
    expect(plan.size).toBeGreaterThan(4000);
    expect(plan.bytes).toBeLessThan(plan.size); // the 4000-byte blob is stored compressed
    expect(store.getBlob(only)).not.toBeNull();

    store.deleteRun(old.runId);
    expect(store.gcBlobs()).toEqual({ removed: 4, bytes: plan.size });
    expect(store.getJson(shared)).toEqual({ args: { shared: true } });
    store.close();
  });
});
