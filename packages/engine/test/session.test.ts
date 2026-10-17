import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import type { CallRecord, Effect } from '../src/types.js';

let no = 0;
function rec(kind: CallRecord['kind'], name: string, fp: string, occurrence = 1, effect: Effect | null = null, request: unknown = { name, fp }): CallRecord {
  no++;
  return {
    runId: 'PARENT',
    callNo: no,
    kind,
    name,
    fingerprint: fp,
    occurrence,
    origin: 'live',
    effect,
    requestRef: JSON.stringify(request),
    meta: {},
    at: no,
    end: { runId: 'PARENT', callNo: no, attempt: 0, responseRef: 'r', outcome: 'ok', meta: {}, at: no },
    attempts: [],
  };
}
const loadRequest = (r: CallRecord) => JSON.parse(r.requestRef!);

function parent(): CallRecord[] {
  no = 0;
  return [
    rec('api', 'POST /v1/messages', 'A1', 1, null, { system: 'Today is 2026-09-15', messages: [1] }),
    rec('tool', 'search_web', 'S1', 1, 'read'),
    rec('tool', 'read_file', 'F1', 1, 'pure'),
    rec('api', 'POST /v1/messages', 'A2', 1, null, { system: 'Today is 2026-09-15', messages: [1, 2, 3] }),
    rec('tool', 'read_file', 'F1', 2, 'pure'),
    rec('tool', 'send_email', 'E1', 1, 'write'),
    rec('api', 'POST /v1/messages', 'A3', 1, null, { system: 'Today is 2026-09-15', messages: [1, 2, 3, 4, 5] }),
  ];
}

