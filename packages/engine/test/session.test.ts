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
    // A third call of a pure tool has no counterpart: answered live, and the replay goes on.
    const c = s.resolve({ callNo: 3, kind: 'tool', name: 'read_file', fingerprint: 'F1', effect: 'pure' });
    expect(c).toEqual({ origin: 'live', occurrence: 3, extra: true });
    expect(s.divergence).toBeNull();
    // A second call of a read tool has none either, and forks: what it returns may have changed.
    expect(s.resolve({ callNo: 4, kind: 'tool', name: 'search_web', fingerprint: 'S1', effect: 'read' }).origin).toBe('replayed');
    expect(s.resolve({ callNo: 5, kind: 'tool', name: 'search_web', fingerprint: 'S1', effect: 'read' }).origin).toBe('live');
    expect(s.divergence).toMatchObject({ type: 'new_call', callNo: 5, extraReads: [{ callNo: 3, kind: 'tool', name: 'read_file' }] });
  });

  it('answers extra clock, random and pure reads live and goes on replaying, the rest of the run replayed', () => {
    no = 0;
    const calls = [rec('clock', 'now', 'C1'), rec('api', 'POST /v1/messages', 'A1'), rec('tool', 'send_email', 'E1', 1, 'write'), rec('api', 'POST /v1/messages', 'A2')];
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    expect(s.resolve({ callNo: 1, kind: 'clock', name: 'now', fingerprint: 'C1' }).origin).toBe('replayed');
    // The agent now logs a timestamp, a request id and a formatted date nobody recorded.
    expect(s.resolve({ callNo: 2, kind: 'clock', name: 'now', fingerprint: 'C1' })).toEqual({ origin: 'live', occurrence: 2, extra: true });
    expect(s.resolve({ callNo: 3, kind: 'random', name: 'uuid', fingerprint: 'U1' })).toEqual({ origin: 'live', occurrence: 1, extra: true });
    expect(s.resolve({ callNo: 4, kind: 'tool', name: 'format_date', fingerprint: 'D1', effect: 'pure' })).toEqual({ origin: 'live', occurrence: 1, extra: true });
    expect(s.state).toBe('replaying');
    // Everything after it still comes from the recording, the write too.
    expect(s.resolve({ callNo: 5, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} }).origin).toBe('replayed');
    expect(s.resolve({ callNo: 6, kind: 'tool', name: 'send_email', fingerprint: 'E1', effect: 'write' }).origin).toBe('replayed');
    expect(s.resolve({ callNo: 7, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A2', request: {} }).origin).toBe('replayed');
    expect(s.end()).toBeNull();
    expect(s.divergence).toBeNull();
    expect(s.extraReads()).toEqual([
      { callNo: 2, kind: 'clock', name: 'now' },
      { callNo: 3, kind: 'random', name: 'uuid' },
      { callNo: 4, kind: 'tool', name: 'format_date' },
    ]);
    expect(s.replayed).toBe(4);
  });

  it("never serves a read of one name from another's, whatever fingerprint its caller gives both", () => {
    no = 0;
    // As fingerprints made without the read's name hold them (a caller's own, an earlier version's): one for both.
    const calls = [rec('random', 'uuid', 'R1'), rec('api', 'POST /v1/messages', 'A1')];
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    // The agent now draws a number where it made a uuid: a live read, never the recording's uuid.
    expect(s.resolve({ callNo: 1, kind: 'random', name: 'random', fingerprint: 'R1' })).toEqual({ origin: 'live', occurrence: 1, extra: true });
    // And the run goes on replaying.
    expect(s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} }).origin).toBe('replayed');
    expect(s.divergence).toBeNull();
  });

  it('forks on an extra write, and on a plain read a flag forces or changed', () => {
    no = 0;
    const calls = [rec('clock', 'now', 'C1'), rec('api', 'POST /v1/messages', 'A1')];
    const write = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    expect(write.resolve({ callNo: 1, kind: 'tool', name: 'send_email', fingerprint: 'E9', effect: 'write' }).origin).toBe('blocked');
    expect(write.divergence).toMatchObject({ type: 'new_call', callNo: 1 });

    const forced = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest, replay: { divergeAt: 1 } });
    expect(forced.resolve({ callNo: 1, kind: 'clock', name: 'now', fingerprint: 'C1' }).origin).toBe('live');
    expect(forced.divergence).toMatchObject({ type: 'forced', callNo: 1 });

    const changed = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    expect(changed.resolve({ callNo: 1, kind: 'tool', name: 'format_date', fingerprint: 'D1', effect: 'pure', changedBy: '--inject-result' }).origin).toBe('live');
    expect(changed.state).toBe('diverged');
  });

  it('names the extra reads answered before a divergence, whose values may be what changed its request', () => {
    no = 0;
    const calls = [rec('api', 'POST /v1/messages', 'A1', 1, null, { system: 'Run 7f3a', messages: [] })];
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    s.resolve({ callNo: 1, kind: 'random', name: 'uuid', fingerprint: 'U1' });
    s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1-changed', request: { system: 'Run 9c21', messages: [] } });
    expect(s.divergence).toMatchObject({ type: 'request_changed', callNo: 2, replayedBefore: 0, extraReads: [{ callNo: 1, kind: 'random', name: 'uuid' }] });
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

  it('runs a --live-tool tool live after a fork that came before its first call, and every later call of it', () => {
    // The tool's code changed along with the prompt, so the run forks at call 1, before the tool is reached.
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { liveTools: new Set(['read_file']), reads: 'replay' } });
    expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1-changed', request: {} }).origin).toBe('live');
    expect(s.resolve({ callNo: 2, kind: 'tool', name: 'read_file', fingerprint: 'F1', effect: 'pure' }).origin).toBe('live');
    expect(s.resolve({ callNo: 3, kind: 'tool', name: 'read_file', fingerprint: 'F1', effect: 'pure' }).origin).toBe('live');
    // A pure tool it doesn't name, and a read under --reads replay, still come from the recording.
    expect(s.resolve({ callNo: 4, kind: 'tool', name: 'search_web', fingerprint: 'S1', effect: 'read' }).origin).toBe('replayed');
  });

  it('runs a tool call --diverge-at names live after an earlier fork, rather than serving it from the recording', () => {
    for (const [name, fp, effect, origin] of [
      ['read_file', 'F1', 'pure', 'live'],
      ['send_email', 'E1', 'write', 'stubbed'],
    ] as const) {
      const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { writes: 'stub', recordedWrites: true, divergeAt: 2 } });
      expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1-changed', request: {} }).origin).toBe('live');
      expect(s.resolve({ callNo: 2, kind: 'tool', name, fingerprint: fp, effect }).origin, name).toBe(origin);
    }
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

  it('ends a replay that stopped before its recording did at the first recorded call it never made', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { overrides: new Map([[6, { ok: true }]]) } });
    s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} });
    s.resolve({ callNo: 2, kind: 'tool', name: 'search_web', fingerprint: 'S1', effect: 'read' });
    // Every request matched: nothing diverged while it ran.
    expect(s.divergence).toBeNull();
    const d = s.end();
    // #3 is a pure read, which a replay may leave unmade as it may make one more: the first call it misses is #4.
    expect(d).toEqual({ type: 'ended_early', callNo: 4, kind: 'api', name: 'POST /v1/messages', replayedBefore: 2, recorded: 7, reason: 'the agent stopped after 2 of the 7 recorded calls, before making #4', counterpart: { runId: 'PARENT', callNo: 4 } });
    expect(s.divergence).toBe(d);
    expect(s.end()).toBeNull();
    // An intervention it never got to says so, not that the replay forked before it.
    expect(s.unapplied()).toEqual(['--override 6 changed nothing: #6 send_email was not served, because the run never made that call']);
  });

  it('ends with no divergence when only clock, random and pure reads are left, after a fork, and on a recording', () => {
    no = 0;
    const calls = [rec('api', 'POST /v1/messages', 'A1'), rec('clock', 'Date.now', 'C1'), rec('random', 'Math.random', 'R1'), rec('tool', 'format_date', 'D1', 1, 'pure')];
    const clean = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    clean.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} });
    expect(clean.end()).toBeNull();
    expect(clean.divergence).toBeNull();

    const forked = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: parent(), loadRequest, replay: { divergeAt: 1 } });
    forked.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: {} });
    expect(forked.end()).toBeNull();
    expect(forked.divergence?.type).toBe('forced');

    expect(new Session({ mode: 'record' }).end()).toBeNull();
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
    calls[0].end = null;
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1', request: { system: 'Today is 2026-09-15', messages: [1] } }).origin).toBe('live');
    // The incomplete call is never a counterpart; the closest complete API call is.
    expect(s.divergence?.type).toBe('request_changed');
    expect(s.divergence?.counterpart?.callNo).toBe(4);
  });
});

