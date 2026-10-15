import { describe, expect, it } from 'vitest';
import { manifestRefs, Store, storeApiRequest } from '@shadowlap/engine';
import { pruneQuietly, pruneReplays } from '../src/golden-test.js';

/**
 * Pruning the replays of earlier `shadowlap test` sessions. Another process may be recording into the
 * same store while a session prunes: it writes each blob a moment before the call that references
 * it, so pruning deletes runs and never collects blobs, which waits for `shadowlap gc`.
 */
const agent = { argv: ['node', 'agent.mjs'], cwd: '/p' };

function liveReplay(store: Store, golden: string, session: string, answer: string, at: number): string {
  const run = store.createRun({ mode: 'replay', command: agent, startedAt: at, meta: { test: { golden, session } } });
  const id = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: `f-${run.runId}`, occurrence: 1 };
  store.appendCallStart({ runId: run.runId, callNo: 1, ...id, origin: 'live', effect: null, requestRef: storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: 'refund?' }] }), meta: {}, at: at + 1 });
  store.appendCallEnd(id, { runId: run.runId, callNo: 1, attempt: 1, responseRef: store.putBlob(Buffer.from(answer)), outcome: 'ok', meta: {}, at: at + 2 });
  store.endRun(run.runId, 'completed', at + 3);
  return run.runId;
}

describe('pruning older replays', () => {
  it('deletes an older clean replay of a golden that may fork, and leaves every blob for shadowlap gc', () => {
    const store = Store.open(':memory:');
    const first = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund'], startedAt: 1_000 });
    // A golden that may fork goes live from the fork: the replay holds an answer of its own.
    const older = liveReplay(store, 'goldens/refund', first.sessionId, 'an answer only this replay got', 1_100);
    const answer = store.getCalls(older)[0]!.end!.responseRef!;
    store.finishTestSession(first.sessionId, { passed: 1, failed: 0, upstreamRequests: 1, endedAt: 1_200 });

    // Meanwhile another process records into the same store: its request is in, its call not yet.
    store.createRun({ mode: 'record', command: { argv: ['node', 'other.mjs'], cwd: '/p' } });
    const inFlight = storeApiRequest(store, { model: 'm', messages: [{ role: 'user', content: 'being recorded right now' }] });

    const second = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund'], startedAt: 2_000 });
    const newer = liveReplay(store, 'goldens/refund', second.sessionId, 'a newer answer', 2_100);
    expect(pruneReplays(store, second, new Map([['goldens/refund', { ok: true, fork: true }]]))).toBe(1);
    expect(store.getRun(older)).toBeNull();
    expect(store.getRun(newer)).not.toBeNull();
    // Nothing a run being recorded needs is gone; the pruned replay's own answer waits for gc.
    for (const hash of [inFlight, ...manifestRefs(store, inFlight)]) expect(store.getBlob(hash), hash).not.toBeNull();
    expect(store.getBlob(answer)).not.toBeNull();
    store.close();
  });

  it('never fails the session: pruning that can\'t happen says why and waits for the next one', () => {
    const store = Store.open(':memory:');
    const session = store.startTestSession({ command: ['shadowlap', 'test', 'goldens/refund'] });
    store.close();
    expect(pruneQuietly(store, session, new Map([['goldens/refund', { ok: true, fork: false }]]))).toMatch(/^older replays were not pruned this time: /);
  });
});