describe('Session in record mode', () => {
  it('is always live and still counts occurrences', () => {
    const s = new Session({ mode: 'record' });
    expect(s.resolve({ callNo: 1, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' })).toEqual({ origin: 'live', occurrence: 1 });
    expect(s.resolve({ callNo: 2, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' })).toEqual({ origin: 'live', occurrence: 2 });
    expect(s.divergence).toBeNull();
  });
});

describe('Session in replay mode', () => {
  it('replays an identical sequence in any interleaving and reports nothing unreached', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest });
    // Different arrival order than the recording (parallel tools resolved differently).
    const order: Array<[CallRecord['kind'], string, string, Effect | null]> = [
      ['api', 'POST /v1/messages', 'A1', null],
      ['tool', 'read_file', 'F1', 'pure'],
      ['tool', 'search_web', 'S1', 'read'],
      ['api', 'POST /v1/messages', 'A2', null],
      ['tool', 'send_email', 'E1', 'write'],
      ['tool', 'read_file', 'F1', 'pure'],
      ['api', 'POST /v1/messages', 'A3', null],
    ];
    order.forEach(([kind, name, fp, effect], i) => {
      const d = s.resolve({ callNo: i + 1, kind, name, fingerprint: fp, effect });
      expect(d.origin).toBe('replayed');
    });
    expect(s.state).toBe('replaying');
    expect(s.divergence).toBeNull();
    expect(s.notReached()).toEqual([]);
    expect(s.replayed).toBe(7);
  });

  it('matches repeated identical calls by occurrence', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest });
    const a = s.resolve({ callNo: 1, kind: 'tool', name: 'read_file', fingerprint: 'F1', effect: 'pure' });
    const b = s.resolve({ callNo: 2, kind: 'tool', name: 'read_file', fingerprint: 'F1', effect: 'pure' });
    expect(a.origin === 'replayed' && a.record.callNo).toBe(3);
    expect(b.origin === 'replayed' && b.record.callNo).toBe(5);
    const c = s.resolve({ callNo: 3, kind: 'tool', name: 'read_file', fingerprint: 'F1', effect: 'pure' });
    expect(c.origin).toBe('live');
    expect(s.divergence?.type).toBe('new_call');
  });

  it('explains a changed request with a diff, the closest counterpart and a hint', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest });
    const d = s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1-changed', request: { system: 'Today is 2026-09-16', messages: [1] } });
    expect(d.origin).toBe('live');
    const div = s.divergence!;
    expect(div.type).toBe('request_changed');
    expect(div.counterpart).toEqual({ runId: 'PARENT', callNo: 1 }); // messages:[1] is closer than [1,2,3]
    expect(div.diff).toEqual([{ path: '$.system', op: 'changed', before: 'Today is 2026-09-15', after: 'Today is 2026-09-16' }]);
    expect(div.hints?.[0]?.normalizer).toEqual({ kind: 'api', path: '$.system', pattern: 'iso-date', replace: '<DATE>' });
    expect(div.replayedBefore).toBe(0);
  });

  it('after divergence: api and read live, pure replayed when identical, writes per policy', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { writes: 'block' } });
    expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} }).origin).toBe('replayed');
    expect(s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A2-new', request: {} }).origin).toBe('live');
    expect(s.state).toBe('diverged');
    expect(s.resolve({ callNo: 3, kind: 'tool', name: 'search_web', fingerprint: 'S1', effect: 'read' }).origin).toBe('live');
    expect(s.resolve({ callNo: 4, kind: 'tool', name: 'read_file', fingerprint: 'F1', effect: 'pure' }).origin).toBe('replayed');
    expect(s.resolve({ callNo: 5, kind: 'tool', name: 'read_file', fingerprint: 'F-new', effect: 'pure' }).origin).toBe('live');
    expect(s.resolve({ callNo: 6, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' }).origin).toBe('blocked');
    expect(s.resolve({ callNo: 7, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A3', request: {} }).origin).toBe('live');
    expect(s.notReached().map((n) => n.callNo)).toEqual([2, 4, 5, 6, 7]);
  });

  it('honours reads=replay, writes=stub and writes=allow', () => {
    const mk = (replay: ConstructorParameters<typeof Session>[0]['replay']) => {
      const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, ...(replay ? { replay } : {}) });
      s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'DIFFERENT', request: {} });
      return s;
    };
    expect(mk({ reads: 'replay' }).resolve({ callNo: 2, kind: 'tool', name: 'search_web', fingerprint: 'S1', effect: 'read' }).origin).toBe('replayed');
    expect(mk({ writes: 'stub' }).resolve({ callNo: 2, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' }).origin).toBe('stubbed');
    expect(mk({ writes: 'allow' }).resolve({ callNo: 2, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' }).origin).toBe('live');
  });

  it('answers a write the recording made with what it got then, when asked, and fences every other', () => {
    for (const writes of ['stub', 'block'] as const) {
      const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { writes, recordedWrites: true, divergeAt: 1 } });
      expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} }).origin).toBe('live');
      // The same tool with the same arguments, the first time: the recorded call #6, whatever its outcome was.
      const same = s.resolve({ callNo: 2, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' });
      expect(same).toMatchObject({ origin: 'replayed', record: { callNo: 6 } });
      // Other arguments, or the same call a second time, are no call the recording made.
      expect(s.resolve({ callNo: 3, kind: 'tool', name: 'send_email', fingerprint: 'E2', effect: 'write' }).origin).toBe(writes === 'stub' ? 'stubbed' : 'blocked');
      expect(s.resolve({ callNo: 4, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' }).origin).toBe(writes === 'stub' ? 'stubbed' : 'blocked');
    }
    // Not asked, a write is fenced even when the recording made it.
    const fenced = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { writes: 'stub', divergeAt: 1 } });
    fenced.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} });
    expect(fenced.resolve({ callNo: 2, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' }).origin).toBe('stubbed');
    // A recording that is itself a fork holds writes no one answered: a stub, a block or an injected failure.
    for (const fence of [{ origin: 'stubbed' }, { origin: 'blocked' }, { origin: 'live', injected: true }] as const) {
      const calls = parent().map((c) => (c.callNo === 6 ? { ...c, origin: fence.origin, end: { ...c.end!, meta: 'injected' in fence ? { injected: true } : {} } } : c));
      const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest, replay: { writes: 'stub', recordedWrites: true, divergeAt: 1 } });
      s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} });
      expect(s.resolve({ callNo: 2, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' }).origin).toBe('stubbed');
    }
    // A write --live-tool names is one whose code changed: what it got then is no answer for it.
    const fixed = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { writes: 'stub', recordedWrites: true, divergeAt: 1, liveTools: new Set(['send_email']) } });
    fixed.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} });
    expect(fixed.resolve({ callNo: 2, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' }).origin).toBe('stubbed');
  });

  it('forces the first call of a --live-tool live and marks the divergence as forced', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { liveTools: new Set(['search_web']) } });
    expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} }).origin).toBe('replayed');
    expect(s.resolve({ callNo: 2, kind: 'tool', name: 'search_web', fingerprint: 'S1', effect: 'read' }).origin).toBe('live');
    expect(s.divergence).toMatchObject({ type: 'forced', callNo: 2, replayedBefore: 1, reason: 'forced live by --live-tool search_web', counterpart: { runId: 'PARENT', callNo: 2 } });
  });

  it('forces --diverge-at', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { divergeAt: 1 } });
    expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} }).origin).toBe('live');
    expect(s.divergence).toMatchObject({ type: 'forced', reason: 'forced live by --diverge-at 1', counterpart: { runId: 'PARENT', callNo: 1 } });
  });

  it('reports beyond_recording once everything recorded is consumed', () => {
    const calls = parent().slice(0, 1);
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} });
    s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A2', request: {} });
    expect(s.divergence?.type).toBe('beyond_recording');
  });

  it('reuses an occurrence for a retry attempt', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest });
    const first = s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} });
    expect(first.occurrence).toBe(1);
    // A retry of the same call must not consume occurrence 2.
    expect(s.nextOccurrence('api', 'A1')).toBe(2);
  });

  it('ignores incomplete recorded calls (a crash mid-call)', () => {
    const calls = parent();
    calls[0]!.end = null;
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: { system: 'Today is 2026-09-15', messages: [1] } }).origin).toBe('live');
    // The incomplete call is never a counterpart; the closest complete API call is.
    expect(s.divergence?.type).toBe('request_changed');
    expect(s.divergence?.counterpart?.callNo).toBe(4);
  });
});