describe('explaining a divergence', () => {
  /** A recording of `n` model calls of one name, each request its call number, with a loader that counts what it loads. */
  function long(n: number) {
    no = 0;
    const calls = Array.from({ length: n }, (_, i) => rec('api', 'POST /v1/messages', `A${i + 1}`, 1, null, { messages: Array.from({ length: i + 1 }, (_, j) => j) }));
    const loaded: number[] = [];
    return { calls, loaded, loadRequest: (r: CallRecord) => (loaded.push(r.callNo), JSON.parse(r.requestRef!)) };
  }

  it('compares a changed request with a few recorded calls near its place, the earliest always among them', () => {
    const { calls, loaded, loadRequest } = long(1000);
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest });
    for (let i = 1; i <= 499; i++) expect(s.resolve({ callNo: i, kind: 'api', name: 'POST /v1/messages', fingerprint: `A${i}`, request: {} }).origin).toBe('replayed');
    const changed = Array.from({ length: 500 }, (_, j) => j);
    changed[499] = -1;
    s.resolve({ callNo: 500, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A500-changed', request: { messages: changed } });
    expect(loaded.length).toBeLessThanOrEqual(8);
    expect(loaded).toContain(500);
    expect(s.divergence).toMatchObject({ type: 'request_changed', counterpart: { callNo: 500 }, diff: [{ path: '$.messages[499]', op: 'changed', before: 499, after: -1 }] });
  });

  it('prefers recorded calls of its own scope, then the nearest, and keeps the earliest unconsumed one in view', () => {
    no = 0;
    const calls = [
      ...Array.from({ length: 20 }, (_, i) => ({ ...rec('api', 'POST /v1/messages', `B${i}`, 1, null, { branch: 'b', i }), meta: { scope: 'b' } })),
      ...Array.from({ length: 20 }, (_, i) => ({ ...rec('api', 'POST /v1/messages', `A${i}`, 1, null, { branch: 'a', i }), meta: { scope: 'a' } })),
    ];
    const loaded: number[] = [];
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest: (r) => (loaded.push(r.callNo), JSON.parse(r.requestRef!)) });
    // Call 40 of the replay, in scope a, whose recorded calls are #21 to #40.
    s.resolve({ callNo: 40, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A-new', request: { branch: 'a', i: 19, extra: true }, scope: 'a' });
    expect(loaded.every((n) => n >= 21)).toBe(true);
    expect(loaded).toContain(21);
    expect(loaded).toContain(40);
    expect(s.divergence?.counterpart?.callNo).toBe(40);
  });

  it('can be left for after the call is answered: no recorded request is loaded until explainPending', () => {
    const { calls, loaded, loadRequest } = long(1000);
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: calls, loadRequest, deferExplain: true });
    s.resolve({ callNo: 1, kind: 'random', name: 'uuid', fingerprint: 'U1' });
    expect(s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1-changed', request: { messages: [7] } }).origin).toBe('live');
    // At once: the divergence, compared with the nearest recorded call, and nothing loaded.
    expect(loaded).toEqual([]);
    expect(s.explaining).toBe(true);
    expect(s.divergence).toEqual({ type: 'request_changed', callNo: 2, kind: 'api', name: 'POST /v1/messages', replayedBefore: 0, counterpart: { runId: 'PARENT', callNo: 2 }, extraReads: [{ callNo: 1, kind: 'random', name: 'uuid' }] });
    // Later: its diff, against the closest of a few.
    const d = s.explainPending();
    expect(loaded.length).toBeLessThanOrEqual(8);
    expect(d).toMatchObject({ type: 'request_changed', counterpart: { callNo: 1 }, diff: [{ path: '$.messages[0]', op: 'changed', before: 0, after: 7 }], extraReads: [{ callNo: 1, kind: 'random', name: 'uuid' }] });
    expect(s.divergence).toBe(d);
    expect(s.explaining).toBe(false);
    expect(s.explainPending()).toBeNull();
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

describe('a divergence report on a Gemini conversation', () => {
  const NAME = 'POST /v1beta/models/gemini-2.5-flash:generateContent';
  /** A user turn, then two function calls and their results, each paired by the id a client made up. */
  const turns = (text: string, calls: [string, string], answers: [string, string] = calls) => ({
    contents: [
      { role: 'user', parts: [{ text }] },
      { role: 'model', parts: [{ functionCall: { id: calls[0], name: 'weather', args: { city: 'Oslo' } } }, { functionCall: { id: calls[1], name: 'weather', args: { city: 'Bergen' } } }] },
      { role: 'user', parts: [{ functionResponse: { id: answers[0], name: 'weather', response: { c: 18 } } }, { functionResponse: { id: answers[1], name: 'weather', response: { c: 14 } } }] },
    ],
  });
  const recorded = () => {
    no = 0;
    return [rec('api', NAME, 'G1', 1, null, turns('weather in Oslo and Bergen', ['PfyxZOhr4ro30QGk', 'q7Lx0aZr2bYc9WdE']))];
  };

  it('names the change matching counted, never the call ids the client made up afresh', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: recorded(), loadRequest });
    s.resolve({ callNo: 1, kind: 'api', name: NAME, fingerprint: 'G2', request: turns('weather in Oslo and Tromsø', ['Rb4nQypSnBKnJXzi', 'Hk2mVt8sP0aQx1Ze']) });
    expect(s.divergence?.diff?.map((e) => e.path)).toEqual(['$.contents[0].parts[0].text']);
  });

  it('still shows which result answers which call, numbered as matching numbers them', () => {
    const s = new Session({ mode: 'replay', parentRunId: 'PARENT', parentCalls: recorded(), loadRequest });
    s.resolve({ callNo: 1, kind: 'api', name: NAME, fingerprint: 'G2', request: turns('weather in Oslo and Bergen', ['Rb4nQypSnBKnJXzi', 'Hk2mVt8sP0aQx1Ze'], ['Hk2mVt8sP0aQx1Ze', 'Rb4nQypSnBKnJXzi']) });
    expect(s.divergence?.diff).toEqual([
      { path: '$.contents[2].parts[0].functionResponse.id', op: 'changed', before: '<call-1>', after: '<call-2>' },
      { path: '$.contents[2].parts[1].functionResponse.id', op: 'changed', before: '<call-2>', after: '<call-1>' },
    ]);
  });
});
