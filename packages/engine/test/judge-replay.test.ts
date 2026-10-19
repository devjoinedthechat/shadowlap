import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { datasetRows, JUDGE_SCOPE, packRun, Session, sha256, Store, storeApiRequest, summarizeRun, unpackRun, type CallRecord, type DatasetExample } from '../src/index.js';
import { RunBuilder, text, user } from './run-fixtures.js';

/**
 * A judge's calls in a replay: answered from the recording when the request is the same, whatever
 * the agent did, and never the agent's divergence; and left out of what a run says the agent did.
 */

let no = 0;
function rec(name: string, fp: string, o: { scope?: string; outcome?: 'ok' | 'error'; kind?: CallRecord['kind'] } = {}): CallRecord {
  no++;
  return {
    runId: 'PARENT',
    callNo: no,
    kind: o.kind ?? 'api',
    name,
    fingerprint: fp,
    occurrence: 1,
    origin: 'live',
    effect: o.kind === 'tool' ? 'read' : null,
    requestRef: JSON.stringify({ fp }),
    meta: o.scope ? { scope: o.scope } : {},
    at: no,
    end: { runId: 'PARENT', callNo: no, attempt: 0, responseRef: 'r', outcome: o.outcome ?? 'ok', meta: {}, at: no },
    attempts: [],
  };
}
const loadRequest = (r: CallRecord) => JSON.parse(r.requestRef!);

/** The agent's two model calls and a tool call, then the judge's verdict. */
function judgedRecording(): CallRecord[] {
  no = 0;
  return [rec('POST /v1/messages', 'A1'), rec('lookup', 'T1', { kind: 'tool' }), rec('POST /v1/messages', 'A2'), rec('POST /v1/messages', 'J1', { scope: JUDGE_SCOPE })];
}

const api = (s: Session, callNo: number, fingerprint: string, scope?: string) => s.resolve({ callNo, kind: 'api', name: 'POST /v1/messages', fingerprint, request: { fp: fingerprint }, ...(scope ? { scope } : {}) });

describe('a judge call in a replay', () => {
  it('is answered from the recording when it asks the same, and the replay stays clean', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: judgedRecording(), loadRequest });
    expect(api(s, 1, 'A1').origin).toBe('replayed');
    expect(s.resolve({ callNo: 2, kind: 'tool', name: 'lookup', fingerprint: 'T1', effect: 'read' }).origin).toBe('replayed');
    expect(api(s, 3, 'A2').origin).toBe('replayed');
    expect(api(s, 4, 'J1', JUDGE_SCOPE)).toMatchObject({ origin: 'replayed', record: { callNo: 4 } });
    expect(s.end()).toBeNull();
    expect(s.divergence).toBeNull();
    expect(s.notReached()).toEqual([]);
    expect(s.replayed).toBe(3);
  });

  it('asks live when the material changed, without moving the replay', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: judgedRecording(), loadRequest });
    api(s, 1, 'A1');
    s.resolve({ callNo: 2, kind: 'tool', name: 'lookup', fingerprint: 'T1', effect: 'read' });
    api(s, 3, 'A2');
    expect(api(s, 4, 'J2', JUDGE_SCOPE)).toEqual({ origin: 'live', occurrence: 1 });
    // The recorded judge call it never asked again is no call the agent left out.
    expect(s.end()).toBeNull();
    expect(s.notReached()).toEqual([]);
  });

  it('is answered from the recording after the agent forked too, when it asks the very same', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: judgedRecording(), loadRequest });
    api(s, 1, 'A1');
    expect(api(s, 2, 'A9').origin).toBe('live');
    expect(s.state).toBe('diverged');
    expect(api(s, 3, 'J1', JUDGE_SCOPE).origin).toBe('replayed');
    expect(s.divergence).toMatchObject({ callNo: 2 });
  });

  it('never ends a replay early, and is never what an agent that stopped short left out', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: judgedRecording(), loadRequest });
    api(s, 1, 'A1');
    const d = s.end();
    expect(d).toMatchObject({ type: 'ended_early', callNo: 2, recorded: 3 });
    expect(s.notReached().map((c) => c.callNo)).toEqual([2, 3]);
  });

  it('asks again when the recorded one failed, and counts no flag on it', () => {
    no = 0;
    const calls = [rec('POST /v1/messages', 'A1'), rec('POST /v1/messages', 'J1', { scope: JUDGE_SCOPE, outcome: 'error' })];
    // A flag naming the second model call names none: the judge's is no model call of the agent's.
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest, replay: { failAt: new Map([[2, 500]]) } });
    api(s, 1, 'A1');
    expect(api(s, 2, 'J1', JUDGE_SCOPE).origin).toBe('live');
    expect(s.injectedFailure(2)).toBeUndefined();
    expect(s.unappliedFailures()).toEqual(['--fail-at 2=500 changed nothing: call #2 is not a model call of the recording']);
  });

  it('gives a recording no scopes of its own, so an agent that adds scopes later still replays', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: judgedRecording(), loadRequest });
    expect(api(s, 1, 'A1', 'orchestrator').origin).toBe('replayed');
  });
});