describe('scopes', () => {
  const scoped = (callNo: number, scope: string | undefined, occurrence: number): CallRecord => ({ ...rec('api', 'POST /v1/messages', 'PLAN', occurrence), callNo, meta: scope ? { scope } : {} });

  it('gives each branch its own recorded answer to an identical request, whatever order they arrive in', () => {
    // Recorded: alpha asked first (call 1), then beta (call 2); each is occurrence 1 of its scope.
    const calls = [scoped(1, 'alpha', 1), scoped(2, 'beta', 1)];
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    const beta = s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'PLAN', scope: 'beta' });
    const alpha = s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'PLAN', scope: 'alpha' });
    expect([beta.origin, alpha.origin]).toEqual(['replayed', 'replayed']);
    expect([(beta as { record: CallRecord }).record.callNo, (alpha as { record: CallRecord }).record.callNo]).toEqual([2, 1]);
  });

  it('are ignored for a recording made without them, so adding scope() later still replays', () => {
    const calls = [scoped(1, undefined, 1), scoped(2, undefined, 2)];
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'PLAN', scope: 'beta' }).origin).toBe('replayed');
    expect(s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'PLAN', scope: 'alpha' }).origin).toBe('replayed');
  });

  it('count repeats per scope while recording', () => {
    const s = new Session({ mode: 'record' });
    expect([
      s.resolve({ callNo: 1, kind: 'api', name: 'x', fingerprint: 'F', scope: 'a' }).occurrence,
      s.resolve({ callNo: 2, kind: 'api', name: 'x', fingerprint: 'F', scope: 'b' }).occurrence,
      s.resolve({ callNo: 3, kind: 'api', name: 'x', fingerprint: 'F', scope: 'a' }).occurrence,
      s.resolve({ callNo: 4, kind: 'api', name: 'x', fingerprint: 'F' }).occurrence,
    ]).toEqual([1, 1, 2, 1]);
  });
});
