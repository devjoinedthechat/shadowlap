import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import type { CallRecord, Coverage, Effect } from '../src/types.js';

/**
 * A partial recording says what it holds (`meta.covers`), and a replay runs everything else live
 * without calling it a divergence. A trace that kept some tools' outputs and not others covers
 * those tools by name (`tool:<name>`), so their calls replay while the rest run live.
 */

let no = 0;
function rec(kind: CallRecord['kind'], name: string, fp: string, effect: Effect | null = null): CallRecord {
  no++;
  return {
    runId: 'TRACE',
    callNo: no,
    kind,
    name,
    fingerprint: fp,
    occurrence: 1,
    origin: 'live',
    effect,
    requestRef: JSON.stringify({ name, fp }),
    meta: {},
    at: no,
    end: { runId: 'TRACE', callNo: no, attempt: 0, responseRef: 'r', outcome: 'ok', meta: {}, at: no },
    attempts: [],
  };
}

function trace(): CallRecord[] {
  no = 0;
  return [rec('api', 'POST /v1/chat/completions', 'A1'), rec('tool', 'lookup_order', 'L1', null), rec('api', 'POST /v1/chat/completions', 'A2')];
}

const session = (kinds: Coverage[]) => new Session({ mode: 'replay', parentRunId: 'TRACE', parentCalls: trace(), replay: { kinds: new Set(kinds) }, loadRequest: (r) => JSON.parse(r.requestRef!) });

describe('a partial recording that covers some tools by name', () => {
  it('replays the covered tool, runs every other tool live, and does not fork for them', () => {
    const s = session(['api', 'tool:lookup_order']);
    expect(s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/chat/completions', fingerprint: 'A1' }).origin).toBe('replayed');
    // A tool the trace never kept runs live (a read) or stays fenced (a write), and the replay goes on.
    expect(s.resolve({ callNo: 2, kind: 'tool', name: 'check_stock', fingerprint: 'C1', effect: 'read' }).origin).toBe('live');
    expect(s.resolve({ callNo: 3, kind: 'tool', name: 'create_replacement', fingerprint: 'R1', effect: 'write' }).origin).toBe('blocked');
    expect(s.resolve({ callNo: 4, kind: 'tool', name: 'lookup_order', fingerprint: 'L1', effect: 'read' }).origin).toBe('replayed');
    expect(s.resolve({ callNo: 5, kind: 'api', name: 'POST /v1/chat/completions', fingerprint: 'A2' }).origin).toBe('replayed');
    expect(s.divergence).toBeNull();
    expect(s.notReached()).toEqual([]);
  });

  it('forks at a covered tool whose arguments differ from the trace, as for any recorded call', () => {
    const s = session(['api', 'tool:lookup_order']);
    s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/chat/completions', fingerprint: 'A1' });
    expect(s.resolve({ callNo: 2, kind: 'tool', name: 'lookup_order', fingerprint: 'L-other', effect: 'read' }).origin).toBe('live');
    expect(s.divergence).toMatchObject({ callNo: 2, kind: 'tool', name: 'lookup_order' });
  });

  it('runs every tool live when it covers model calls only, as a capture does', () => {
    const s = session(['api']);
    s.resolve({ callNo: 1, kind: 'api', name: 'POST /v1/chat/completions', fingerprint: 'A1' });
    expect(s.resolve({ callNo: 2, kind: 'tool', name: 'lookup_order', fingerprint: 'L1', effect: 'read' }).origin).toBe('live');
    expect(s.divergence).toBeNull();
  });
});