describe('what a run says the agent did', () => {
  it('leaves the judge out of its counts and cost, and sums the judge apart', () => {
    const store = Store.open(':memory:');
    const b = RunBuilder.start(store);
    b.model({ messages: [user('hi')] }, [text('Hello.')], { usage: { inputTokens: 1000, outputTokens: 100 }, model: 'claude-sonnet-5' });
    b.model({ messages: [user('Question: x')] }, [text('{"verdict":"yes","reason":"r"}')], { usage: { inputTokens: 400, outputTokens: 20 }, model: 'claude-haiku-4-5', scope: JUDGE_SCOPE });
    b.model({ messages: [user('Question: y')] }, [text('{"verdict":"no","reason":"r"}')], { usage: { inputTokens: 400, outputTokens: 20 }, model: 'claude-haiku-4-5', scope: JUDGE_SCOPE, origin: 'replayed' });
    const runId = b.end();
    const s = summarizeRun(store.getRun(runId)!, store.getCalls(runId));
    expect(s.total).toBe(1);
    expect(s.byKind.api).toBe(1);
    expect(s.upstreamRequests).toBe(1);
    expect(s.cost.spent).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 9);
    expect(s.judge).toEqual({ calls: 2, replayed: 1, live: 1, notAsked: 0, upstreamRequests: 1, spent: (400 * 1 + 20 * 5) / 1e6, saved: (400 * 1 + 20 * 5) / 1e6, unknownModels: [] });
    // A run with no judge calls has no judge part at all.
    const plain = RunBuilder.start(store);
    plain.model({ messages: [user('hi')] }, [text('Hello.')]);
    expect(summarizeRun(store.getRun(plain.end())!, store.getCalls(plain.runId))).not.toHaveProperty('judge');
    // Nor is a judge's verdict ever one of the agent's turns in a dataset.
    const rows = datasetRows(store, [store.getRun(runId)!], { calls: 'final', format: 'jsonl' }) as DatasetExample[];
    expect(rows.map((r) => [r.metadata.call_no, r.output.text])).toEqual([[1, 'Hello.']]);
    expect(datasetRows(store, [store.getRun(runId)!], { calls: 'model', format: 'jsonl' })).toHaveLength(1);
  });
});

/** A model call as the sidecar stores it, with a fingerprint a pack takes. */
function modelCall(store: Store, runId: string, callNo: number, body: unknown, reply: string, scope?: string): void {
  const identity = { kind: 'api' as const, name: 'POST /v1/messages', fingerprint: sha256(`${runId}:${callNo}`), occurrence: 1 };
  store.appendCallStart({ runId, callNo, ...identity, origin: 'live', effect: null, requestRef: storeApiRequest(store, body), meta: { provider: 'anthropic', ...(scope ? { scope } : {}) }, at: 1_760_000_000_000 + callNo });
  const bytes = Buffer.from(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: reply }], stop_reason: 'end_turn' }));
  store.appendCallEnd(identity, { runId, callNo, attempt: 0, responseRef: store.putBlob(bytes), outcome: 'ok', meta: { status: 200, headers: { 'content-type': 'application/json' }, provider: 'anthropic' }, at: 1_760_000_000_000 + callNo });
}

describe('a golden that gained judge verdicts under the same run id', () => {
  it('is the same recording as the store\'s copy without them, which takes them in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-judge-pack-'));
    try {
      const store = Store.open(':memory:');
      const run = store.createRun({ mode: 'record', parentRunId: null, command: { argv: ['node', 'agent.js'], cwd: '/work' }, codeVersion: null, startedAt: 1_760_000_000_000 });
      const runId = run.runId;
      modelCall(store, runId, 1, { messages: [user('hi')] }, 'Hello.');
      store.endRun(runId, 'completed', 1_760_000_000_100);
      // A teammate's store holds the golden as it was first packed: no judge calls.
      const theirs = Store.open(':memory:');
      packRun(store, runId, join(dir, 'first'));
      unpackRun(theirs, join(dir, 'first'));
      // The golden gains a verdict and is packed again under the same id.
      modelCall(store, runId, 2, { messages: [user('Question: x')] }, '{"verdict":"yes","reason":"r"}', JUDGE_SCOPE);
      packRun(store, runId, join(dir, 'judged'));
      const r = unpackRun(theirs, join(dir, 'judged'));
      expect(r.mismatched).toEqual([]);
      expect(theirs.getCalls(runId).map((c) => [c.callNo, c.meta.scope ?? null])).toEqual([
        [1, null],
        [2, JUDGE_SCOPE],
      ]);
      // Unpacked again, nothing comes in twice.
      unpackRun(theirs, join(dir, 'judged'));
      expect(theirs.getCalls(runId)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
