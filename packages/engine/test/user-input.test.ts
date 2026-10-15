import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import type { CallRecord } from '../src/types.js';

/**
 * A person's input is recorded as a `user_input` read with `meta.input`. Before a fork it replays
 * like any call. After one there is no one to type, so the recorded answers are served in the order
 * they were given, whatever the prompt says now, unless the replay asks for them live.
 */

let no = 0;
function rec(kind: CallRecord['kind'], name: string, fp: string, input = false, occurrence = 1): CallRecord {
  no++;
  return {
    runId: 'CHAT',
    callNo: no,
    kind,
    name,
    fingerprint: fp,
    occurrence,
    origin: 'live',
    effect: kind === 'tool' ? 'read' : null,
    requestRef: JSON.stringify({ fp }),
    meta: input ? { input: true } : {},
    at: no,
    end: { runId: 'CHAT', callNo: no, attempt: 0, responseRef: `answer-${no}`, outcome: 'ok', meta: {}, at: no },
    attempts: [],
  };
}

/** The chat sample's shape: an answer, a model call, an answer, a model call, an answer, a model call. */
function chat(): CallRecord[] {
  no = 0;
  return [rec('tool', 'user_input', 'how-can-i-help', true), rec('api', 'POST /v1/messages', 'A1'), rec('tool', 'user_input', 'prompt', true), rec('api', 'POST /v1/messages', 'A2'), rec('tool', 'user_input', 'prompt', true, 2), rec('api', 'POST /v1/messages', 'A3')];
}

const replay = (opts: { liveInput?: boolean; overrides?: Map<number, unknown>; divergeAt?: number } = {}) =>
  new Session({ mode: 'replay', parentRunId: 'CHAT', parentCalls: chat(), replay: opts, loadRequest: (r) => JSON.parse(r.requestRef!) });
const ask = (s: Session, callNo: number, fingerprint: string) => s.resolve({ callNo, kind: 'tool', name: 'user_input', fingerprint, effect: 'read', input: true });
const servedFrom = (d: ReturnType<Session['resolve']>) => (d.origin === 'replayed' || d.origin === 'overridden' ? d.record.callNo : d.origin);

describe('recorded user input', () => {
  it('replays like any call before the fork', () => {
    const s = replay();
    expect(servedFrom(ask(s, 1, 'how-can-i-help'))).toBe(1);
    expect(s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1' }).origin).toBe('replayed');
    expect(servedFrom(ask(s, 3, 'prompt'))).toBe(3);
    expect(s.divergence).toBeNull();
  });

  it('after the fork serves the recorded answers in order, whatever the prompt says now', () => {
    const s = replay();
    ask(s, 1, 'how-can-i-help');
    // The model answers differently: the run forks, and the agent asks with a new prompt.
    expect(s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1-changed' }).origin).toBe('live');
    expect(s.divergence?.callNo).toBe(2);
    expect(servedFrom(ask(s, 3, 'a different prompt'))).toBe(3);
    expect(servedFrom(ask(s, 4, 'yet another'))).toBe(5);
    // When the recorded answers run out, the input is asked for live (and ends at once with no one there).
    expect(ask(s, 5, 'one more').origin).toBe('live');
  });

  it('a changed prompt forks the run where it is asked, and the person still answers as recorded', () => {
    const s = replay();
    const first = ask(s, 1, 'how-may-i-help');
    expect(s.divergence).toMatchObject({ callNo: 1, kind: 'tool', name: 'user_input' });
    expect(servedFrom(first)).toBe(1);
  });

  it('answers differently where the replay overrides the recorded answer, then goes on in order', () => {
    const s = replay({ overrides: new Map([[3, { text: 'A refund, please.' }]]) });
    ask(s, 1, 'how-can-i-help');
    s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1' });
    const answered = ask(s, 3, 'prompt');
    expect(answered).toMatchObject({ origin: 'overridden', result: { text: 'A refund, please.' } });
    // The model sees the new answer, so the run forks there; the next answer is the recording's next.
    s.resolve({ callNo: 4, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A2-after-refund' });
    expect(servedFrom(ask(s, 5, 'prompt'))).toBe(5);
  });

  it('serves the answer of an input it is told to diverge at, then runs on live', () => {
    const s = replay({ divergeAt: 3 });
    ask(s, 1, 'how-can-i-help');
    s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1' });
    expect(servedFrom(ask(s, 3, 'prompt'))).toBe(3);
    expect(s.divergence).toMatchObject({ callNo: 3, type: 'forced' });
    expect(s.resolve({ callNo: 4, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A2' }).origin).toBe('live');
  });

  it('asks for input live after the fork with --live-input', () => {
    const s = replay({ liveInput: true });
    ask(s, 1, 'how-can-i-help');
    s.resolve({ callNo: 2, kind: 'api', name: 'POST /v1/messages', fingerprint: 'A1-changed' });
    expect(ask(s, 3, 'prompt').origin).toBe('live');
  });

  it('leaves a tool that merely reads alone: only calls marked as input are served in order', () => {
    const s = replay();
    s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/messages', fingerprint: 'other' });
    expect(s.resolve({ callNo: 2, kind: 'tool', name: 'user_input', fingerprint: 'prompt', effect: 'read' }).origin).toBe('live');
  });
});
